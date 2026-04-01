/**
 * execution-tracker.js — Trade execution quality analyzer for the OpenProphet trading system.
 *
 * Tracks every order's execution quality — slippage, fill timing, price improvement.
 * Persists data to disk. The agent and operator can query performance to identify
 * systematic execution problems.
 *
 * Exports:
 *   ExecutionTracker                             — main class
 *   createExecutionTracker(dataDir)              — singleton factory
 *   getExecutionToolDefinitions()                — MCP tool schemas
 *   handleExecutionToolCall(name, args, tracker) — dispatcher for CallToolRequestSchema
 *
 * @module execution-tracker
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import crypto from 'crypto';

const MAX_RECORDS = 10_000;
const TREND_WINDOW = 20;
const WORST_FILLS_COUNT = 5;

// ---------------------------------------------------------------------------
// Response helpers — match mcp-server.js / crypto-tools.js format
// ---------------------------------------------------------------------------

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** @param {number[]} sorted — pre-sorted ascending */
function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Safe percentage — returns 0 when denominator is 0. */
function safePct(numerator, denominator) {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

/** Average of a numeric array. Returns 0 for empty. */
function avg(arr) {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Round to N decimal places. */
function round(val, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

// ---------------------------------------------------------------------------
// ExecutionTracker
// ---------------------------------------------------------------------------

class ExecutionTracker {
  /** @param {string} [dataDir] — directory for persistent state */
  constructor(dataDir = join(process.cwd(), 'data')) {
    this.dataDir = dataDir;
    this.stateFile = join(dataDir, 'execution_log.json');
    this.records = [];
    this._load();
  }

  // ─── Persistence ─────────────────────────────────────────────────────

  /** @private Load existing records from disk, or start empty. */
  _load() {
    try {
      const raw = readFileSync(this.stateFile, 'utf-8');
      const parsed = JSON.parse(raw);
      this.records = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.records = [];
    }
  }

  /** @private Persist current records to disk. Creates data dir if needed. */
  _save() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[execution-tracker] Failed to save state: ${err.message}`);
    }
  }

  /** @private Trim records to MAX_RECORDS, dropping the oldest. */
  _trimIfNeeded() {
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(this.records.length - MAX_RECORDS);
    }
  }

  // ─── Recording ───────────────────────────────────────────────────────

  /**
   * Record a newly placed order.
   * @param {object} order
   * @param {string} order.orderId — from Alpaca response
   * @param {string} order.symbol
   * @param {string} order.side    — 'buy' | 'sell'
   * @param {number} order.qty
   * @param {string} order.type    — 'market' | 'limit' | 'stop'
   * @param {number} [order.limitPrice]
   * @param {number} [order.bid]   — market bid when order placed
   * @param {number} [order.ask]   — market ask when order placed
   * @returns {object} the created execution record
   */
  recordOrder(order) {
    const bid = order.bid ?? 0;
    const ask = order.ask ?? 0;
    const midAtPlace = bid && ask ? (bid + ask) / 2 : 0;

    const record = {
      id: crypto.randomUUID(),       orderId: order.orderId,
      symbol: order.symbol,          side: order.side,
      qty: Number(order.qty),        type: order.type,
      limitPrice: order.limitPrice ?? null,
      placedAt: Date.now(),
      bidAtPlace: bid,               askAtPlace: ask,
      midAtPlace: round(midAtPlace, 6),
      status: 'pending',
      // Fill fields — populated later by recordFill()
      fillPrice: null,   filledAt: null,      filledQty: null,
      slippagePct: null,  slippageFromMid: null,
      fillTimeMs: null,   priceImprovement: null,
    };

    this.records.push(record);
    this._trimIfNeeded();
    this._save();

    return record;
  }

  /**
   * Record a fill for a previously placed order.
   * @param {string} orderId — the Alpaca order ID
   * @param {object} fill
   * @param {number} fill.price — actual fill price
   * @param {number} [fill.qty] — filled quantity (defaults to order qty)
   * @returns {object|null} updated record, or null if orderId not found
   */
  recordFill(orderId, fill) {
    const record = this._findByOrderId(orderId);
    if (!record) {
      console.error(`[execution-tracker] recordFill: orderId "${orderId}" not found`);
      return null;
    }

    const filledAt = Date.now();
    const fillPrice = Number(fill.price);
    const filledQty = fill.qty != null ? Number(fill.qty) : record.qty;

    record.fillPrice = fillPrice;
    record.filledAt = filledAt;
    record.filledQty = filledQty;
    record.status = 'filled';
    record.fillTimeMs = filledAt - record.placedAt;

    // Slippage from limit price
    if (record.limitPrice && record.limitPrice > 0) {
      const rawSlippage = fillPrice - record.limitPrice;
      // For buys, positive slippage = worse (paid more than limit)
      // For sells, negative slippage = worse (received less than limit)
      const signedSlippage = record.side === 'sell' ? -rawSlippage : rawSlippage;
      record.slippagePct = round(safePct(signedSlippage, record.limitPrice));
    } else {
      record.slippagePct = null;
    }

    // Slippage from mid price at placement
    if (record.midAtPlace && record.midAtPlace > 0) {
      const rawMidSlippage = fillPrice - record.midAtPlace;
      const signedMidSlippage = record.side === 'sell' ? -rawMidSlippage : rawMidSlippage;
      record.slippageFromMid = round(safePct(signedMidSlippage, record.midAtPlace));
    } else {
      record.slippageFromMid = null;
    }

    // Price improvement: did we get a better price than the limit?
    if (record.limitPrice && record.limitPrice > 0) {
      record.priceImprovement = record.side === 'buy'
        ? fillPrice < record.limitPrice
        : fillPrice > record.limitPrice;
    } else {
      record.priceImprovement = null;
    }

    this._save();
    return record;
  }

  /**
   * Find a record by its Alpaca orderId. Searches newest-first.
   * @private
   */
  _findByOrderId(orderId) {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].orderId === orderId) return this.records[i];
    }
    return null;
  }

  // ─── Queries ─────────────────────────────────────────────────────────

  /**
   * Get aggregate execution quality statistics.
   * @param {object} [filter]
   * @param {string} [filter.symbol]  — filter to a specific symbol
   * @param {string} [filter.side]    — 'buy' | 'sell'
   * @param {string} [filter.type]    — 'market' | 'limit' | 'stop'
   * @param {number} [filter.since]   — epoch ms or ISO string lower bound
   * @param {number} [filter.until]   — epoch ms or ISO string upper bound
   * @returns {object} execution statistics
   */
  getExecutionStats(filter = {}) {
    const filtered = this._applyFilter(this.records, filter);
    const filled = filtered.filter(r => r.status === 'filled');

    // ── Aggregate slippage values ──
    const slippages = filled.map(r => r.slippagePct).filter(v => v != null);
    const midSlippages = filled.map(r => r.slippageFromMid).filter(v => v != null);
    const fillTimes = filled.map(r => r.fillTimeMs).filter(v => v != null);
    const sortedFillTimes = [...fillTimes].sort((a, b) => a - b);

    const totalSlippageDollars = filled.reduce((sum, r) => {
      if (r.slippagePct == null || !r.fillPrice) return sum;
      return sum + (Math.abs(r.slippagePct) / 100) * r.fillPrice * r.filledQty;
    }, 0);

    const withLimits = filled.filter(r => r.priceImprovement != null);
    const improved = withLimits.filter(r => r.priceImprovement === true);

    // ── Breakdowns ──
    const byType = this._buildBreakdown(filtered, filled, 'type', ['market', 'limit', 'stop']);
    const bySide = this._buildBreakdown(filtered, filled, 'side', ['buy', 'sell']);
    const bySymbol = this._buildSymbolBreakdown(filled);

    // ── Worst fills (highest slippage) ──
    const worstFills = [...filled]
      .filter(r => r.slippagePct != null)
      .sort((a, b) => b.slippagePct - a.slippagePct)
      .slice(0, WORST_FILLS_COUNT)
      .map(({ orderId, symbol, side, type, slippagePct, fillPrice, limitPrice, midAtPlace, fillTimeMs }) => ({
        orderId, symbol, side, type, slippagePct, fillPrice, limitPrice, midAtPlace, fillTimeMs,
      }));

    // ── Recent trend ──
    return {
      totalOrders: filtered.length,
      filledOrders: filled.length,
      fillRate: round(safePct(filled.length, filtered.length), 2),
      avgSlippagePct: round(avg(slippages)),
      avgSlippageFromMid: round(avg(midSlippages)),
      avgFillTimeMs: Math.round(avg(fillTimes)),
      medianFillTimeMs: Math.round(median(sortedFillTimes)),
      totalSlippageDollars: round(totalSlippageDollars, 2),
      priceImprovementRate: round(safePct(improved.length, withLimits.length), 2),
      byType, bySide, bySymbol, worstFills,
      recentTrend: this._computeTrend(filled),
    };
  }

  /** Return the last N execution records (newest first). */
  getRecentExecutions(n = 10) {
    return this.records.slice(-n).reverse();
  }

  // ─── Internal helpers ────────────────────────────────────────────────

  /** @private Apply filter criteria to records. */
  _applyFilter(records, filter) {
    let result = records;

    if (filter.symbol) {
      const sym = filter.symbol.toUpperCase();
      result = result.filter(r => r.symbol?.toUpperCase() === sym);
    }
    if (filter.side) {
      const side = filter.side.toLowerCase();
      result = result.filter(r => r.side?.toLowerCase() === side);
    }
    if (filter.type) {
      const type = filter.type.toLowerCase();
      result = result.filter(r => r.type?.toLowerCase() === type);
    }
    if (filter.since) {
      const since = typeof filter.since === 'string' ? new Date(filter.since).getTime() : filter.since;
      result = result.filter(r => r.placedAt >= since);
    }
    if (filter.until) {
      const until = typeof filter.until === 'string' ? new Date(filter.until).getTime() : filter.until;
      result = result.filter(r => r.placedAt <= until);
    }

    return result;
  }

  /** @private Build a breakdown by a categorical field (type or side). */
  _buildBreakdown(allRecords, filledRecords, field, categories) {
    const breakdown = {};

    for (const cat of categories) {
      const allForCat = allRecords.filter(r => r[field]?.toLowerCase() === cat);
      const filledForCat = filledRecords.filter(r => r[field]?.toLowerCase() === cat);
      const slippages = filledForCat.map(r => r.slippagePct).filter(v => v != null);

      const entry = {
        count: filledForCat.length,
        avgSlippage: round(avg(slippages)),
      };

      // Add fillRate for limit orders (where unfilled orders are meaningful)
      if (cat === 'limit') {
        entry.fillRate = round(safePct(filledForCat.length, allForCat.length), 2);
      }

      breakdown[cat] = entry;
    }

    return breakdown;
  }

  /** @private Build per-symbol breakdown from filled records. */
  _buildSymbolBreakdown(filledRecords) {
    const bySymbol = {};

    for (const r of filledRecords) {
      const sym = r.symbol || 'UNKNOWN';
      if (!bySymbol[sym]) {
        bySymbol[sym] = { count: 0, slippages: [], totalSlippageDollars: 0 };
      }

      const entry = bySymbol[sym];
      entry.count++;

      if (r.slippagePct != null) {
        entry.slippages.push(r.slippagePct);
      }
      if (r.slippagePct != null && r.fillPrice) {
        const slippagePer = (Math.abs(r.slippagePct) / 100) * r.fillPrice;
        entry.totalSlippageDollars += slippagePer * r.filledQty;
      }
    }

    // Flatten internal arrays into averages
    const result = {};
    for (const [sym, entry] of Object.entries(bySymbol)) {
      result[sym] = {
        count: entry.count,
        avgSlippage: round(avg(entry.slippages)),
        totalSlippageDollars: round(entry.totalSlippageDollars, 2),
      };
    }

    return result;
  }

  /**
   * Compare last TREND_WINDOW fills' avg slippage against the prior window.
   * @private
   * @returns {'improving'|'degrading'|'stable'}
   */
  _computeTrend(filledRecords) {
    if (filledRecords.length < TREND_WINDOW * 2) return 'stable';

    const sorted = [...filledRecords]
      .filter(r => r.slippagePct != null)
      .sort((a, b) => a.placedAt - b.placedAt);

    if (sorted.length < TREND_WINDOW * 2) return 'stable';

    const recent = sorted.slice(-TREND_WINDOW);
    const prior = sorted.slice(-TREND_WINDOW * 2, -TREND_WINDOW);

    const recentAvg = avg(recent.map(r => r.slippagePct));
    const priorAvg = avg(prior.map(r => r.slippagePct));

    // A 10% relative change in slippage = trend shift
    const threshold = 0.10;
    const change = priorAvg === 0 ? 0 : (recentAvg - priorAvg) / Math.abs(priorAvg);

    if (change < -threshold) return 'improving';
    if (change > threshold) return 'degrading';
    return 'stable';
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

/** @type {ExecutionTracker|null} */
let _instance = null;

/**
 * Create or return the singleton ExecutionTracker.
 * @param {string} [dataDir]
 * @returns {ExecutionTracker}
 */
function createExecutionTracker(dataDir) {
  if (!_instance) {
    _instance = new ExecutionTracker(dataDir);
  }
  return _instance;
}

// ---------------------------------------------------------------------------
// MCP Tool Definitions
// ---------------------------------------------------------------------------

/**
 * Returns MCP tool schemas for execution quality tracking.
 * @returns {Array<object>} array of 2 tool definition objects
 */
function getExecutionToolDefinitions() {
  return [
    {
      name: 'get_execution_stats',
      description:
        'Get execution quality statistics: slippage, fill rates, timing. ' +
        'Use to evaluate if your order execution is degrading. ' +
        'Returns aggregate stats plus per-symbol, per-type, and per-side breakdowns.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Filter stats to a specific ticker symbol, e.g. "AAPL" or "TSLA".',
          },
          since: {
            type: 'string',
            description:
              'ISO 8601 date string. Only include orders placed on or after this date. ' +
              'Example: "2025-01-15T00:00:00Z".',
          },
        },
        required: [],
      },
    },
    {
      name: 'record_execution',
      description:
        'Record an order execution for quality tracking. ' +
        'Call after placing an order and receiving a fill confirmation. ' +
        'Stores order details and calculates slippage, fill time, and price improvement.',
      inputSchema: {
        type: 'object',
        properties: {
          orderId: {
            type: 'string',
            description: 'The Alpaca order ID from the fill confirmation.',
          },
          symbol: {
            type: 'string',
            description: 'Ticker symbol, e.g. "AAPL".',
          },
          side: {
            type: 'string',
            enum: ['buy', 'sell'],
            description: 'Order side: "buy" or "sell".',
          },
          qty: {
            type: 'number',
            description: 'Number of shares or contracts.',
          },
          type: {
            type: 'string',
            enum: ['market', 'limit', 'stop'],
            description: 'Order type.',
          },
          limitPrice: {
            type: 'number',
            description: 'Limit price if applicable (null for market orders).',
          },
          fillPrice: {
            type: 'number',
            description: 'Actual fill price from the confirmation.',
          },
          bid: {
            type: 'number',
            description: 'Market bid price at the time the order was placed.',
          },
          ask: {
            type: 'number',
            description: 'Market ask price at the time the order was placed.',
          },
        },
        required: ['orderId', 'symbol', 'side', 'qty', 'type', 'fillPrice'],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// MCP Tool Call Handler
// ---------------------------------------------------------------------------

/**
 * Dispatch an MCP tool call to the appropriate ExecutionTracker method.
 * @param {string} name — tool name
 * @param {object} args — tool arguments
 * @param {ExecutionTracker} tracker
 * @returns {object} MCP response with content array
 */
function handleExecutionToolCall(name, args, tracker) {
  switch (name) {
    case 'get_execution_stats': {
      const filter = {};
      if (args.symbol) filter.symbol = args.symbol;
      if (args.since) filter.since = args.since;

      const stats = tracker.getExecutionStats(filter);
      return ok(stats);
    }

    case 'record_execution': {
      const { orderId, symbol, side, qty, type, limitPrice, fillPrice, bid, ask } = args;

      if (!orderId || !symbol || !side || !qty || !type || fillPrice == null) {
        return fail('Missing required fields: orderId, symbol, side, qty, type, fillPrice');
      }

      // Record the order placement
      const record = tracker.recordOrder({
        orderId,
        symbol,
        side,
        qty,
        type,
        limitPrice: limitPrice ?? null,
        bid: bid ?? 0,
        ask: ask ?? 0,
      });

      // Immediately record the fill (combined place+fill in one call)
      const filled = tracker.recordFill(orderId, { price: fillPrice, qty });

      if (!filled) {
        return fail(`Failed to record fill for orderId "${orderId}"`);
      }

      return ok({
        message: 'Execution recorded',
        id: record.id,
        orderId: filled.orderId,
        symbol: filled.symbol,
        side: filled.side,
        fillPrice: filled.fillPrice,
        slippagePct: filled.slippagePct,
        slippageFromMid: filled.slippageFromMid,
        fillTimeMs: filled.fillTimeMs,
        priceImprovement: filled.priceImprovement,
      });
    }

    default:
      return fail(`Unknown execution tool: "${name}"`);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  ExecutionTracker,
  createExecutionTracker,
  getExecutionToolDefinitions,
  handleExecutionToolCall,
};
export default ExecutionTracker;
