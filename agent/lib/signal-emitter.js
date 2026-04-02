// Signal Emitter — hooks into harness events to capture, store, and emit trade signals.
// Reads tool_call events (buy/sell orders) and decisive_actions/ JSON files.
// Stores signals in SQLite and tracks outcomes when positions close.

import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DECISIVE_ACTIONS_DIR = path.join(__dirname, '..', '..', 'decisive_actions');

// Actions from decisive_actions/ that map to trade signals
const ACTION_TO_SIGNAL = {
  BUY:          'BUY',
  BUY_SCALP:    'BUY',
  SELL:         'SELL',
  SELL_PREMIUM: 'SELL',
  CLOSE:        'SELL',
  PASS:         'HOLD',
  VETO:         'HOLD',
  STRATEGIC_VETO:     'HOLD',
  STAND_DOWN:         'HOLD',
  OVERRIDE:           'HOLD',
  STRATEGIC_PLAN:     'HOLD',
  STRATEGIC_ASSESSMENT: 'HOLD',
  ASSESSMENT:         'HOLD',
};

// Tool names that represent trade actions
const BUY_TOOLS = new Set([
  'place_buy_order', 'place_managed_position', 'place_options_order', 'place_crypto_order',
]);
const SELL_TOOLS = new Set([
  'place_sell_order', 'close_managed_position', 'cancel_order', 'close_all_crypto_orders',
]);

export class SignalEmitter extends EventEmitter {
  constructor() {
    super();
    this._db = null;
    this._lastDecisiveActionScan = null;
    this._boundHarnesses = new WeakSet();
  }

  // ── Database Setup ──────────────────────────────────────────────────
  _ensureDb() {
    if (this._db) return this._db;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    this._db = new Database(path.join(DATA_DIR, 'signals.db'));
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');

    this._db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('BUY','SELL','HOLD')),
        symbol TEXT,
        confidence REAL DEFAULT 0.5,
        reasoning TEXT,
        strategy TEXT,
        timestamp TEXT NOT NULL,
        price_target REAL,
        stop_loss REAL,
        entry_price REAL,
        source TEXT DEFAULT 'agent',
        sandbox_id TEXT,
        beat_number INTEGER,
        tool_name TEXT,
        tool_args TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS signal_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL REFERENCES signals(signal_id),
        exit_price REAL,
        pnl REAL,
        pnl_pct REAL,
        hit_target INTEGER DEFAULT 0,
        hit_stop INTEGER DEFAULT 0,
        duration_seconds INTEGER,
        closed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);
      CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
      CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
      CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy);
      CREATE INDEX IF NOT EXISTS idx_outcomes_signal ON signal_outcomes(signal_id);
    `);

    return this._db;
  }

  // ── Harness Integration ─────────────────────────────────────────────
  bindHarness(harness) {
    if (this._boundHarnesses.has(harness)) return;
    this._boundHarnesses.add(harness);

    // Listen for tool_call events — these are the actual order placements
    harness.state.on('tool_call', (data) => {
      this._handleToolCall(data, harness);
    });

    // On beat_end, scan for new decisive_action files
    harness.state.on('beat_end', (data) => {
      this._scanDecisiveActions(harness);
    });

    // Listen for trade events (already structured)
    harness.state.on('trade', (data) => {
      this._handleTradeEvent(data, harness);
    });
  }

  // ── Tool Call → Signal ──────────────────────────────────────────────
  _handleToolCall(data, harness) {
    const { name, args = {}, beat } = data;
    if (!name) return;

    let signalType = null;
    if (BUY_TOOLS.has(name) || (name.includes('buy') && !name.includes('get'))) {
      signalType = 'BUY';
    } else if (SELL_TOOLS.has(name) || (name.includes('sell') && !name.includes('get'))) {
      signalType = 'SELL';
    }
    if (!signalType) return;

    const symbol = args.symbol || args.ticker || null;
    const signal = {
      signal_id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: signalType,
      symbol,
      confidence: 0.7, // tool calls are committed actions
      reasoning: `${signalType} via ${name}: ${symbol || 'unknown'} qty=${args.quantity || args.qty || '?'}`,
      strategy: harness._agentConfig?.strategyId || harness._agentConfig?.name || null,
      timestamp: new Date().toISOString(),
      price_target: args.limit_price || args.price || null,
      stop_loss: args.stop_price || args.stop_loss || null,
      entry_price: args.limit_price || args.price || null,
      source: 'tool_call',
      sandbox_id: harness.sandboxId,
      beat_number: beat,
      tool_name: name,
      tool_args: JSON.stringify(args),
    };

    this._storeSignal(signal);
    this.emit('signal', signal);
  }

  // ── Trade Event → Outcome Tracking ──────────────────────────────────
  _handleTradeEvent(data, harness) {
    // Trade events from harness.state.addTrade() — these are order fills
    // Check if this is a closing trade to record outcome
    const { tool, symbol, side } = data;
    if (!symbol || symbol === '??') return;

    if (side === 'sell' || tool?.includes('sell') || tool?.includes('close')) {
      this._tryRecordOutcome(symbol, data);
    }
  }

  _tryRecordOutcome(symbol, tradeData) {
    const db = this._ensureDb();
    // Find the most recent open BUY signal for this symbol without an outcome
    const openSignal = db.prepare(`
      SELECT s.signal_id, s.entry_price, s.price_target, s.stop_loss, s.timestamp
      FROM signals s
      LEFT JOIN signal_outcomes o ON s.signal_id = o.signal_id
      WHERE s.symbol = ? AND s.type = 'BUY' AND o.id IS NULL
      ORDER BY s.timestamp DESC LIMIT 1
    `).get(symbol);

    if (!openSignal) return;

    const exitPrice = tradeData.price || tradeData.limit_price || null;
    const entryPrice = openSignal.entry_price;
    let pnl = null;
    let pnlPct = null;
    let hitTarget = 0;
    let hitStop = 0;

    if (exitPrice && entryPrice) {
      pnl = exitPrice - entryPrice;
      pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
      if (openSignal.price_target && exitPrice >= openSignal.price_target) hitTarget = 1;
      if (openSignal.stop_loss && exitPrice <= openSignal.stop_loss) hitStop = 1;
    }

    const entryTime = new Date(openSignal.timestamp).getTime();
    const durationSeconds = Math.floor((Date.now() - entryTime) / 1000);

    db.prepare(`
      INSERT INTO signal_outcomes (signal_id, exit_price, pnl, pnl_pct, hit_target, hit_stop, duration_seconds, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(openSignal.signal_id, exitPrice, pnl, pnlPct, hitTarget, hitStop, durationSeconds);

    this.emit('outcome', { signal_id: openSignal.signal_id, symbol, pnl, pnlPct, hitTarget, hitStop });
  }

  // ── Decisive Actions Scanner ────────────────────────────────────────
  _scanDecisiveActions(harness) {
    if (!fs.existsSync(DECISIVE_ACTIONS_DIR)) return;

    const cutoff = this._lastDecisiveActionScan || new Date(Date.now() - 60_000).toISOString();
    this._lastDecisiveActionScan = new Date().toISOString();

    let files;
    try {
      files = fs.readdirSync(DECISIVE_ACTIONS_DIR).filter(f => f.endsWith('.json')).sort();
    } catch { return; }

    for (const file of files) {
      // Filename format: 2025-11-20T16-14-37-978Z_BUY_SPY.json
      // Extract timestamp from filename
      const tsMatch = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
      if (!tsMatch) continue;

      const fileTs = tsMatch[1].replace(/-(\d{2})Z/, '.$1Z').replace(/-/g, (m, offset) => {
        // Replace hyphens in time portion with colons: T16-14-37 → T16:14:37
        return offset > 9 ? ':' : '-';
      });
      // Rough comparison — only process files newer than last scan
      if (fileTs < cutoff.replace(/[:.]/g, '-')) continue;

      try {
        const raw = fs.readFileSync(path.join(DECISIVE_ACTIONS_DIR, file), 'utf-8');
        const action = JSON.parse(raw);
        this._processDecisiveAction(action, file, harness);
      } catch { /* skip malformed files */ }
    }
  }

  _processDecisiveAction(action, filename, harness) {
    const signalId = `da_${filename.replace('.json', '').replace(/[^a-zA-Z0-9]/g, '_')}`;

    // Check if already stored
    const db = this._ensureDb();
    const exists = db.prepare('SELECT 1 FROM signals WHERE signal_id = ?').get(signalId);
    if (exists) return;

    const actionType = (action.action || '').replace(/\s+/g, '_').toUpperCase();
    const signalType = ACTION_TO_SIGNAL[actionType] || 'HOLD';
    const md = action.market_data || {};

    // Extract price info from market_data
    const entryPrice = md.entry || md.entry_price || md.spy_current || md.pltr_price || null;
    const target = md.target || md.price_target || null;
    const stopLoss = md.stop || md.stop_loss || md.stop_level || null;

    // Estimate confidence from action type
    let confidence = 0.5;
    if (signalType === 'BUY' || signalType === 'SELL') {
      confidence = md.risk_reward ? Math.min(0.9, 0.5 + md.risk_reward * 0.1) : 0.7;
    } else if (actionType === 'VETO' || actionType === 'STRATEGIC_VETO') {
      confidence = 0.8; // high confidence in NOT trading
    }

    const signal = {
      signal_id: signalId,
      type: signalType,
      symbol: action.symbol || null,
      confidence,
      reasoning: action.reasoning || null,
      strategy: harness._agentConfig?.strategyId || null,
      timestamp: action.timestamp || new Date().toISOString(),
      price_target: target,
      stop_loss: stopLoss,
      entry_price: entryPrice,
      source: 'decisive_action',
      sandbox_id: harness.sandboxId,
      beat_number: null,
      tool_name: actionType,
      tool_args: JSON.stringify(md),
    };

    this._storeSignal(signal);
    this.emit('signal', signal);
  }

  // ── Storage ─────────────────────────────────────────────────────────
  _storeSignal(signal) {
    const db = this._ensureDb();
    try {
      db.prepare(`
        INSERT OR IGNORE INTO signals
          (signal_id, type, symbol, confidence, reasoning, strategy, timestamp,
           price_target, stop_loss, entry_price, source, sandbox_id, beat_number,
           tool_name, tool_args)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.signal_id, signal.type, signal.symbol, signal.confidence,
        signal.reasoning, signal.strategy, signal.timestamp,
        signal.price_target, signal.stop_loss, signal.entry_price,
        signal.source, signal.sandbox_id, signal.beat_number,
        signal.tool_name, signal.tool_args,
      );
    } catch (err) {
      console.error('[signal-emitter] Failed to store signal:', err.message);
    }
  }

  // ── Query Methods ───────────────────────────────────────────────────
  getSignalHistory({ limit = 50, offset = 0, symbol, strategy, type } = {}) {
    const db = this._ensureDb();
    let where = [];
    let params = [];

    if (symbol) { where.push('s.symbol = ?'); params.push(symbol.toUpperCase()); }
    if (strategy) { where.push('s.strategy = ?'); params.push(strategy); }
    if (type) { where.push('s.type = ?'); params.push(type.toUpperCase()); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const signals = db.prepare(`
      SELECT s.*,
        o.exit_price, o.pnl, o.pnl_pct, o.hit_target, o.hit_stop,
        o.duration_seconds, o.closed_at
      FROM signals s
      LEFT JOIN signal_outcomes o ON s.signal_id = o.signal_id
      ${whereClause}
      ORDER BY s.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = db.prepare(`SELECT COUNT(*) as count FROM signals s ${whereClause}`).get(...params);

    return { signals, total: total.count, limit, offset };
  }

  getPerformance({ strategy } = {}) {
    const db = this._ensureDb();

    let whereBase = "s.type IN ('BUY', 'SELL')";
    let params = [];
    if (strategy) {
      whereBase += ' AND s.strategy = ?';
      params.push(strategy);
    }

    // Overall stats
    const totalSignals = db.prepare(
      `SELECT COUNT(*) as count FROM signals s WHERE ${whereBase}`
    ).get(...params).count;

    const tradeSignals = db.prepare(
      `SELECT COUNT(*) as count FROM signals s WHERE ${whereBase} AND s.type IN ('BUY','SELL')`
    ).get(...params).count;

    const closedTrades = db.prepare(`
      SELECT COUNT(*) as count FROM signals s
      INNER JOIN signal_outcomes o ON s.signal_id = o.signal_id
      WHERE ${whereBase}
    `).get(...params).count;

    const outcomes = db.prepare(`
      SELECT o.pnl, o.pnl_pct, o.hit_target, o.hit_stop, o.duration_seconds
      FROM signals s
      INNER JOIN signal_outcomes o ON s.signal_id = o.signal_id
      WHERE ${whereBase}
      ORDER BY o.closed_at ASC
    `).all(...params);

    const wins = outcomes.filter(o => o.pnl > 0).length;
    const losses = outcomes.filter(o => o.pnl <= 0).length;
    const winRate = closedTrades > 0 ? (wins / closedTrades) * 100 : 0;

    const returns = outcomes.map(o => o.pnl_pct || 0);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const avgDuration = outcomes.length > 0
      ? outcomes.reduce((a, o) => a + (o.duration_seconds || 0), 0) / outcomes.length
      : 0;

    // Sharpe ratio (annualized, assuming daily returns)
    const sharpe = this._computeSharpe(returns);

    // Max drawdown from cumulative returns
    const maxDrawdown = this._computeMaxDrawdown(returns);

    // Per-strategy breakdown
    const strategies = db.prepare(`
      SELECT DISTINCT s.strategy FROM signals s WHERE s.strategy IS NOT NULL
    `).all().map(r => r.strategy);

    const strategyBreakdown = {};
    for (const strat of strategies) {
      if (strategy && strat !== strategy) continue;
      const stratOutcomes = db.prepare(`
        SELECT o.pnl, o.pnl_pct, o.hit_target, o.hit_stop
        FROM signals s
        INNER JOIN signal_outcomes o ON s.signal_id = o.signal_id
        WHERE s.strategy = ? AND s.type IN ('BUY','SELL')
      `).all(strat);

      const sWins = stratOutcomes.filter(o => o.pnl > 0).length;
      const sTotal = stratOutcomes.length;
      const sReturns = stratOutcomes.map(o => o.pnl_pct || 0);

      strategyBreakdown[strat] = {
        total_signals: db.prepare(
          `SELECT COUNT(*) as c FROM signals WHERE strategy = ? AND type IN ('BUY','SELL')`
        ).get(strat).c,
        closed_trades: sTotal,
        win_rate: sTotal > 0 ? (sWins / sTotal) * 100 : 0,
        avg_return: sReturns.length > 0 ? sReturns.reduce((a, b) => a + b, 0) / sReturns.length : 0,
        sharpe: this._computeSharpe(sReturns),
        max_drawdown: this._computeMaxDrawdown(sReturns),
      };
    }

    return {
      total_signals: totalSignals,
      trade_signals: tradeSignals,
      closed_trades: closedTrades,
      open_trades: tradeSignals - closedTrades,
      wins,
      losses,
      win_rate: Math.round(winRate * 100) / 100,
      avg_return: Math.round(avgReturn * 10000) / 10000,
      avg_duration_seconds: Math.round(avgDuration),
      sharpe: Math.round(sharpe * 100) / 100,
      max_drawdown: Math.round(maxDrawdown * 100) / 100,
      strategies: strategyBreakdown,
      computed_at: new Date().toISOString(),
    };
  }

  _computeSharpe(returns) {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    // Annualize assuming ~252 trading days
    return (mean / stdDev) * Math.sqrt(252);
  }

  _computeMaxDrawdown(returns) {
    if (returns.length === 0) return 0;
    let cumulative = 0;
    let peak = 0;
    let maxDd = 0;
    for (const r of returns) {
      cumulative += r;
      if (cumulative > peak) peak = cumulative;
      const dd = peak - cumulative;
      if (dd > maxDd) maxDd = dd;
    }
    return maxDd;
  }

  // ── Bootstrap: Ingest existing decisive_actions/ on first run ───────
  bootstrapFromDecisiveActions() {
    if (!fs.existsSync(DECISIVE_ACTIONS_DIR)) return 0;

    let files;
    try {
      files = fs.readdirSync(DECISIVE_ACTIONS_DIR).filter(f => f.endsWith('.json')).sort();
    } catch { return 0; }

    const db = this._ensureDb();
    let ingested = 0;
    const dummyHarness = { sandboxId: null, _agentConfig: { name: 'bootstrap' } };

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(DECISIVE_ACTIONS_DIR, file), 'utf-8');
        const action = JSON.parse(raw);
        const signalId = `da_${file.replace('.json', '').replace(/[^a-zA-Z0-9]/g, '_')}`;
        const exists = db.prepare('SELECT 1 FROM signals WHERE signal_id = ?').get(signalId);
        if (!exists) {
          this._processDecisiveAction(action, file, dummyHarness);
          ingested++;
        }
      } catch { /* skip */ }
    }

    // Match BUY→SELL pairs from decisive_actions for outcome tracking
    this._matchDecisiveActionPairs();
    return ingested;
  }

  _matchDecisiveActionPairs() {
    const db = this._ensureDb();
    // Find BUY signals followed by SELL signals for the same symbol
    const buys = db.prepare(`
      SELECT s.signal_id, s.symbol, s.entry_price, s.price_target, s.stop_loss, s.timestamp
      FROM signals s
      LEFT JOIN signal_outcomes o ON s.signal_id = o.signal_id
      WHERE s.type = 'BUY' AND s.source = 'decisive_action' AND s.symbol IS NOT NULL AND o.id IS NULL
      ORDER BY s.timestamp ASC
    `).all();

    for (const buy of buys) {
      const sell = db.prepare(`
        SELECT s.signal_id, s.entry_price, s.timestamp,
          json_extract(s.tool_args, '$.exit') as exit_price,
          json_extract(s.tool_args, '$.loss') as loss
        FROM signals s
        WHERE s.type = 'SELL' AND s.symbol = ? AND s.timestamp > ?
          AND s.source = 'decisive_action'
        ORDER BY s.timestamp ASC LIMIT 1
      `).get(buy.symbol, buy.timestamp);

      if (!sell) continue;

      const exitPrice = sell.exit_price || sell.entry_price;
      if (!exitPrice || !buy.entry_price) continue;

      const pnl = exitPrice - buy.entry_price;
      const pnlPct = ((exitPrice - buy.entry_price) / buy.entry_price) * 100;
      const hitTarget = buy.price_target && exitPrice >= buy.price_target ? 1 : 0;
      const hitStop = buy.stop_loss && exitPrice <= buy.stop_loss ? 1 : 0;
      const duration = Math.floor(
        (new Date(sell.timestamp).getTime() - new Date(buy.timestamp).getTime()) / 1000
      );

      try {
        db.prepare(`
          INSERT OR IGNORE INTO signal_outcomes
            (signal_id, exit_price, pnl, pnl_pct, hit_target, hit_stop, duration_seconds, closed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(buy.signal_id, exitPrice, pnl, pnlPct, hitTarget, hitStop, duration, sell.timestamp);
      } catch { /* skip duplicates */ }
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────
  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

// Singleton
let instance = null;
export function getSignalEmitter() {
  if (!instance) {
    instance = new SignalEmitter();
  }
  return instance;
}
