// Account routes: CRUD, activation, and auth (login/logout/status)
import { Router } from 'express';
import { execSync, spawn } from 'child_process';
import {
  getConfig, getActiveAccount,
  addAccount, removeAccount, setActiveAccount,
} from '../config-store.js';

export default function createAccountRoutes(ctx) {
  const router = Router();

  // ── Accounts CRUD ────────────────────────────────────────────────
  router.get('/accounts', (req, res) => {
    const config = getConfig();
    const safe = config.accounts.map(a => ({ ...a, secretKey: '****' + a.secretKey.slice(-4) }));
    res.json({ accounts: safe, activeId: config.activeAccountId });
  });

  router.post('/accounts', async (req, res) => {
    try {
      const account = await addAccount(req.body);
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, account: { ...account, secretKey: '****' } });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.delete('/accounts/:id', async (req, res) => {
    try {
      await removeAccount(req.params.id);
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/accounts/:id/activate', async (req, res) => {
    try {
      const nextSandboxId = `sbx_${req.params.id}`;
      const wasRunning = ctx.harness.state.running;
      if (wasRunning) await ctx.harness.stop();
      if (ctx.orchestrator.getSandboxRuntime(nextSandboxId)) {
        await ctx.orchestrator.stopSandbox(nextSandboxId);
      }
      await setActiveAccount(req.params.id);
      const account = getActiveAccount();
      ctx.rebindHarness();
      ctx.broadcast('config', ctx.safeConfig());
      // Restart Go backend with new account credentials
      if (account) {
        await ctx.migrateLegacyDataForAccount(account.id);
        ctx.broadcast('agent_log', {
          message: `Switching to account "${account.name}"... restarting trading backend.`,
          level: 'info',
          timestamp: new Date().toISOString(),
        });
        await ctx.startGoBackend(account);
        if (wasRunning) await ctx.harness.start();
      }
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ── Auth (OpenCode) ──────────────────────────────────────────────
  router.get('/auth/status', (req, res) => {
    if (process.env.ANTHROPIC_API_KEY) {
      return res.json({
        loggedIn: true,
        authMethod: 'api_key',
        provider: 'opencode',
        raw: 'ANTHROPIC_API_KEY set in environment',
      });
    }
    try {
      const out = execSync('opencode auth list 2>&1', { timeout: 5000, encoding: 'utf-8' });
      const hasAnthropicAuth = out.includes('Anthropic') && (out.includes('oauth') || out.includes('api-key'));
      res.json({
        loggedIn: hasAnthropicAuth,
        authMethod: hasAnthropicAuth ? 'opencode_oauth' : 'none',
        provider: 'opencode',
        raw: out.replace(/\x1b\[[0-9;]*m/g, '').trim(),
      });
    } catch (err) {
      const output = (err.stdout || err.stderr || err.message || '').replace(/\x1b\[[0-9;]*m/g, '');
      res.json({ loggedIn: false, provider: 'opencode', raw: output.substring(0, 200) });
    }
  });

  router.post('/auth/login', (req, res) => {
    const proc = spawn('opencode', ['auth', 'login'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'echo' },
    });

    let output = '';
    let urlSent = false;

    const sendUrl = (data) => {
      output += data.toString();
      const match = output.match(/(https:\/\/[^\s]+authorize[^\s]*)/);
      if (match && !urlSent) {
        urlSent = true;
        res.json({ ok: true, url: match[1] });
        proc.on('exit', (code) => {
          ctx.broadcast('agent_log', {
            message: code === 0 ? 'OpenCode authenticated successfully!' : 'Auth flow ended (code: ' + code + ')',
            level: code === 0 ? 'success' : 'warning',
            timestamp: new Date().toISOString(),
          });
        });
      }
    };

    proc.stdout.on('data', sendUrl);
    proc.stderr.on('data', sendUrl);

    setTimeout(() => {
      try { proc.stdin.write('\n'); } catch {}
    }, 2000);

    setTimeout(() => {
      if (!urlSent) {
        proc.kill();
        res.status(500).json({ error: 'Timed out waiting for auth URL', output: output.substring(0, 500) });
      }
    }, 15000);
  });

  router.post('/auth/logout', (req, res) => {
    try {
      execSync('opencode auth logout 2>&1', { timeout: 10000, encoding: 'utf-8' });
      ctx.broadcast('agent_log', {
        message: 'OpenCode logged out.',
        level: 'info',
        timestamp: new Date().toISOString(),
      });
      res.json({ ok: true });
    } catch (err) {
      const output = err.stdout || err.stderr || err.message || '';
      res.status(500).json({ error: 'Logout failed: ' + output.substring(0, 200) });
    }
  });

  return router;
}
