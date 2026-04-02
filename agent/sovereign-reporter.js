/**
 * sovereign-reporter.js — Periodic P&L and trading status reporter to Sovereign API.
 *
 * Every 5 minutes, sends a webhook event to Sovereign with:
 * - Daily P&L and equity
 * - Open positions count
 * - Trade count and error count
 * - Active strategy name
 * - Agent running status
 *
 * Gracefully handles Sovereign being offline (log warning, don't crash).
 */

import { createHmac } from 'crypto';

const SOVEREIGN_URL = process.env.SOVEREIGN_URL || 'http://localhost:8420';
const SOVEREIGN_API_KEY = process.env.SOVEREIGN_API_KEY || '';
const REPORT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SOURCE = 'openclaw';

let intervalHandle = null;

/**
 * Build HMAC-SHA256 signature matching Sovereign's Python canonical form:
 * json.dumps({"event_type": ..., "payload": ..., "source": ...}, sort_keys=True, separators=(",",":"))
 *
 * Python's sort_keys sorts ALL keys recursively, separators=(",",":") removes spaces.
 */

/** Recursively sort all object keys to match Python's sort_keys=True. */
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

function signEvent(source, eventType, payload) {
  if (!SOVEREIGN_API_KEY) return '';
  const canonical = JSON.stringify(sortKeys({ event_type: eventType, payload, source }));
  return createHmac('sha256', SOVEREIGN_API_KEY).update(canonical).digest('hex');
}

/**
 * Gather trading data from the Go backend via ctx.goAxios, harness state, and config.
 */
async function gatherTradingStatus(ctx) {
  const status = {
    equity: 0,
    last_equity: 0,
    daily_pnl: 0,
    daily_pnl_pct: 0,
    buying_power: 0,
    open_positions: 0,
    agent_running: false,
    total_beats: 0,
    total_trades: 0,
    total_errors: 0,
    strategy: 'unknown',
    account_type: 'unknown',
    sandbox_id: null,
  };

  // Agent harness state
  try {
    const harness = ctx.harness;
    if (harness) {
      status.agent_running = harness.state?.running ?? false;
      status.total_beats = harness.state?.stats?.totalBeats ?? 0;
      status.total_trades = harness.state?.stats?.trades ?? 0;
      status.total_errors = harness.state?.stats?.errors ?? 0;
      status.sandbox_id = harness.sandboxId || null;
    }
  } catch { /* harness may not be ready */ }

  // Strategy name from config
  try {
    const { getActiveSandbox, getResolvedAgentForSandbox, getStrategyById } = await import('./config-store.js');
    const sandbox = getActiveSandbox();
    if (sandbox) {
      const agent = getResolvedAgentForSandbox(sandbox.id);
      if (agent?.strategyId) {
        const strategy = getStrategyById(agent.strategyId);
        status.strategy = strategy?.name || agent.strategyId;
      }
    }
  } catch { /* config not available */ }

  // Account + positions from Go backend
  if (!ctx.goReady) return status;

  try {
    const { data: account } = await ctx.goAxios.get('/api/v1/account', { timeout: 3000 });
    status.equity = Number(account.Equity || account.equity || 0);
    status.last_equity = Number(account.LastEquity || account.last_equity || 0);
    status.buying_power = Number(account.BuyingPower || account.buying_power || 0);
    status.account_type = account.AccountBlocked ? 'blocked' : (account.TradingBlocked ? 'restricted' : 'active');

    if (status.last_equity > 0) {
      status.daily_pnl = Math.round((status.equity - status.last_equity) * 100) / 100;
      status.daily_pnl_pct = Math.round(((status.equity - status.last_equity) / status.last_equity) * 10000) / 100;
    }
  } catch { /* Go backend may be down */ }

  try {
    const { data: positions } = await ctx.goAxios.get('/api/v1/positions', { timeout: 3000 });
    status.open_positions = Array.isArray(positions) ? positions.length : 0;
  } catch { /* positions unavailable */ }

  return status;
}

/**
 * Send status report to Sovereign webhook endpoint.
 */
async function sendStatusReport(ctx) {
  if (!SOVEREIGN_API_KEY) return;

  const eventType = 'status_report';
  let payload;

  try {
    payload = await gatherTradingStatus(ctx);
    payload.uptime_seconds = Math.floor(process.uptime());
    payload.reported_at = new Date().toISOString();
  } catch (err) {
    console.log(`  [sovereign] Failed to gather status: ${err.message}`);
    return;
  }

  const signature = signEvent(SOURCE, eventType, payload);

  const body = {
    source: SOURCE,
    event_type: eventType,
    payload,
    timestamp: new Date().toISOString(),
    signature,
  };

  try {
    const response = await fetch(`${SOVEREIGN_URL}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': SOVEREIGN_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`  [sovereign] Status report sent (event: ${result.event_id}, P&L: $${payload.daily_pnl})`);
    } else {
      console.log(`  [sovereign] Status report rejected: HTTP ${response.status}`);
    }
  } catch (err) {
    // Sovereign is offline — log and continue, don't crash
    console.log(`  [sovereign] Unreachable, skipping report (${err.message || err})`);
  }
}

/**
 * Start the periodic status reporter.
 * @param {object} ctx — App context from createAppContext()
 */
export function startSovereignReporter(ctx) {
  if (intervalHandle) return;

  if (!SOVEREIGN_API_KEY) {
    console.log('  [sovereign] Reporter disabled — SOVEREIGN_API_KEY not set');
    return;
  }

  console.log(`  [sovereign] Reporter started → ${SOVEREIGN_URL} (every 5m)`);

  // Initial report after 30s (let Go backend finish booting)
  setTimeout(() => sendStatusReport(ctx).catch(() => {}), 30_000);

  intervalHandle = setInterval(() => {
    sendStatusReport(ctx).catch(() => {});
  }, REPORT_INTERVAL_MS);

  // Don't keep the process alive just for reporting
  if (intervalHandle?.unref) intervalHandle.unref();
}

/**
 * Stop the periodic reporter.
 */
export function stopSovereignReporter() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('  [sovereign] Reporter stopped');
  }
}

/**
 * Send a one-shot event to Sovereign (for trade events, errors, etc.).
 * @param {string} eventType — e.g. "trade_executed", "agent_error", "circuit_breaker"
 * @param {object} payload — Event-specific data
 */
export async function sendSovereignEvent(eventType, payload) {
  if (!SOVEREIGN_API_KEY) return;

  const signature = signEvent(SOURCE, eventType, payload);

  try {
    await fetch(`${SOVEREIGN_URL}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': SOVEREIGN_API_KEY,
      },
      body: JSON.stringify({
        source: SOURCE,
        event_type: eventType,
        payload,
        timestamp: new Date().toISOString(),
        signature,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Fire-and-forget — don't crash on Sovereign being offline
  }
}
