// App context — shared state, services, and utilities for route handlers.
// Extracted from server.js monolith. All mutable state lives here and is
// exposed to route modules via the ctx object returned by createAppContext().

import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import axios from 'axios';
import { AgentHarness } from './harness.js';
import ChatStore from './chat-store.js';
import AgentOrchestrator from './orchestrator.js';
import { migrateLegacyDataForAccount } from './data-migration.js';
import { createCryptoService } from '../crypto-service.js';
import { loadCryptoConfig } from '../crypto-config.js';
import {
  loadConfig, getConfig, saveConfig,
  getActiveAccount, getAccountById,
  getActiveAgent, getAgentById, getResolvedAgentForSandbox,
  getStrategyById,
  getPermissionsForSandbox,
  getPlugin, getPluginForSandbox,
  getActiveSandbox, getSandbox, getHeartbeatForSandboxPhase, getSandboxes,
} from './config-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = process.env.AGENT_PORT || 3737;
const TRADING_BOT_PORT = process.env.TRADING_BOT_PORT || '4534';
const TRADING_BOT_URL = process.env.TRADING_BOT_URL || `http://localhost:${TRADING_BOT_PORT}`;

function getSandboxDbPathForAccount(accountId) {
  return path.join(PROJECT_ROOT, 'data', 'sandboxes', accountId, 'prophet_trader.db');
}

// Pooled HTTP agent for Go backend calls — reuses TCP connections
const goHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 30000 });
const goAxios = axios.create({ baseURL: TRADING_BOT_URL, httpAgent: goHttpAgent, timeout: 5000 });

// Crypto service — lazy init, may not be configured
let cryptoService = null;
try {
  const cryptoConf = loadCryptoConfig();
  if (cryptoConf && Object.keys(cryptoConf.exchanges || {}).length > 0) {
    cryptoService = createCryptoService(cryptoConf);
  }
} catch (e) {
  console.log('[server] Crypto service not available:', e.message);
}

export async function createAppContext() {
  // ── Load Config ──────────────────────────────────────────────────
  await loadConfig();
  const initialActiveAccount = getActiveAccount();
  if (initialActiveAccount?.id) {
    const migration = await migrateLegacyDataForAccount(initialActiveAccount.id);
    if (migration.migrated) {
      console.log(`  Migrated legacy data into sandbox for account ${initialActiveAccount.id}: ${migration.copied.join(', ')}`);
    }
  }

  // ── Go Backend Manager ───────────────────────────────────────────
  let goProc = null;
  let goReady = false;

  async function startGoBackend(account) {
    await stopGoBackend();

    if (!account) {
      console.log('  No active account — Go backend not started');
      return false;
    }

    // Build binary if needed
    const binaryPath = path.join(PROJECT_ROOT, 'prophet_bot');
    try {
      const fsSync = await import('fs');
      if (!fsSync.existsSync(binaryPath)) {
        console.log('  Building Go binary...');
        execSync('go build -o prophet_bot ./cmd/bot', { cwd: PROJECT_ROOT, timeout: 60000 });
      }
    } catch (err) {
      console.error('  Failed to build Go binary:', err.message);
      return false;
    }

    const env = {
      ...process.env,
      ALPACA_API_KEY: account.publicKey,
      ALPACA_SECRET_KEY: account.secretKey,
      ALPACA_BASE_URL: account.baseUrl || (account.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'),
      ALPACA_PAPER: account.paper ? 'true' : 'false',
      PORT: TRADING_BOT_PORT,
      DATABASE_PATH: getSandboxDbPathForAccount(account.id),
      ACTIVITY_LOG_DIR: path.join(PROJECT_ROOT, 'data', 'sandboxes', account.id, 'activity_logs'),
      OPENPROPHET_ACCOUNT_ID: account.id,
      OPENPROPHET_SANDBOX_ID: `sbx_${account.id}`,
    };

    await fs.mkdir(path.dirname(env.DATABASE_PATH), { recursive: true });

    console.log(`  Starting Go backend for account "${account.name}" (${account.paper ? 'paper' : 'live'})...`);

    goProc = spawn(binaryPath, [], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    goProc.stdout.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(`  [go] ${msg}`);
    });
    goProc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(`  [go-err] ${msg}`);
    });
    goProc.on('exit', (code, signal) => {
      console.log(`  Go backend exited (code: ${code}, signal: ${signal})`);
      goReady = false;
      goProc = null;
      // Auto-restart on unexpected crash (not manual stop)
      if (code !== 0 && code !== null && signal !== 'SIGTERM') {
        console.log('  Go backend crashed — auto-restarting in 5s...');
        broadcast('agent_log', {
          message: 'Trading backend crashed — auto-restarting in 5s...',
          level: 'error',
          timestamp: new Date().toISOString(),
        });
        setTimeout(() => {
          const acc = getActiveAccount();
          if (acc) startGoBackend(acc);
        }, 5000);
      }
    });

    // Wait for health check
    goReady = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        await goAxios.get('/health', { timeout: 2000 });
        goReady = true;
        console.log(`  Go backend ready on port ${TRADING_BOT_PORT} (account: ${account.name})`);
        broadcast('agent_log', {
          message: `Trading backend started for account "${account.name}" (${account.paper ? 'paper' : 'live'})`,
          level: 'success',
          timestamp: new Date().toISOString(),
        });
        return true;
      } catch {}
    }

    console.error('  Go backend failed to start within 10s');
    broadcast('agent_log', {
      message: 'Trading backend failed to start. Check logs.',
      level: 'error',
      timestamp: new Date().toISOString(),
    });
    return false;
  }

  async function stopGoBackend() {
    if (goProc) {
      const pid = goProc.pid;
      goProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      // Check if still alive
      try { process.kill(pid, 0); goProc.kill('SIGKILL'); } catch {}
      goProc = null;
      goReady = false;
      await new Promise(r => setTimeout(r, 500));
    }
    // Kill any orphaned Go backend on the port (but NOT our own Node process)
    const myPid = process.pid;
    try {
      const pids = execSync(`lsof -t -i :${TRADING_BOT_PORT} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (pids) {
        for (const pid of pids.split('\n')) {
          const p = parseInt(pid);
          if (p && p !== myPid) {
            try { process.kill(p, 'SIGTERM'); } catch {}
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } catch {}
  }

  // ── Agent Instance ───────────────────────────────────────────────
  const chatStore = new ChatStore();
  const orchestrator = new AgentOrchestrator({
    chatStore,
    agentUrl: `http://localhost:${PORT}`,
    tradingBotBasePort: Number(TRADING_BOT_PORT),
  });
  let harness = createHarnessForActiveSandbox();
  const sseClients = new Set();
  const boundOperationalHarnesses = new WeakSet();
  const dailySummaryTimers = new Map();

  function createHarnessForActiveSandbox() {
    const sandbox = getActiveSandbox();
    return new AgentHarness({
      sandboxId: sandbox?.id || null,
      accountId: sandbox?.accountId || null,
      getSandbox,
      getAccount: getAccountById,
      getAgent: getAgentById,
      getResolvedAgent: getResolvedAgentForSandbox,
      getStrategyById,
      getHeartbeatForPhase: getHeartbeatForSandboxPhase,
      getPermissions: getPermissionsForSandbox,
      chatStore,
      opencodeEnv: {
        TRADING_BOT_URL,
        AGENT_URL: `http://localhost:${PORT}`,
        OPENPROPHET_SANDBOX_ID: sandbox?.id || '',
        OPENPROPHET_ACCOUNT_ID: sandbox?.accountId || '',
        DATABASE_PATH: sandbox?.accountId ? getSandboxDbPathForAccount(sandbox.accountId) : '',
      },
    });
  }

  function rebindHarness() {
    harness = createHarnessForActiveSandbox();
    bindHarnessEvents(harness);
    bindOperationalHooks(harness);
  }

  function getOrCreateSandboxRuntime(sandboxId) {
    if (!sandboxId || isActiveSandbox(sandboxId)) return null;
    const runtime = orchestrator.ensureRuntime(sandboxId);
    bindOperationalHooks(runtime.harness);
    return runtime;
  }

  function getHarnessForSandbox(sandboxId) {
    if (!sandboxId) return harness;
    if (harness?.sandboxId === sandboxId) return harness;
    return getOrCreateSandboxRuntime(sandboxId)?.harness || null;
  }

  function isActiveSandbox(sandboxId) {
    return sandboxId && sandboxId === getActiveSandbox()?.id;
  }

  function getGoClientForSandbox(sandboxId) {
    if (!sandboxId || sandboxId === getActiveSandbox()?.id) return goAxios;
    return getOrCreateSandboxRuntime(sandboxId)?.goAxios || null;
  }

  async function refreshHarnessConfigForSandbox(sandboxId, options = {}) {
    const targetHarness = getHarnessForSandbox(sandboxId);
    if (!targetHarness) return;
    await targetHarness.reloadConfig(options);
  }

  async function refreshAllHarnessConfigs(options = {}) {
    const tasks = [];
    if (harness) tasks.push(harness.reloadConfig(options));
    for (const runtime of orchestrator.runtimes.values()) {
      if (runtime.harness) tasks.push(runtime.harness.reloadConfig(options));
    }
    await Promise.allSettled(tasks);
  }

  function broadcast(event, data) {
    if (sseClients.size === 0) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      client.write(msg);
    }
  }

  const EVENTS = [
    'status', 'agent_log', 'agent_text', 'beat_start', 'beat_end',
    'tool_call', 'tool_result', 'heartbeat_change', 'schedule', 'trade',
  ];

  function bindHarnessEvents(activeHarness) {
    for (const evt of EVENTS) {
      activeHarness.state.on(evt, (data) => {
        broadcast(evt, { ...data, sandboxId: activeHarness.sandboxId || getActiveSandbox()?.id || null, timestamp: new Date().toISOString() });
      });
    }
  }

  bindHarnessEvents(harness);
  bindOperationalHooks(harness);
  for (const evt of EVENTS) {
    orchestrator.on(evt, (data) => {
      broadcast(evt, { ...data, timestamp: new Date().toISOString() });
    });
  }

  // ── Slack Notification Dispatcher ────────────────────────────────
  async function notifySlack(text, sandboxId) {
    try {
      const slack = sandboxId ? getPluginForSandbox(sandboxId, 'slack') : getPlugin('slack');
      if (!slack?.enabled || !slack?.webhookUrl) return;
      await axios.post(slack.webhookUrl, {
        text,
        channel: slack.channel || undefined,
      }, { timeout: 5000 });
    } catch (err) {
      console.error('Slack notification failed:', err.message);
    }
  }

  function slackEnabled(event, sandboxId) {
    const slack = sandboxId ? getPluginForSandbox(sandboxId, 'slack') : getPlugin('slack');
    return slack?.enabled && slack?.webhookUrl && slack?.notifyOn?.[event];
  }

  // Daily summary — schedule at 4:30 PM ET
  function scheduleDailySummaryForHarness(targetHarness) {
    const sandboxId = targetHarness.sandboxId;
    const existing = dailySummaryTimers.get(sandboxId);
    if (existing) clearTimeout(existing);
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const target = new Date(et);
    target.setHours(16, 30, 0, 0);
    if (et >= target) target.setDate(target.getDate() + 1);
    const ms = target.getTime() - et.getTime();
    const timer = setTimeout(async () => {
      if (slackEnabled('dailySummary', sandboxId)) {
        try {
          const client = getGoClientForSandbox(sandboxId);
          if (!client) return;
          const { data: acc } = await client.get('/api/v1/account');
          const equity = Number(acc.Equity || acc.equity || 0);
          const lastEquity = Number(acc.LastEquity || acc.last_equity || 0);
          const pnl = equity - lastEquity;
          const pnlPct = lastEquity ? ((pnl / lastEquity) * 100).toFixed(2) : '0.00';
          const emoji = pnl >= 0 ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
          notifySlack(`${emoji} *Daily Summary*\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)\nPortfolio: $${equity.toFixed(2)}\nBeats: ${targetHarness.state.stats.totalBeats} | Trades: ${targetHarness.state.stats.trades} | Errors: ${targetHarness.state.stats.errors}`, sandboxId);
        } catch {}
      }
      scheduleDailySummaryForHarness(targetHarness);
    }, ms);
    dailySummaryTimers.set(sandboxId, timer);
  }

  function bindOperationalHooks(targetHarness) {
    if (!targetHarness || boundOperationalHarnesses.has(targetHarness)) return;
    boundOperationalHarnesses.add(targetHarness);

    targetHarness.state.on('status', (data) => {
      const sandboxId = targetHarness.sandboxId;
      if (!slackEnabled('agentStartStop', sandboxId)) return;
      if (data.status === 'started') {
        notifySlack(`:rocket: *Prophet Agent Started*\nAgent: ${data.agent || 'Unknown'}\nModel: ${data.model || 'Unknown'}\nAccount: ${data.account || 'N/A'}`, sandboxId);
      } else if (data.status === 'stopped') {
        notifySlack(`:octagonal_sign: *Prophet Agent Stopped*`, sandboxId);
      }
    });

    targetHarness.state.on('trade', (trade) => {
      const sandboxId = targetHarness.sandboxId;
      if (slackEnabled('tradeExecuted', sandboxId)) {
        const side = (trade.side || '').toUpperCase();
        const emoji = side === 'BUY' ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
        notifySlack(`${emoji} *Trade Executed*\n${side} ${trade.quantity || '?'}x ${trade.symbol || '??'}${trade.price ? ' @ $' + trade.price : ''}\nTool: ${trade.tool || 'unknown'}`, sandboxId);
      }
      const sideLower = (trade.side || '').toLowerCase();
      if (sideLower === 'buy' && slackEnabled('positionOpened', sandboxId)) {
        notifySlack(`:new: *Position Opened*\n${trade.symbol || '??'} | ${trade.quantity || '?'} contracts${trade.price ? ' @ $' + trade.price : ''}`, sandboxId);
      }
      if (sideLower === 'sell' && slackEnabled('positionClosed', sandboxId)) {
        notifySlack(`:checkered_flag: *Position Closed*\n${trade.symbol || '??'} | ${trade.quantity || '?'} contracts${trade.price ? ' @ $' + trade.price : ''}`, sandboxId);
      }
    });

    targetHarness.state.on('agent_log', (data) => {
      const sandboxId = targetHarness.sandboxId;
      if (data.level !== 'error' || !slackEnabled('errors', sandboxId)) return;
      notifySlack(`:warning: *Prophet Error*\n${data.message}`, sandboxId);
    });

    targetHarness.state.on('beat_start', (data) => {
      const sandboxId = targetHarness.sandboxId;
      if (!slackEnabled('heartbeat', sandboxId)) return;
      notifySlack(`:heartbeat: Beat #${data.beat} | Phase: ${data.phase}`, sandboxId);
    });

    targetHarness.state.on('beat_end', async () => {
      try {
        const sandboxId = targetHarness.sandboxId;
        const perms = getPermissionsForSandbox(sandboxId);
        if (!perms.maxDailyLoss || perms.maxDailyLoss <= 0) return;
        const client = getGoClientForSandbox(sandboxId);
        if (!client) return;
        const { data: acc } = await client.get('/api/v1/account', { timeout: 3000 });
        const equity = Number(acc.Equity || acc.equity || 0);
        const lastEquity = Number(acc.LastEquity || acc.last_equity || 0);
        if (!lastEquity) return;
        const dayLossPct = ((equity - lastEquity) / lastEquity) * 100;
        if (dayLossPct <= -perms.maxDailyLoss && !targetHarness.state.paused) {
          targetHarness.pause();
          const msg = `CIRCUIT BREAKER: Daily loss ${dayLossPct.toFixed(2)}% exceeds -${perms.maxDailyLoss}% limit. Agent auto-paused.`;
          broadcast('agent_log', { message: msg, level: 'error', sandboxId, timestamp: new Date().toISOString() });
          if (slackEnabled('errors', sandboxId)) notifySlack(`:rotating_light: ${msg}`, sandboxId);
        }
      } catch { /* silently skip if account unavailable */ }
    });

    scheduleDailySummaryForHarness(targetHarness);
  }

  // ── Safe Config (strip secrets) ──────────────────────────────────
  function safeConfig() {
    const cfg = { ...getConfig() };
    cfg.accounts = (cfg.accounts || []).map(a => ({ ...a, secretKey: a.secretKey ? '****' + a.secretKey.slice(-4) : '****' }));
    return cfg;
  }

  // Manager chat state
  let _managerSessionId = null;
  let _managerProc = null;
  const _managerSessions = [];

  // Initialize sandbox runtimes
  for (const sandbox of getSandboxes()) {
    if (!isActiveSandbox(sandbox.id)) {
      const runtime = orchestrator.ensureRuntime(sandbox.id);
      bindOperationalHooks(runtime.harness);
    }
  }

  // Return context object — getters for mutable state, direct refs for stable state
  return {
    get harness() { return harness; },
    get goProc() { return goProc; },
    get goReady() { return goReady; },

    orchestrator,
    chatStore,
    sseClients,
    goAxios,
    cryptoService,

    broadcast,
    safeConfig,
    rebindHarness,
    startGoBackend,
    stopGoBackend,
    isActiveSandbox,
    getHarnessForSandbox,
    getGoClientForSandbox,
    refreshHarnessConfigForSandbox,
    refreshAllHarnessConfigs,
    bindOperationalHooks,
    migrateLegacyDataForAccount,

    manager: {
      get sessionId() { return _managerSessionId; },
      set sessionId(v) { _managerSessionId = v; },
      get proc() { return _managerProc; },
      set proc(v) { _managerProc = v; },
      sessions: _managerSessions,
    },

    PORT,
    TRADING_BOT_PORT,
    TRADING_BOT_URL,
    PROJECT_ROOT,
    __dirname,
  };
}
