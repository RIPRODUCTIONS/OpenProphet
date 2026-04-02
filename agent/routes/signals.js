// Signal subscription routes — SSE streaming, history, performance, and subscription management.
// Separate auth from main dashboard: uses X-Signal-Key header for subscriber access.
import { Router } from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSignalEmitter } from '../lib/signal-emitter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// ── Subscription Tiers ────────────────────────────────────────────────
const TIERS = {
  free: {
    name: 'Free',
    price: 0,
    delay_ms: 15 * 60 * 1000, // 15 minute delay
    daily_limit: 5,
    features: ['Delayed signals (15min)', '5 signals/day', 'Basic performance stats'],
  },
  pro: {
    name: 'Pro',
    price: 29,
    delay_ms: 0,
    daily_limit: Infinity,
    features: ['Real-time signals', 'Unlimited signals', 'Full performance analytics', 'All strategies'],
  },
  whale: {
    name: 'Whale',
    price: 99,
    delay_ms: 0,
    daily_limit: Infinity,
    features: ['Real-time signals', 'Unlimited signals', 'Full performance analytics', 'DeFi wallet signals', 'Priority support', 'Custom alerts'],
  },
};

// ── Subscribers Database ──────────────────────────────────────────────
let subscribersDb = null;

function ensureSubscribersDb() {
  if (subscribersDb) return subscribersDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  subscribersDb = new Database(path.join(DATA_DIR, 'subscribers.db'));
  subscribersDb.pragma('journal_mode = WAL');

  subscribersDb.exec(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      active INTEGER DEFAULT 1,
      daily_count INTEGER DEFAULT 0,
      daily_reset TEXT DEFAULT (date('now')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_subscribers_api_key ON subscribers(api_key);
    CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
  `);

  return subscribersDb;
}

// ── Auth Helper ───────────────────────────────────────────────────────
function authenticateSignalKey(req) {
  const key = req.headers['x-signal-key'] || req.query.key;
  if (!key) return null;

  const db = ensureSubscribersDb();
  const subscriber = db.prepare(
    'SELECT * FROM subscribers WHERE api_key = ? AND active = 1'
  ).get(key);
  if (!subscriber) return null;

  // Reset daily count if new day
  const today = new Date().toISOString().split('T')[0];
  if (subscriber.daily_reset !== today) {
    db.prepare('UPDATE subscribers SET daily_count = 0, daily_reset = ? WHERE id = ?')
      .run(today, subscriber.id);
    subscriber.daily_count = 0;
  }

  return subscriber;
}

function incrementDailyCount(subscriberId) {
  const db = ensureSubscribersDb();
  db.prepare('UPDATE subscribers SET daily_count = daily_count + 1, updated_at = datetime(\'now\') WHERE id = ?')
    .run(subscriberId);
}

// ── Route Factory ─────────────────────────────────────────────────────
export default function createSignalsRoutes(ctx) {
  const router = Router();
  const emitter = getSignalEmitter();

  // Bind signal emitter to the active harness
  if (ctx.harness) emitter.bindHarness(ctx.harness);

  // Bootstrap existing decisive_actions on first load
  const ingested = emitter.bootstrapFromDecisiveActions();
  if (ingested > 0) {
    console.log(`  [signals] Bootstrapped ${ingested} signals from decisive_actions/`);
  }

  // Rebind when harness changes (sandbox switch)
  const origRebind = ctx.rebindHarness;
  if (origRebind) {
    ctx.rebindHarness = (...args) => {
      const result = origRebind.apply(ctx, args);
      if (ctx.harness) emitter.bindHarness(ctx.harness);
      return result;
    };
  }

  // Connected SSE signal clients (separate from main dashboard SSE)
  const signalClients = new Set();

  // Forward signals to connected SSE clients
  emitter.on('signal', (signal) => {
    if (signalClients.size === 0) return;
    const now = Date.now();

    for (const client of signalClients) {
      const tier = TIERS[client.tier] || TIERS.free;

      // Check daily limit
      if (client.dailySent >= tier.daily_limit) continue;

      // Apply delay for free tier
      if (tier.delay_ms > 0) {
        setTimeout(() => {
          if (signalClients.has(client)) {
            const msg = `event: signal\ndata: ${JSON.stringify(signal)}\n\n`;
            try { client.res.write(msg); } catch { signalClients.delete(client); }
            client.dailySent++;
            incrementDailyCount(client.subscriberId);
          }
        }, tier.delay_ms);
      } else {
        const msg = `event: signal\ndata: ${JSON.stringify(signal)}\n\n`;
        try { client.res.write(msg); } catch { signalClients.delete(client); }
        client.dailySent++;
        incrementDailyCount(client.subscriberId);
      }
    }
  });

  // ── GET /stream — SSE real-time signal stream ───────────────────────
  router.get('/stream', (req, res) => {
    const subscriber = authenticateSignalKey(req);
    if (!subscriber) {
      return res.status(401).json({ error: 'Invalid or missing X-Signal-Key header' });
    }

    const tier = TIERS[subscriber.tier] || TIERS.free;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Signal-Tier': subscriber.tier,
    });

    // Send connection confirmation
    res.write(`event: connected\ndata: ${JSON.stringify({
      tier: subscriber.tier,
      features: tier.features,
      daily_limit: tier.daily_limit === Infinity ? 'unlimited' : tier.daily_limit,
      delay_seconds: tier.delay_ms / 1000,
    })}\n\n`);

    const client = {
      res,
      tier: subscriber.tier,
      subscriberId: subscriber.id,
      dailySent: subscriber.daily_count,
      connectedAt: Date.now(),
    };

    signalClients.add(client);

    // Keepalive ping every 30s
    const keepalive = setInterval(() => {
      try { res.write(`:keepalive ${Date.now()}\n\n`); }
      catch { clearInterval(keepalive); signalClients.delete(client); }
    }, 30_000);

    req.on('close', () => {
      clearInterval(keepalive);
      signalClients.delete(client);
    });
  });

  // ── GET /history — Paginated signal history ─────────────────────────
  router.get('/history', (req, res) => {
    const subscriber = authenticateSignalKey(req);
    if (!subscriber) {
      return res.status(401).json({ error: 'Invalid or missing X-Signal-Key header' });
    }

    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 200);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const symbol = req.query.symbol || null;
    const strategy = req.query.strategy || null;
    const type = req.query.type || null;

    try {
      const result = emitter.getSignalHistory({ limit, offset, symbol, strategy, type });

      // Format for API response
      const signals = result.signals.map(s => ({
        id: s.signal_id,
        type: s.type,
        symbol: s.symbol,
        confidence: s.confidence,
        reasoning: s.reasoning,
        strategy: s.strategy,
        timestamp: s.timestamp,
        price_target: s.price_target,
        stop_loss: s.stop_loss,
        entry_price: s.entry_price,
        source: s.source,
        outcome: s.pnl !== null ? {
          exit_price: s.exit_price,
          pnl: s.pnl,
          pnl_pct: s.pnl_pct,
          hit_target: !!s.hit_target,
          hit_stop: !!s.hit_stop,
          duration_seconds: s.duration_seconds,
          closed_at: s.closed_at,
        } : null,
      }));

      res.json({
        signals,
        pagination: {
          total: result.total,
          limit: result.limit,
          offset: result.offset,
          has_more: result.offset + result.limit < result.total,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /performance — Signal track record ──────────────────────────
  router.get('/performance', (req, res) => {
    const subscriber = authenticateSignalKey(req);
    if (!subscriber) {
      return res.status(401).json({ error: 'Invalid or missing X-Signal-Key header' });
    }

    // Free tier gets limited performance data
    const strategy = req.query.strategy || null;

    try {
      const perf = emitter.getPerformance({ strategy });

      if (subscriber.tier === 'free') {
        // Redact strategy breakdown for free users
        res.json({
          total_signals: perf.total_signals,
          closed_trades: perf.closed_trades,
          win_rate: perf.win_rate,
          computed_at: perf.computed_at,
          upgrade_for_full: true,
        });
      } else {
        res.json(perf);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /subscribe — Create subscription ───────────────────────────
  router.post('/subscribe', (req, res) => {
    const { email, tier = 'free' } = req.body || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    if (!TIERS[tier]) {
      return res.status(400).json({
        error: `Invalid tier. Choose from: ${Object.keys(TIERS).join(', ')}`,
      });
    }

    const db = ensureSubscribersDb();

    // Check if email already subscribed
    const existing = db.prepare('SELECT api_key, tier FROM subscribers WHERE email = ? AND active = 1').get(email);
    if (existing) {
      return res.json({
        ok: true,
        message: 'Already subscribed',
        api_key: existing.api_key,
        tier: existing.tier,
      });
    }

    // Generate API key
    const apiKey = `sig_${tier}_${crypto.randomBytes(24).toString('hex')}`;

    try {
      db.prepare(
        'INSERT INTO subscribers (api_key, email, tier) VALUES (?, ?, ?)'
      ).run(apiKey, email.toLowerCase().trim(), tier);

      const tierInfo = TIERS[tier];

      res.status(201).json({
        ok: true,
        api_key: apiKey,
        tier,
        price: tierInfo.price > 0 ? `$${tierInfo.price}/mo` : 'Free',
        features: tierInfo.features,
        usage: {
          daily_limit: tierInfo.daily_limit === Infinity ? 'unlimited' : tierInfo.daily_limit,
          delay_seconds: tierInfo.delay_ms / 1000,
        },
        instructions: {
          stream: 'GET /api/signals/stream with header X-Signal-Key: <your-key>',
          history: 'GET /api/signals/history?limit=50&offset=0 with header X-Signal-Key: <your-key>',
          performance: 'GET /api/signals/performance with header X-Signal-Key: <your-key>',
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /pricing — Public pricing page data ─────────────────────────
  router.get('/pricing', (req, res) => {
    const pricing = Object.entries(TIERS).map(([id, tier]) => ({
      id,
      name: tier.name,
      price: tier.price,
      price_label: tier.price > 0 ? `$${tier.price}/mo` : 'Free',
      delay_seconds: tier.delay_ms / 1000,
      daily_limit: tier.daily_limit === Infinity ? 'unlimited' : tier.daily_limit,
      features: tier.features,
    }));

    const db = ensureSubscribersDb();
    const stats = db.prepare('SELECT COUNT(*) as total FROM subscribers WHERE active = 1').get();

    res.json({
      tiers: pricing,
      subscriber_count: stats.total,
      currency: 'USD',
      billing_period: 'monthly',
    });
  });

  return router;
}
