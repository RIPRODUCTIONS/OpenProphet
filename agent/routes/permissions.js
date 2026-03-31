// Permissions and plugins routes: guardrails, plugin CRUD, Slack integration.
import { Router } from 'express';
import axios from 'axios';
import {
  getPermissions, getPermissionsForSandbox,
  updatePermissions, updatePermissionsForSandbox,
  getPlugin, getPluginForSandbox,
  updatePlugin, updatePluginForSandbox,
  getConfig,
} from '../config-store.js';

export default function createPermissionsRoutes(ctx) {
  const router = Router();

  // ── Permissions / Guardrails ─────────────────────────────────────
  router.get('/permissions', (req, res) => {
    const sandboxId = req.query.sandboxId;
    if (sandboxId) return res.json(getPermissionsForSandbox(sandboxId));
    res.json(getPermissions());
  });

  router.put('/permissions', async (req, res) => {
    try {
      const { sandboxId, ...permBody } = req.body || {};
      if (sandboxId) {
        await updatePermissionsForSandbox(sandboxId, permBody);
      } else {
        await updatePermissions(permBody);
      }
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ── Plugins ──────────────────────────────────────────────────────
  router.get('/plugins', (req, res) => {
    const config = getConfig();
    res.json(config.plugins || {});
  });

  router.get('/plugins/:name', (req, res) => {
    const sandboxId = req.query.sandboxId;
    const plugin = sandboxId ? getPluginForSandbox(sandboxId, req.params.name) : getPlugin(req.params.name);
    res.json(plugin || {});
  });

  router.put('/plugins/:name', async (req, res) => {
    try {
      const { sandboxId, ...pluginBody } = req.body || {};
      if (sandboxId) await updatePluginForSandbox(sandboxId, req.params.name, pluginBody);
      else await updatePlugin(req.params.name, pluginBody);
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/plugins/slack/test', async (req, res) => {
    try {
      const sandboxId = req.body?.sandboxId || req.query.sandboxId;
      const slack = sandboxId ? getPluginForSandbox(sandboxId, 'slack') : getPlugin('slack');
      if (!slack?.webhookUrl) return res.status(400).json({ error: 'No Slack webhook URL configured' });
      await axios.post(slack.webhookUrl, {
        text: ':robot_face: *Prophet Agent* - Test notification\nSlack integration is working!',
        channel: slack.channel || undefined,
      }, { timeout: 5000 });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Failed to send test message: ' + err.message }); }
  });

  return router;
}
