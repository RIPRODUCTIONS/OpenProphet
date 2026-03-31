// Strategy and model routes: CRUD for strategies, model listing/activation/refresh.
import { Router } from 'express';
import { execSync } from 'child_process';
import {
  getConfig, saveConfig, getActiveSandbox,
  addStrategy, updateStrategy, removeStrategy, setActiveModel,
} from '../config-store.js';

export default function createStrategyRoutes(ctx) {
  const router = Router();

  // ── Strategies CRUD ──────────────────────────────────────────────
  router.get('/strategies', (req, res) => {
    const config = getConfig();
    res.json({ strategies: config.strategies });
  });

  router.post('/strategies', async (req, res) => {
    try {
      const strategy = await addStrategy(req.body);
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, strategy });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.put('/strategies/:id', async (req, res) => {
    try {
      const strategy = await updateStrategy(req.params.id, req.body);
      await ctx.refreshAllHarnessConfigs({ resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, strategy });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.delete('/strategies/:id', async (req, res) => {
    try {
      await removeStrategy(req.params.id);
      await ctx.refreshAllHarnessConfigs({ resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  // ── Model Selection ──────────────────────────────────────────────
  router.get('/models', (req, res) => {
    const config = getConfig();
    const allModels = config.models || [];
    const provider = req.query.provider;
    const models = provider ? allModels.filter(m => m.id.startsWith(provider + '/')) : allModels;
    const allProviders = [...new Set(allModels.map(m => m.id.split('/')[0]))];
    const filteredProviders = provider ? [provider] : allProviders;
    res.json({ models, activeModel: config.activeModel, providers: filteredProviders, allProviders });
  });

  router.post('/models/activate', async (req, res) => {
    try {
      await setActiveModel(req.body.model);
      await ctx.refreshHarnessConfigForSandbox(getActiveSandbox()?.id, { resetSession: true });
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.post('/models/refresh', async (req, res) => {
    try {
      const out = execSync('opencode models 2>&1', { encoding: 'utf-8', timeout: 10000 });
      const lines = out.trim().split('\n').filter(l => l && l.includes('/'));
      const models = [];
      const seen = new Set();

      for (const line of lines) {
        const id = line.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);

        let name = id;
        let description = '';

        if (id.startsWith('anthropic/')) {
          const model = id.replace('anthropic/', '');
          if (model.includes('opus')) {
            name = `Claude Opus ${model.replace(/[^\d.]/g, '')}`;
            description = 'Anthropic Opus model';
          } else if (model.includes('sonnet')) {
            name = `Claude Sonnet ${model.replace(/[^\d.]/g, '')}`;
            description = 'Anthropic Sonnet model';
          } else if (model.includes('haiku')) {
            name = `Claude Haiku ${model.replace(/[^\d.]/g, '')}`;
            description = 'Anthropic Haiku model';
          }
        } else if (id.startsWith('openai/')) {
          name = id.replace('openai/', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          description = 'OpenAI model';
        } else if (id.startsWith('google/')) {
          name = 'Gemini ' + id.replace('google/', '').replace(/-/g, ' ');
          description = 'Google model';
        } else if (id.startsWith('openrouter/')) {
          name = id.replace('openrouter/', '').replace(/:/g, ' ').replace(/-/g, ' ');
          description = 'OpenRouter model';
        } else if (id.startsWith('opencode/')) {
          name = id.replace('opencode/', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          description = 'OpenCode provider model';
        } else {
          name = id.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          description = 'Available model';
        }

        models.push({ id, name, description });
      }

      const config = getConfig();
      config.models = models;
      await saveConfig();
      ctx.broadcast('config', ctx.safeConfig());
      res.json({ ok: true, count: models.length });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  return router;
}
