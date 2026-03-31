// Sandbox orchestration routes: list, state, start/stop/pause/resume,
// messaging, config, dashboard, activation, CRUD, agent/strategy overrides.
import { Router } from 'express';
import {
  getConfig, getActiveAccount, getAgentById, getResolvedAgentForSandbox,
  getActiveSandbox, getSandbox, getSandboxes, getPermissionsForSandbox,
  getPluginForSandbox, getHeartbeatProfiles, getPhaseTimeRanges,
  setActiveSandbox, addSandboxForAccount, removeSandbox,
  updateSandboxAgentSelection, updateSandboxAgentOverrides, updateSandboxStrategyRules,
} from '../config-store.js';
import { migrateLegacyDataForAccount } from '../data-migration.js';

export default function createSandboxRoutes(ctx) {
  const router = Router();

  // List all sandboxes with runtime state
  router.get('/sandboxes', (req, res) => {
    const sandboxes = getSandboxes().map(sandbox => ({
      ...sandbox,
      runtime: ctx.isActiveSandbox(sandbox.id)
        ? ctx.harness.state.toJSON()
        : (ctx.orchestrator.getSandboxRuntime(sandbox.id) ? ctx.orchestrator.getState(sandbox.id) : null),
      isActive: getActiveSandbox()?.id === sandbox.id,
    }));
    res.json({ sandboxes });
  });

  router.get('/sandboxes/:id/state', (req, res) => {
    try {
      if (ctx.isActiveSandbox(req.params.id)) return res.json(ctx.harness.state.toJSON());
      res.json(ctx.orchestrator.getState(req.params.id));
    } catch (err) { res.status(404).json({ error: err.message }); }
  });

  router.post('/sandboxes/:id/start', async (req, res) => {
    try {
      if (ctx.isActiveSandbox(req.params.id)) {
        const account = getActiveAccount();
        if (!ctx.goReady && account) await ctx.startGoBackend(account);
        await ctx.harness.start();
      }
      if (!ctx.isActiveSandbox(req.params.id)) {
        await ctx.orchestrator.startSandbox(req.params.id);
      }
      res.json({ ok: true, status: 'started', sandboxId: req.params.id });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/sandboxes/:id/stop', async (req, res) => {
    try {
      if (ctx.isActiveSandbox(req.params.id)) {
        await ctx.harness.stop();
        await ctx.stopGoBackend();
      } else {
        await ctx.orchestrator.stopSandbox(req.params.id);
      }
      res.json({ ok: true, status: 'stopped', sandboxId: req.params.id });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/sandboxes/:id/pause', (req, res) => {
    try {
      if (ctx.isActiveSandbox(req.params.id)) ctx.harness.pause();
      else ctx.orchestrator.pauseSandbox(req.params.id);
      res.json({ ok: true, status: 'paused', sandboxId: req.params.id });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/sandboxes/:id/resume', (req, res) => {
    try {
      if (ctx.isActiveSandbox(req.params.id)) ctx.harness.resume();
      else ctx.orchestrator.resumeSandbox(req.params.id);
      res.json({ ok: true, status: 'resumed', sandboxId: req.params.id });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/sandboxes/:id/message', async (req, res) => {
    try {
      const { message } = req.body;
      const sandboxId = req.params.id;
      if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

      const config = getConfig();
      const trimmed = message.trim();

      // /newagent command
      if (trimmed === '/newagent') {
        ctx.broadcast('agent_builder', {
          mode: 'create',
          models: config.models || [],
          strategies: config.strategies || [],
          sandboxId,
        });
        const providers = [...new Set((config.models || []).map(m => m.id.split('/')[0]))].join(', ');
        return res.json({ ok: true, builder: true, text:
          'Agent Builder opened! You can also describe what you want here:\n\n' +
          '- What should it trade? (options, stocks, both)\n' +
          '- What trading style? (aggressive, conservative, scalping, swing, long-term)\n' +
          '- Any timeframe rules? (day trading, multi-day holds, weekly)\n' +
          '- Risk tolerance? (max position size, stop loss %)\n' +
          '- Which model? (' + providers + ')\n' +
          '- Any specific rules?\n\n' +
          'Example: "Create a conservative tech options agent with 30-day holds, max 10% per position, using claude-sonnet-4-6"'
        });
      }

      // /editagent command
      const editMatch = trimmed.match(/^\/editagent\s+(\S+)/);
      if (editMatch) {
        const agent = getAgentById(editMatch[1]);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        ctx.broadcast('agent_builder', {
          mode: 'edit',
          agent,
          models: config.models || [],
          strategies: config.strategies || [],
          sandboxId,
        });
        return res.json({ ok: true, builder: true });
      }

      // /agents command
      if (trimmed === '/agents') {
        const agents = config.agents || [];
        let msg = 'Available agents:\n' + agents.map(a => `- ${a.name} (${a.id})`).join('\n');
        return res.json({ ok: true, text: msg });
      }

      const result = ctx.isActiveSandbox(sandboxId)
        ? await ctx.harness.sendMessage(trimmed)
        : await ctx.orchestrator.sendMessage(sandboxId, trimmed);
      res.json({ ok: true, sandboxId, ...result });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.get('/sandboxes/:id/config', (req, res) => {
    try {
      const sandbox = getSandbox(req.params.id);
      if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });
      const agent = getResolvedAgentForSandbox(req.params.id);
      res.json({ sandbox, agent });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.get('/sandboxes/:id/dashboard', (req, res) => {
    try {
      const sandbox = getSandbox(req.params.id);
      if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });

      const agent = getResolvedAgentForSandbox(req.params.id);
      const heartbeat = getSandbox(req.params.id)?.heartbeat || {};
      const permissions = getPermissionsForSandbox(req.params.id);
      const slack = getPluginForSandbox(req.params.id, 'slack');
      const isActive = ctx.isActiveSandbox(req.params.id);
      let state;
      if (isActive) {
        state = ctx.harness.state.toJSON();
      } else {
        const runtime = ctx.orchestrator.getSandboxRuntime(req.params.id);
        state = runtime ? runtime.harness.state.toJSON() : { running: false, status: 'stopped', beat: 0 };
      }

      const config = getConfig();
      const providers = [...new Set((config.models || []).map(m => m.id.split('/')[0]))];

      res.json({
        sandbox,
        agent,
        models: config.models,
        providers,
        heartbeat,
        heartbeatProfiles: getHeartbeatProfiles(),
        heartbeatPhases: getPhaseTimeRanges(),
        permissions,
        slack: slack || {},
        state,
      });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/sandboxes/:id/activate', async (req, res) => {
    try {
      const sandbox = getSandbox(req.params.id);
      if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });

      const wasRunning = ctx.harness.state.running;
      if (wasRunning) await ctx.harness.stop();
      if (ctx.orchestrator.getSandboxRuntime(req.params.id)) {
        await ctx.orchestrator.stopSandbox(req.params.id);
      }

      await setActiveSandbox(req.params.id);
      ctx.rebindHarness();
      const account = getActiveAccount();
      if (account) {
        await migrateLegacyDataForAccount(account.id);
        await ctx.startGoBackend(account);
        if (wasRunning) await ctx.harness.start();
      }
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, sandboxId: req.params.id });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Create a new sandbox for an existing account
  router.post('/sandboxes', async (req, res) => {
    try {
      const { accountId, id, name, activeAgentId, model, heartbeat, permissions } = req.body || {};
      if (!accountId) return res.status(400).json({ error: 'accountId is required' });
      const sandbox = await addSandboxForAccount(accountId, { id, name, activeAgentId, model, heartbeat, permissions });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, sandbox });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // Delete a sandbox
  router.delete('/sandboxes/:id', async (req, res) => {
    try {
      if (ctx.orchestrator.getSandboxRuntime(req.params.id)) {
        await ctx.orchestrator.stopSandbox(req.params.id);
      }
      await removeSandbox(req.params.id);
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.put('/sandboxes/:id/agent', async (req, res) => {
    try {
      const { activeAgentId, model, overrides = {} } = req.body || {};
      const updates = {};
      if (activeAgentId !== undefined) updates.activeAgentId = activeAgentId;
      if (model !== undefined) updates.model = model;
      if (Object.keys(overrides).length) updates.overrides = overrides;
      const sandbox = await updateSandboxAgentSelection(req.params.id, updates);
      await ctx.refreshHarnessConfigForSandbox(req.params.id, { resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, sandbox, agent: getResolvedAgentForSandbox(req.params.id) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.put('/sandboxes/:id/agent/overrides', async (req, res) => {
    try {
      const sandbox = await updateSandboxAgentOverrides(req.params.id, req.body || {});
      await ctx.refreshHarnessConfigForSandbox(req.params.id, { resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, sandbox, agent: getResolvedAgentForSandbox(req.params.id) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.put('/sandboxes/:id/strategy-rules', async (req, res) => {
    try {
      if (typeof req.body?.rules !== 'string') {
        return res.status(400).json({ error: 'rules is required' });
      }
      const sandbox = await updateSandboxStrategyRules(req.params.id, req.body.rules);
      await ctx.refreshHarnessConfigForSandbox(req.params.id, { resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, sandbox, agent: getResolvedAgentForSandbox(req.params.id) });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  return router;
}
