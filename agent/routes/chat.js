// Chat routes: SSE event stream, manager chat, and chat history.
import { Router } from 'express';
import { spawn } from 'child_process';
import {
  getConfig, saveConfig, getActiveAccount, getActiveSandbox,
} from '../config-store.js';

export default function createChatRoutes(ctx) {
  const router = Router();

  // ── SSE Endpoint ─────────────────────────────────────────────────
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: state\ndata: ${JSON.stringify({ ...ctx.harness.state.toJSON(), sandboxId: getActiveSandbox()?.id || null })}\n\n`);
    res.write(`event: config\ndata: ${JSON.stringify(ctx.safeConfig())}\n\n`);
    ctx.sseClients.add(res);
    req.on('close', () => ctx.sseClients.delete(res));
  });

  // ── Manager Chat ─────────────────────────────────────────────────
  router.get('/manager/config', (req, res) => {
    const config = getConfig();
    const mgr = config.manager || { model: config.activeModel, customPrompt: '' };
    res.json({ model: mgr.model, customPrompt: mgr.customPrompt || '', sessions: ctx.manager.sessions, activeSessionId: ctx.manager.sessionId });
  });

  router.put('/manager/config', async (req, res) => {
    try {
      const config = getConfig();
      if (!config.manager) config.manager = {};
      if (req.body.model !== undefined) config.manager.model = req.body.model;
      if (req.body.customPrompt !== undefined) config.manager.customPrompt = req.body.customPrompt;
      await saveConfig();
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/manager/new-session', (req, res) => {
    if (ctx.manager.proc) { try { ctx.manager.proc.kill('SIGTERM'); } catch {} ctx.manager.proc = null; }
    ctx.manager.sessionId = null;
    res.json({ ok: true });
  });

  router.post('/manager/stop', (req, res) => {
    if (ctx.manager.proc) {
      try { ctx.manager.proc.kill('SIGTERM'); } catch {}
      ctx.manager.proc = null;
      ctx.broadcast('manager_done', {});
    }
    res.json({ ok: true });
  });

  router.get('/manager/sessions', (req, res) => {
    res.json({ sessions: ctx.manager.sessions, activeSessionId: ctx.manager.sessionId });
  });

  router.post('/manager/message', async (req, res) => {
    try {
      const { message } = req.body;
      if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

      const config = getConfig();
      const mgr = config.manager || {};
      const model = mgr.model || config.activeModel || 'anthropic/claude-sonnet-4-6';
      const ocModel = model.includes('/') ? model : `anthropic/${model}`;
      const customPromptAddition = mgr.customPrompt ? `\n\n## Custom Instructions\n${mgr.customPrompt}` : '';

      const managerPrompt = `You are the OpenProphet Manager — a configuration and research assistant.

## CRITICAL: You do NOT trade. You NEVER place orders, buy, or sell anything.

You help the user:
- Create and configure trading agents (their personality and model)
- Create and edit strategies (the rules agents follow)
- Assign agents and strategies to accounts
- Research markets, analyze stocks, gather news
- Configure heartbeats, permissions, and session modes

## Your Available Tools

**Configuration** (your primary tools):
- create_agent: Create a new agent with name, description, model, and optional custom identity prompt
- create_strategy: Create a new strategy with name, description, and trading rules (markdown)
- assign_agent_to_sandbox: Assign an agent to an account to activate it
- update_agent_prompt: Update the current account's agent identity prompt
- update_strategy_rules: Update the current account's strategy rules
- get_agent_config: View current configuration

**Research** (for helping users make informed decisions):
- analyze_stocks: Technical analysis with RSI, trend, support/resistance
- get_quote, get_latest_bar, get_historical_bars: Price data
- search_news, get_market_news, get_quick_market_intelligence: News
- find_similar_setups, get_trade_stats: Historical trade patterns

**System**:
- get_heartbeat_profiles, apply_heartbeat_profile, set_heartbeat: Heartbeat config
- update_permissions: Update trading permissions/guardrails
- get_datetime: Current time and market status

## How Agents and Strategies Work

An **Agent** is a personality — it has a name, description, model choice, and optionally a custom identity prompt that defines how it thinks and approaches trading.

A **Strategy** is a set of hard rules — position sizes, stop losses, what instruments to trade, risk limits, exit criteria. Written in markdown.

The final instructions sent to the AI = Agent Identity + Strategy Rules + System Tools/Heartbeat.

When creating an agent:
1. First create_strategy with the trading rules
2. Then create_agent with the personality, linking the strategy
3. Then assign_agent_to_sandbox to activate it on an account

## Instructions
- Be direct and actionable
- If the user describes an agent, create both the strategy and agent immediately
- Don't ask unnecessary questions — use reasonable defaults
- When creating strategies, write comprehensive markdown rules covering: what to trade, position sizing, risk management, entry/exit criteria, and any special instructions

## Current Time
${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET

## User Message
${message.trim()}${customPromptAddition}`;

      const args = ['run', '--format', 'json', '--model', ocModel];
      if (ctx.manager.sessionId) args.push('--session', ctx.manager.sessionId);

      const isNewSession = !ctx.manager.sessionId;
      const fullPrompt = isNewSession
        ? managerPrompt
        : `[Manager] User message:\n${message.trim()}`;

      // Track session
      if (isNewSession) {
        ctx.manager.sessions.push({ id: null, startTime: new Date().toISOString(), messageCount: 1, model: ocModel });
      } else {
        const last = ctx.manager.sessions[ctx.manager.sessions.length - 1];
        if (last) last.messageCount++;
      }

      // Kill any existing manager process
      if (ctx.manager.proc) { try { ctx.manager.proc.kill('SIGTERM'); } catch {} }

      const proc = spawn('opencode', args, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      ctx.manager.proc = proc;

      proc.stdin.write(fullPrompt);
      proc.stdin.end();

      // Return immediately - streaming happens via SSE
      res.json({ ok: true, streaming: true, model: ocModel });

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            const part = evt.part || {};

            if (evt.type === 'text') {
              const text = part.text || evt.text || '';
              if (text) ctx.broadcast('manager_text', { text });
            } else if (evt.type === 'tool_call') {
              const name = part.name || part.tool || evt.name || '?';
              const toolArgs = part.args || part.input || {};
              ctx.broadcast('manager_tool', { name, args: toolArgs });
            } else if (evt.type === 'tool_result') {
              const name = part.name || '?';
              const result = String(part.result || part.output || '').substring(0, 200);
              ctx.broadcast('manager_tool_result', { name, result });
            }

            // Capture session ID
            if (evt.sessionID) {
              ctx.manager.sessionId = evt.sessionID;
            }
          } catch {}
        }
      });

      proc.stderr.on('data', () => {});
      proc.on('close', () => {
        if (ctx.manager.proc === proc) ctx.manager.proc = null;
        const last = ctx.manager.sessions[ctx.manager.sessions.length - 1];
        if (last && !last.id && ctx.manager.sessionId) last.id = ctx.manager.sessionId;
        ctx.broadcast('manager_done', {});
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Chat History ─────────────────────────────────────────────────
  router.get('/chats', async (req, res) => {
    try {
      const accountId = req.query.accountId || getActiveAccount()?.id;
      if (!accountId) return res.json({ sessions: [] });
      const limit = Number(req.query.limit || 50);
      const sessions = await ctx.chatStore.listSessions(accountId, limit);
      res.json({ accountId, sessions });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/chats/all', async (req, res) => {
    try {
      const limit = Number(req.query.limit || 100);
      const sessions = await ctx.chatStore.listAllSessions(limit);
      res.json({ sessions });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/chats/:sessionId', async (req, res) => {
    try {
      const accountId = req.query.accountId || getActiveAccount()?.id;
      if (!accountId) return res.status(400).json({ error: 'No active account' });
      const session = await ctx.chatStore.getSession(accountId, req.params.sessionId);
      const messages = await ctx.chatStore.getSessionMessages(accountId, req.params.sessionId, {
        offset: Number(req.query.offset || 0),
        limit: Number(req.query.limit || 500),
      });
      res.json({ accountId, session, messages });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/chats/:sessionId', async (req, res) => {
    try {
      const accountId = req.query.accountId || getActiveAccount()?.id;
      if (!accountId) return res.status(400).json({ error: 'No active account' });
      await ctx.chatStore.deleteSession(accountId, req.params.sessionId);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
