#!/usr/bin/env node

// Prophet Agent Web Server — slim entry point.
// All state/services live in app-context.js; routes are in routes/*.js.
import 'dotenv/config';
import { parseArgs } from 'node:util';
import express from 'express';
import path from 'path';
import { createAppContext } from './app-context.js';
import authMiddleware from './middleware/auth.js';
import createAgentRoutes from './routes/agent.js';
import createAccountRoutes from './routes/account.js';
import createSandboxRoutes from './routes/sandbox.js';
import createHeartbeatRoutes from './routes/heartbeat.js';
import createChatRoutes from './routes/chat.js';
import createPermissionsRoutes from './routes/permissions.js';
import createStrategyRoutes from './routes/strategy.js';
import createHealthRoutes from './routes/health.js';
import createPortfolioRoutes from './routes/portfolio.js';
import createWalletRoutes from './routes/wallet.js';
import createSignalsRoutes from './routes/signals.js';
import { getActiveAccount, getSandboxes } from './config-store.js';
import { createWalletSystem } from '../wallet/index.js';
import { startSovereignReporter, stopSovereignReporter } from './sovereign-reporter.js';

// ── CLI Flags ──────────────────────────────────────────────────────
const { values: cliFlags } = parseArgs({
  options: {
    'auto-start':      { type: 'boolean', default: false },
    'live-auto-start': { type: 'boolean', default: false },
    'start-delay':     { type: 'string',  default: '30' },
    'health-check':    { type: 'boolean', default: false },
  },
  strict: false,        // ignore unknown flags (e.g. Node.js flags)
  allowPositionals: true,
});

// ── Initialize ─────────────────────────────────────────────────────
const ctx = await createAppContext();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Signal routes mounted BEFORE global auth (has own X-Signal-Key auth)
app.use('/api/signals', createSignalsRoutes(ctx));

// Auth middleware on all other API routes
app.use('/api', authMiddleware);

// Mount route modules
app.use('/api', createAgentRoutes(ctx));
app.use('/api', createAccountRoutes(ctx));
app.use('/api', createSandboxRoutes(ctx));
app.use('/api', createHeartbeatRoutes(ctx));
app.use('/api', createChatRoutes(ctx));
app.use('/api', createPermissionsRoutes(ctx));
app.use('/api', createStrategyRoutes(ctx));
app.use('/api', createHealthRoutes(ctx));
app.use('/api', createPortfolioRoutes(ctx));

// ── Wallet subsystem (optional — requires COINBASE_API_KEY) ──────────────
let walletSystem = null;
if (process.env.COINBASE_API_KEY && process.env.COINBASE_API_SECRET) {
  try {
    walletSystem = createWalletSystem();
    await walletSystem.init();
    console.log(`  Wallet initialized: ${walletSystem.walletManager.getStatus().address}`);
  } catch (err) {
    console.log(`  Wallet not available: ${err.message}`);
  }
}
app.use('/api', createWalletRoutes(ctx, walletSystem));

// Serve static files (after API routes)
app.use(express.static(path.join(ctx.__dirname, 'public')));

// SPA fallback — serve index.html for non-API routes
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && req.method === 'GET') {
    res.sendFile(path.join(ctx.__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

// ── Start Go backend ───────────────────────────────────────────────
const activeAccount = getActiveAccount();
if (activeAccount) {
  await ctx.startGoBackend(activeAccount);
} else {
  console.log('  No active account configured — Go backend not started');
}

// ── Graceful shutdown ──────────────────────────────────────────────
async function shutdown() {
  console.log('\n  Shutting down...');
  stopSovereignReporter();
  await ctx.harness.stop();
  await ctx.orchestrator.shutdown();
  await ctx.stopGoBackend();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Listen ─────────────────────────────────────────────────────────
app.listen(ctx.PORT, '0.0.0.0', async () => {
  console.log(`\n  Prophet Agent Dashboard: http://localhost:${ctx.PORT}`);
  console.log(`  Network:                http://0.0.0.0:${ctx.PORT}`);
  console.log(`  Trading Bot Backend:    ${ctx.TRADING_BOT_URL}`);
  console.log(`  Active Account:         ${activeAccount?.name || 'none'}\n`);

  // Start Sovereign status reporting
  startSovereignReporter(ctx);

  // Auto-start sandboxes that have autoStart enabled
  const allSandboxes = getSandboxes();
  const autoStarters = allSandboxes.filter(s => s.autoStart);
  for (let i = 0; i < autoStarters.length; i++) {
    const sandbox = autoStarters[i];
    try {
      await ctx.orchestrator.startSandbox(sandbox.id);
      console.log(`  Auto-started sandbox: ${sandbox.id} (${sandbox.name})`);
      if (i < autoStarters.length - 1) await new Promise(r => setTimeout(r, 10000));
    } catch (err) {
      console.error(`  Failed to auto-start ${sandbox.id}: ${err.message}`);
    }
  }

  // ── Auto-start agent heartbeat (--auto-start flag) ──────────────
  if (cliFlags['auto-start'] || cliFlags['live-auto-start']) {
    const isPaper = activeAccount?.paper !== false;

    if (!isPaper && !cliFlags['live-auto-start']) {
      console.error('\n  ✗ Auto-start blocked: live account detected.');
      console.error('    Use --live-auto-start to confirm live auto-start.\n');
    } else if (!activeAccount) {
      console.error('\n  ✗ Auto-start blocked: no active account configured.\n');
    } else {
      const delaySeconds = Math.max(0, parseInt(cliFlags['start-delay'], 10) || 30);
      const modeLabel = isPaper ? 'paper' : 'LIVE';
      console.log(`\n  ⏳ Auto-start in ${delaySeconds}s (${modeLabel} mode)...`);

      setTimeout(async () => {
        try {
          // Optional: run health check before auto-start
          if (cliFlags['health-check']) {
            try {
              const { runHealthCheck } = await import('../scripts/health-check.js');
              const health = await runHealthCheck({ quiet: true });
              if (!health.passed) {
                console.error('  ✗ Auto-start aborted: health check failed');
                for (const c of health.checks.filter(c => c.status === 'fail' && c.critical)) {
                  console.error(`    ✗ ${c.name}: ${c.message}`);
                }
                return;
              }
              console.log('  ✓ Health check passed');
            } catch (err) {
              console.warn(`  ⚠ Health check module not available: ${err.message}`);
            }
          }

          await ctx.harness.start();
          console.log(`  ✓ Agent heartbeat auto-started (${modeLabel})`);
        } catch (err) {
          console.error(`  ✗ Auto-start failed: ${err.message}`);
        }
      }, delaySeconds * 1000);
    }
  }
});
