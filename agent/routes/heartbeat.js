// Heartbeat configuration routes: get/set heartbeat, profiles, phases, manual override.
import { Router } from 'express';
import {
  getConfig, getActiveSandbox, getSandbox,
  updateHeartbeat, updateHeartbeatForSandbox,
  getHeartbeatProfiles, getPhaseTimeRanges, applyHeartbeatProfile, updatePhaseTimeRange,
} from '../config-store.js';

export default function createHeartbeatRoutes(ctx) {
  const router = Router();

  // Manual heartbeat override (from agent or UI)
  router.post('/agent/heartbeat', (req, res) => {
    const { seconds, reason, sandboxId } = req.body;
    if (!seconds || seconds < 30 || seconds > 3600) return res.status(400).json({ error: 'seconds must be 30-3600' });
    const targetHarness = ctx.getHarnessForSandbox(sandboxId);
    if (!targetHarness) return res.status(404).json({ error: 'Sandbox harness not found' });
    targetHarness.state.heartbeatOverride = { seconds, reason: reason || 'Manual override', oneTime: false };
    targetHarness.state.emit('heartbeat_change', { seconds, reason: reason || 'Manual override from UI', sandboxId: sandboxId || targetHarness.sandboxId });
    res.json({ ok: true, seconds });
  });

  // Heartbeat config
  router.get('/heartbeat', (req, res) => {
    const sandboxId = req.query.sandboxId;
    if (sandboxId) {
      return res.json(getSandbox(sandboxId)?.heartbeat || {});
    }
    const config = getConfig();
    res.json(config.heartbeat || {});
  });

  router.put('/heartbeat', async (req, res) => {
    try {
      const { sandboxId, ...heartbeatBody } = req.body || {};
      if (sandboxId) {
        await updateHeartbeatForSandbox(sandboxId, heartbeatBody);
      } else {
        await updateHeartbeat(heartbeatBody);
      }
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.get('/heartbeat/profiles', (req, res) => {
    res.json({ profiles: getHeartbeatProfiles() });
  });

  router.post('/heartbeat/apply-profile', async (req, res) => {
    try {
      const { sandboxId, profile } = req.body || {};
      const targetSandbox = sandboxId || getActiveSandbox()?.id;
      if (!targetSandbox) throw new Error('No active sandbox');
      await applyHeartbeatProfile(targetSandbox, profile);
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, profile, sandboxId: targetSandbox });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.get('/heartbeat/phases', (req, res) => {
    res.json({ phases: getPhaseTimeRanges() });
  });

  router.put('/heartbeat/phases', async (req, res) => {
    try {
      const { phase, start, end } = req.body || {};
      if (!phase) throw new Error('Phase is required');
      await updatePhaseTimeRange(phase, { start, end });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, phases: getPhaseTimeRanges() });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  return router;
}
