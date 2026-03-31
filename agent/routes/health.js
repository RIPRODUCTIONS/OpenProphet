// Health check route.
import { Router } from 'express';
import {
  getActiveAccount, getActiveSandbox, getSandboxes,
} from '../config-store.js';

export default function createHealthRoutes(ctx) {
  const router = Router();

  router.get('/health', async (req, res) => {
    let botHealthy = false;
    try {
      await ctx.goAxios.get('/health', { timeout: 3000 });
      botHealthy = true;
    } catch {}
    const account = getActiveAccount();
    const sandboxStates = getSandboxes().map(sandbox => ({
      sandboxId: sandbox.id,
      port: ctx.isActiveSandbox(sandbox.id) ? Number(ctx.TRADING_BOT_PORT) : ctx.orchestrator.getSandboxRuntime(sandbox.id)?.port || null,
      goReady: ctx.isActiveSandbox(sandbox.id) ? ctx.goReady : (ctx.orchestrator.getSandboxRuntime(sandbox.id)?.goReady || false),
      goPid: ctx.isActiveSandbox(sandbox.id) ? (ctx.goProc?.pid || null) : (ctx.orchestrator.getSandboxRuntime(sandbox.id)?.goProc?.pid || null),
      state: ctx.isActiveSandbox(sandbox.id) ? ctx.harness.state.toJSON() : (ctx.orchestrator.getSandboxRuntime(sandbox.id)?.harness.state.toJSON() || null),
    }));
    res.json({
      agent: 'healthy',
      trading_bot: botHealthy ? 'healthy' : 'unavailable',
      trading_bot_managed: ctx.goProc !== null,
      activeAccount: account ? { name: account.name, paper: account.paper } : null,
      uptime: process.uptime(),
      state: ctx.harness.state.toJSON(),
      sandboxes: sandboxStates,
    });
  });

  return router;
}
