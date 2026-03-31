// Agent control routes: start/stop/pause/resume, messaging, state, prompt preview
// Also CRUD for agent definitions and config endpoint.
import { Router } from 'express';
import {
  getConfig, getActiveAgent, getAgentById, getResolvedAgentForSandbox,
  getActiveSandbox, getSandbox, getSandboxes, getActiveAccount,
  addAgent, updateAgent, removeAgent, setActiveAgent, getStrategyById,
} from '../config-store.js';
import { buildSystemPrompt } from '../harness.js';

export default function createAgentRoutes(ctx) {
  const router = Router();

  // ── Agent Control ────────────────────────────────────────────────
  router.post('/agent/start', async (req, res) => {
    try {
      await ctx.harness.start();
      res.json({ ok: true, status: 'started' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/agent/stop', async (req, res) => {
    await ctx.harness.stop();
    res.json({ ok: true, status: 'stopped' });
  });

  router.post('/agent/pause', (req, res) => {
    ctx.harness.pause();
    res.json({ ok: true, status: 'paused' });
  });

  router.post('/agent/resume', (req, res) => {
    ctx.harness.resume();
    res.json({ ok: true, status: 'resumed' });
  });

  // ── Agent Messaging ──────────────────────────────────────────────
  router.post('/agent/message', async (req, res) => {
    try {
      const { message, sandboxId } = req.body;
      if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

      const trimmed = message.trim();
      const config = getConfig();

      // /help - show available commands
      if (trimmed === '/help' || trimmed === '/?') {
        const helpText = `Available commands:

/newagent - Create a new agent
/editagent <id> - Edit an existing agent
/agents - List all agents
/sandboxes - List all sandboxes (portfolios)
/start <sandboxId> - Start agent on a sandbox
/stop <sandboxId> - Stop agent on a sandbox
/status - Show status of all portfolios
/portfolios - Show status of all portfolios

Models: ${(config.models || []).length} available
Providers: ${[...new Set((config.models || []).map(m => m.id.split('/')[0]))].join(', ')}

Use /newagent to open the agent builder!`;
        return res.json({ ok: true, text: helpText });
      }

      // /newagent - open agent builder
      if (trimmed === '/newagent' || trimmed.startsWith('/newagent ')) {
        const models = config.models || [];
        const strategies = config.strategies || [];
        ctx.broadcast('agent_builder', {
          mode: 'create',
          models,
          strategies,
          sandboxId: sandboxId || getActiveSandbox()?.id,
        });
        return res.json({ ok: true, builder: true });
      }

      // /editagent - open agent editor
      const editMatch = trimmed.match(/^\/editagent\s+(\S+)/);
      if (editMatch) {
        const agentId = editMatch[1];
        const agent = getAgentById(agentId);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        const models = config.models || [];
        const strategies = config.strategies || [];
        ctx.broadcast('agent_builder', {
          mode: 'edit',
          agent,
          models,
          strategies,
          sandboxId: sandboxId || getActiveSandbox()?.id,
        });
        return res.json({ ok: true, builder: true });
      }

      // /agents - list agents
      if (trimmed === '/agents') {
        const agents = config.agents || [];
        let msg = 'Available agents:\n';
        for (const a of agents) {
          msg += `\n- ${a.name} (${a.id})\n  Model: ${a.model || 'default'}\n  Strategy: ${a.strategyId || 'none'}\n`;
        }
        msg += '\nUse /editagent <id> to edit an agent';
        return res.json({ ok: true, text: msg });
      }

      // /sandboxes - list sandboxes and their status
      if (trimmed === '/sandboxes') {
        const sandboxes = getSandboxes();
        let msg = 'Available sandboxes (portfolios):\n';
        for (const s of sandboxes) {
          const isActive = getActiveSandbox()?.id === s.id;
          const runtime = ctx.orchestrator.getSandboxRuntime(s.id);
          const state = isActive ? ctx.harness.state.running : (runtime ? runtime.harness.state.running : false);
          msg += `\n- ${s.name} (${s.id})\n  Account: ${s.accountId}\n  Status: ${state ? 'running' : 'stopped'}\n  Agent: ${s.agent?.activeAgentId || 'default'}\n`;
        }
        msg += '\nUse /start <sandboxId> or /stop <sandboxId> to control';
        return res.json({ ok: true, text: msg });
      }

      // /start <sandboxId>
      const startMatch = trimmed.match(/^\/start\s+(\S+)/);
      if (startMatch) {
        const sbxId = startMatch[1];
        const sandbox = getSandbox(sbxId);
        if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });
        const isActive = getActiveSandbox()?.id === sbxId;
        if (isActive) {
          if (!ctx.harness.state.running) { await ctx.harness.start(); }
        } else {
          await ctx.orchestrator.startSandbox(sbxId);
        }
        return res.json({ ok: true, text: `Started agent on sandbox ${sandbox.name}` });
      }

      // /stop <sandboxId>
      const stopMatch = trimmed.match(/^\/stop\s+(\S+)/);
      if (stopMatch) {
        const sbxId = stopMatch[1];
        const sandbox = getSandbox(sbxId);
        if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });
        const isActive = getActiveSandbox()?.id === sbxId;
        if (isActive) {
          if (ctx.harness.state.running) { await ctx.harness.stop(); }
        } else {
          await ctx.orchestrator.stopSandbox(sbxId);
        }
        return res.json({ ok: true, text: `Stopped agent on sandbox ${sandbox.name}` });
      }

      // /status
      if (trimmed === '/status' || trimmed === '/portfolio' || trimmed === '/portfolios') {
        const sandboxes = getSandboxes();
        const account = getActiveAccount();
        let msg = 'Portfolio Status:\n';
        msg += `\nActive: ${account?.name || 'none'} (${account?.paper ? 'paper' : 'live'})\n`;
        msg += '\nSandbox Status:\n';
        for (const s of sandboxes) {
          const isActive = getActiveSandbox()?.id === s.id;
          const runtime = ctx.orchestrator.getSandboxRuntime(s.id);
          const state = isActive ? ctx.harness.state.toJSON() : (runtime ? runtime.harness.state.toJSON() : { running: false, beat: 0 });
          msg += `\n${s.name}: ${state.running ? 'running' : 'stopped'} (beat #${state.beat || 0})`;
        }
        return res.json({ ok: true, text: msg });
      }

      const result = await ctx.harness.sendMessage(trimmed);
      res.json({ ok: true, ...result });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.get('/agent/state', (req, res) => {
    res.json(ctx.harness.state.toJSON());
  });

  // System prompt preview
  router.get('/agent/prompt-preview', async (req, res) => {
    try {
      const sandboxId = req.query.sandboxId || getActiveSandbox()?.id;
      const agentConfig = sandboxId ? getResolvedAgentForSandbox(sandboxId) : getActiveAgent();
      const prompt = await buildSystemPrompt(agentConfig, { getStrategyById });
      res.json({ prompt, agentName: agentConfig.name, sandboxId });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Config ───────────────────────────────────────────────────────
  router.get('/config', (req, res) => {
    res.json(ctx.safeConfig());
  });

  // ── Agents CRUD ──────────────────────────────────────────────────
  router.get('/agents', (req, res) => {
    const config = getConfig();
    res.json({ agents: config.agents, activeId: config.activeAgentId });
  });

  router.post('/agents', async (req, res) => {
    try {
      const agent = await addAgent(req.body);
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, agent });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.put('/agents/:id', async (req, res) => {
    try {
      const agent = await updateAgent(req.params.id, req.body);
      await ctx.refreshAllHarnessConfigs({ resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, agent });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.delete('/agents/:id', async (req, res) => {
    try {
      await removeAgent(req.params.id);
      await ctx.refreshAllHarnessConfigs({ resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/agents/:id/activate', async (req, res) => {
    try {
      await setActiveAgent(req.params.id);
      await ctx.refreshHarnessConfigForSandbox(getActiveSandbox()?.id, { resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  return router;
}
