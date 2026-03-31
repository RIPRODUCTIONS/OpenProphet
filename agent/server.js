#!/usr/bin/env node

// Prophet Agent Web Server — slim entry point.
// All state/services live in app-context.js; routes are in routes/*.js.
import 'dotenv/config';
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
import { getActiveAccount, getSandboxes } from './config-store.js';

// ── Initialize ─────────────────────────────────────────────────────
const ctx = await createAppContext();

const app = express();
app.use(express.json({ limit: '1mb' }));

// Auth middleware on all API routes
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
});
