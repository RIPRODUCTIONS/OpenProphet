/**
 * risk-guard.js — Hard enforcement of TRADING_RULES.md for the OpenProphet trading system.
 *
 * Every order must pass through RiskGuard.validateOrder() before reaching the Alpaca API.
 * Failures are non-negotiable — if a rule says no, the trade is blocked.
 *
 * @module risk-guard
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ---------------------------------------------------------------------------
// Eastern Time helpers (no external deps)
// ---------------------------------------------------------------------------

const ET_TZ = 'America/New_York';

/** @returns {{ hours: number, minutes: number, dayOfWeek: number }} Current Eastern Time components */
function getEasternTime() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  let hours = 0, minutes = 0, weekday = '';
  for (const p of parts) {
    if (p.type === 'hour') hours = parseInt(p.value, 10);
    if (p.type === 'minute') minutes = parseInt(p.value, 10);
    if (p.type === 'weekday') weekday = p.value;
  }

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hours, minutes, dayOfWeek: dayMap[weekday] ?? -1 };
}

/** @returns {string} Today's date string YYYY-MM-DD in Eastern Time */
function getEasternDateStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET_TZ }).format(new Date());
}

/**
 * Minutes since midnight ET. 9:30 AM = 570, 4:00 PM = 960.
 * @param {number} h
 * @param {number} m
 * @returns {number}
 */
function toMinutes(h, m) {
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// OCC symbol parser
// ---------------------------------------------------------------------------

/**
 * Parse an OCC option symbol into components.
 * Format: UNDERLYING + YYMMDD + C|P + 8-digit strike (strike × 1000).
 *
 * @param {string} symbol e.g. "TSLA251219C00400000"
 * @returns {{ underlying: string, expDate: Date, type: 'C'|'P', strike: number } | null}
 */
function parseOCCSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') return null;
  // Underlying: 1-6 uppercase letters, then 6-digit date, C/P, 8-digit price
  const match = symbol.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!match) return null;

  const [, underlying, dateStr, type, strikeStr] = match;
  const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
  const month = parseInt(dateStr.slice(2, 4), 10) - 1; // zero-indexed
  const day = parseInt(dateStr.slice(4, 6), 10);
  const expDate = new Date(year, month, day);

  // Sanity check — month/day should round-trip
  if (expDate.getMonth() !== month || expDate.getDate() !== day) return null;

  const strike = parseInt(strikeStr, 10) / 1000;
  return { underlying, expDate, type, strike };
}

/**
 * Compute days to expiration from today (Eastern Time) to the given date.
 * @param {Date} expDate
 * @returns {number} Calendar days, can be 0 or negative
 */
function computeDTE(expDate) {
  const todayStr = getEasternDateStr(); // YYYY-MM-DD
  const [y, m, d] = todayStr.split('-').map(Number);
  const todayMidnight = new Date(y, m - 1, d);
  const expMidnight = new Date(expDate.getFullYear(), expDate.getMonth(), expDate.getDate());
  return Math.round((expMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Default configuration — mirrors TRADING_RULES.md exactly
// ---------------------------------------------------------------------------

/** @type {import('./risk-guard').RiskGuardConfig} */
const DEFAULT_CONFIG = {
  accountSize: 100,                  // $100 live, override for paper
  maxPositionPct: 30,                // 30% of account per trade
  maxCashDeployedPct: 50,            // Keep 50%+ cash at all times
  maxOpenPositions: 1,               // One position at a time
  maxDailyTrades: 2,                 // Max 2 trades per day
  maxDailyLossPct: 10,              // -10% daily → stop trading
  maxDrawdownPct: 20,                // -20% from peak → full stop
  revengeCooldownMs: 24 * 60 * 60 * 1000,  // 24 hours
  dteMin: 14,
  dteMax: 45,
  deltaMin: 0.35,
  deltaMax: 0.55,
  minOpenInterest: 100,
  maxBidAskSpreadPct: 15,            // 15% of mid price
  noTradeOpenMinutes: 15,            // First 15 min after open
  noTradeCloseMinutes: 15,           // Last 15 min before close
  marketOpenMinutes: 570,            // 9:30 ET in minutes
  marketCloseMinutes: 960,           // 16:00 ET in minutes
};

// ---------------------------------------------------------------------------
// RiskGuard
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} allowed - Whether the order may proceed
 * @property {string}  [reason] - Human-readable rejection reason (set when allowed=false)
 * @property {string}  rule     - The rule name that was checked
 */

/**
 * @typedef {Object} OrderInput
 * @property {string}  symbol      - Ticker (stock) or OCC symbol (option)
 * @property {string}  side        - 'buy' | 'sell'
 * @property {string}  type        - 'market' | 'limit' | 'stop' | 'stop_limit'
 * @property {number}  qty         - Quantity
 * @property {number}  [limitPrice]
 * @property {number}  [stopPrice]
 * @property {string}  [underlying]
 * @property {Object}  [optionDetails]
 * @property {number}  [optionDetails.delta]        - Absolute delta of the long leg
 * @property {number}  [optionDetails.bid]          - Current bid
 * @property {number}  [optionDetails.ask]          - Current ask
 * @property {number}  [optionDetails.openInterest] - Open interest
 * @property {string}  [optionDetails.positionIntent] - 'buy_to_open' | 'sell_to_close' etc.
 */

/**
 * @typedef {Object} AccountState
 * @property {number} equity         - Current account equity
 * @property {number} cash           - Available cash
 * @property {number} buyingPower    - Alpaca buying power
 * @property {number} openPositions  - Count of open positions
 * @property {number} dailyPL        - Today's realized + unrealized P/L
 * @property {number} [peakEquity]   - High-water mark for drawdown calc
 */

class RiskGuard {
  /**
   * @param {Partial<typeof DEFAULT_CONFIG>} [config]
   */
  constructor(config = {}) {
    /** @type {typeof DEFAULT_CONFIG} */
    this.config = { ...DEFAULT_CONFIG, ...config };

    // State file path for persistence across restarts
    this._stateFile = config._stateFile || join(process.cwd(), 'data', 'risk_guard_state.json');

    // Daily state (reset at market open via resetDaily)
    this._dailyDate = getEasternDateStr();
    this._dailyTradeCount = 0;
    this._lastLossTimestamp = 0;      // epoch ms of most recent recorded loss
    this._peakEquity = this.config.accountSize;
    this._halted = false;             // true after drawdown breach — manual reset required
    this._haltReason = '';

    /** @type {Array<{ts: string, rule: string, allowed: boolean, details: string}>} */
    this._log = [];

    // Attempt to restore persisted state
    this._loadState();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Validate an order against all risk rules. Call before every order placement.
   *
   * @param {OrderInput}    order
   * @param {AccountState}  accountState
   * @returns {Promise<ValidationResult>}
   */
  async validateOrder(order, accountState) {
    // Auto-reset daily counters if the date rolled over
    this._maybeResetDaily();

    // Normalize field names (MCP uses snake_case, internal uses camelCase)
    const normalized = {
      ...order,
      limitPrice: order.limitPrice ?? order.limit_price ?? order.entry_price ?? undefined,
      stopPrice: order.stopPrice ?? order.stop_price ?? undefined,
      qty: order.qty ?? order.quantity ?? order.amount ?? undefined,
      side: (order.side || '').toLowerCase(),
      type: (order.type || order.order_type || '').toLowerCase(),
    };

    // Update peak equity for drawdown tracking
    if (accountState.peakEquity != null) {
      this._peakEquity = Math.max(this._peakEquity, accountState.peakEquity);
    }
    if (accountState.equity > this._peakEquity) {
      this._peakEquity = accountState.equity;
    }

    // If we're in a hard halt state, reject everything except sells/closes
    if (this._halted && normalized.side !== 'sell') {
      return this._reject('hard_halt', `Trading halted: ${this._haltReason}. Manual reset required.`);
    }

    const isSellOrClose = normalized.side === 'sell' || normalized.side === 'close';
    const isCrypto = this._isCryptoSymbol(normalized.symbol);

    // Sell/close orders must ALWAYS be allowed — you should never be trapped in a position
    // Only run safety checks that don't prevent exits
    const checks = isSellOrClose ? [
      // Minimal checks for exit orders — only log, never block
    ] : [
      this._checkPositionSize(normalized, accountState),
      this._checkCashReserve(accountState),
      this._checkMaxOpenPositions(normalized, accountState),
      this._checkDailyTradeLimit(),
      this._checkDailyLossLimit(accountState),
      this._checkDrawdownLimit(accountState),
      this._checkRevengeTrade(),
      isCrypto ? this._pass('trading_hours') : this._checkTradingHours(),
      this._checkOptionsDTE(normalized),
      this._checkOptionsDelta(normalized),
      this._checkBidAskSpread(normalized),
      this._checkOpenInterest(normalized),
      this._checkMarketOrderOnOptions(normalized),
    ];

    for (const result of checks) {
      if (!result.allowed) {
        this._logEntry(result.rule, false, result.reason);
        return result;
      }
    }

    this._logEntry('all_checks', true, 'Order passed all risk checks');
    return { allowed: true, rule: 'all_checks' };
  }

  /**
   * Record a completed trade. Call after every fill.
   * Increments daily trade count.
   *
   * @param {{ symbol: string, side: string, qty: number, price: number, pnl?: number }} trade
   */
  recordTrade(trade) {
    this._maybeResetDaily();
    this._dailyTradeCount++;
    this._logEntry('record_trade', true,
      `Recorded trade #${this._dailyTradeCount}: ${trade.side} ${trade.qty}x ${trade.symbol} @ ${trade.price}`);

    // If trade closed at a loss, trigger revenge cooldown
    if (trade.pnl != null && trade.pnl < 0) {
      this.recordLoss(trade.pnl);
    }
    this._saveState();
  }

  /**
   * Record a loss event. Starts the revenge-trade cooldown timer.
   *
   * @param {number} amount - Loss amount (negative number)
   */
  recordLoss(amount) {
    this._lastLossTimestamp = Date.now();
    this._logEntry('record_loss', true,
      `Loss of $${Math.abs(amount).toFixed(2)} recorded. Cooldown until ${new Date(this._lastLossTimestamp + this.config.revengeCooldownMs).toISOString()}`);
    this._saveState();
  }

  /**
   * Reset daily counters. Call at market open or when the trading day changes.
   * Does NOT clear the hard halt — use clearHalt() for that.
   */
  resetDaily() {
    this._dailyDate = getEasternDateStr();
    this._dailyTradeCount = 0;
    this._logEntry('daily_reset', true, `Daily counters reset for ${this._dailyDate}`);
    this._saveState();
  }

  /**
   * Manually clear a hard halt (drawdown breach). Requires explicit operator action.
   *
   * @param {string} reason - Why the operator is clearing the halt
   */
  clearHalt(reason) {
    if (!this._halted) return;
    this._logEntry('halt_cleared', true, `Halt cleared by operator: ${reason}`);
    this._halted = false;
    this._haltReason = '';
    this._saveState();
  }

  /**
   * Get current guard status for dashboard / logging.
   *
   * @returns {{
   *   date: string, dailyTradeCount: number, maxDailyTrades: number,
   *   halted: boolean, haltReason: string, revengeCooldownActive: boolean,
   *   revengeCooldownEnds: string|null, peakEquity: number, config: typeof DEFAULT_CONFIG
   * }}
   */
  getStatus() {
    this._maybeResetDaily();
    const cooldownActive = this._isInRevengeCooldown();
    return {
      date: this._dailyDate,
      dailyTradeCount: this._dailyTradeCount,
      maxDailyTrades: this.config.maxDailyTrades,
      halted: this._halted,
      haltReason: this._haltReason,
      revengeCooldownActive: cooldownActive,
      revengeCooldownEnds: cooldownActive
        ? new Date(this._lastLossTimestamp + this.config.revengeCooldownMs).toISOString()
        : null,
      peakEquity: this._peakEquity,
      config: { ...this.config },
    };
  }

  /**
   * Get the full validation log.
   *
   * @param {number} [limit] - Return only the last N entries
   * @returns {Array<{ts: string, rule: string, allowed: boolean, details: string}>}
   */
  getLog(limit) {
    if (limit != null && limit > 0) {
      return this._log.slice(-limit);
    }
    return [...this._log];
  }

  /**
   * Update configuration at runtime. Merges with existing config.
   *
   * @param {Partial<typeof DEFAULT_CONFIG>} updates
   */
  updateConfig(updates) {
    Object.assign(this.config, updates);
    this._logEntry('config_update', true, `Config updated: ${Object.keys(updates).join(', ')}`);
  }

  // -----------------------------------------------------------------------
  // Validation checks (private)
  // -----------------------------------------------------------------------

  /**
   * Position size must not exceed maxPositionPct of account equity.
   * @param {OrderInput} order
   * @param {AccountState} accountState
   * @returns {ValidationResult}
   */
  _checkPositionSize(order, accountState) {
    const rule = 'position_size';

    // Only check buy-side orders (opening positions)
    if (order.side === 'sell') return this._pass(rule);

    const price = order.limitPrice ?? order.stopPrice ?? 0;
    if (price === 0) {
      // Market orders on options are already blocked separately; for stocks
      // we can't compute size without a price, so reject to be safe
      if (this._isOptionSymbol(order.symbol)) return this._pass(rule);
      return this._reject(rule, 'Cannot validate position size without a price. Use limit orders.');
    }

    // For options, price is per-share but contracts are 100 shares
    const multiplier = this._isOptionSymbol(order.symbol) ? 100 : 1;
    const orderValue = price * (order.qty || 1) * multiplier;
    const maxValue = accountState.equity * (this.config.maxPositionPct / 100);

    if (orderValue > maxValue) {
      return this._reject(rule,
        `Order value $${orderValue.toFixed(2)} exceeds ${this.config.maxPositionPct}% of equity ($${maxValue.toFixed(2)})`);
    }
    return this._pass(rule);
  }

  /**
   * Account must maintain minimum cash reserve (maxCashDeployedPct).
   * @param {AccountState} accountState
   * @returns {ValidationResult}
   */
  _checkCashReserve(accountState) {
    const rule = 'cash_reserve';
    const deployedPct = ((accountState.equity - accountState.cash) / accountState.equity) * 100;
    if (deployedPct > this.config.maxCashDeployedPct) {
      return this._reject(rule,
        `${deployedPct.toFixed(1)}% of equity is deployed. Max allowed: ${this.config.maxCashDeployedPct}%. Maintain ${100 - this.config.maxCashDeployedPct}%+ cash.`);
    }
    return this._pass(rule);
  }

  /**
   * Cannot exceed max simultaneous open positions.
   * Sell/close orders are exempt.
   * @param {OrderInput} order
   * @param {AccountState} accountState
   * @returns {ValidationResult}
   */
  _checkMaxOpenPositions(order, accountState) {
    const rule = 'max_open_positions';

    // Closing orders don't add positions
    if (order.side === 'sell') return this._pass(rule);
    if (order.optionDetails?.positionIntent === 'sell_to_close') return this._pass(rule);

    if (accountState.openPositions >= this.config.maxOpenPositions) {
      return this._reject(rule,
        `Already at max open positions (${accountState.openPositions}/${this.config.maxOpenPositions}). Close a position first.`);
    }
    return this._pass(rule);
  }

  /**
   * Daily trade count must not exceed limit.
   * @returns {ValidationResult}
   */
  _checkDailyTradeLimit() {
    const rule = 'daily_trade_limit';
    if (this._dailyTradeCount >= this.config.maxDailyTrades) {
      return this._reject(rule,
        `Daily trade limit reached (${this._dailyTradeCount}/${this.config.maxDailyTrades}). No more trades today.`);
    }
    return this._pass(rule);
  }

  /**
   * Daily P/L must not exceed max daily loss threshold.
   * @param {AccountState} accountState
   * @returns {ValidationResult}
   */
  _checkDailyLossLimit(accountState) {
    const rule = 'daily_loss_limit';
    const equity = accountState.equity || this.config.accountSize;
    const lossPct = (accountState.dailyPL / equity) * 100;

    if (lossPct <= -this.config.maxDailyLossPct) {
      return this._reject(rule,
        `Daily loss of ${lossPct.toFixed(1)}% exceeds -${this.config.maxDailyLossPct}% limit. Trading paused for the day.`);
    }
    return this._pass(rule);
  }

  /**
   * Total drawdown from peak equity must not exceed threshold.
   * Triggers a hard halt that requires manual clearance.
   * @param {AccountState} accountState
   * @returns {ValidationResult}
   */
  _checkDrawdownLimit(accountState) {
    const rule = 'drawdown_limit';
    const drawdownPct = ((this._peakEquity - accountState.equity) / this._peakEquity) * 100;

    if (drawdownPct >= this.config.maxDrawdownPct) {
      this._halted = true;
      this._haltReason = `Drawdown ${drawdownPct.toFixed(1)}% from peak $${this._peakEquity.toFixed(2)} exceeds -${this.config.maxDrawdownPct}% limit`;
      this._saveState();
      return this._reject(rule, `${this._haltReason}. FULL STOP — manual clearHalt() required.`);
    }
    return this._pass(rule);
  }

  /**
   * After a loss, enforce a cooldown period before the next trade.
   * @returns {ValidationResult}
   */
  _checkRevengeTrade() {
    const rule = 'revenge_cooldown';
    if (!this._isInRevengeCooldown()) return this._pass(rule);

    const remainMs = (this._lastLossTimestamp + this.config.revengeCooldownMs) - Date.now();
    const remainHrs = (remainMs / (1000 * 60 * 60)).toFixed(1);
    return this._reject(rule,
      `Revenge trade cooldown active. ${remainHrs}h remaining. Last loss at ${new Date(this._lastLossTimestamp).toISOString()}.`);
  }

  /**
   * Trading only during allowed market hours in Eastern Time.
   * Blocked: before 9:30, after 16:00, first 15 min, last 15 min, weekends.
   * @returns {ValidationResult}
   */
  _checkTradingHours() {
    const rule = 'trading_hours';
    const { hours, minutes, dayOfWeek } = getEasternTime();
    const nowMins = toMinutes(hours, minutes);

    // Weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return this._reject(rule, 'Market is closed on weekends.');
    }

    const { marketOpenMinutes, marketCloseMinutes, noTradeOpenMinutes, noTradeCloseMinutes } = this.config;

    // Before market open
    if (nowMins < marketOpenMinutes) {
      return this._reject(rule, `Market not open yet. Current ET: ${hours}:${String(minutes).padStart(2, '0')}, open at 9:30.`);
    }

    // After market close
    if (nowMins >= marketCloseMinutes) {
      return this._reject(rule, `Market closed. Current ET: ${hours}:${String(minutes).padStart(2, '0')}.`);
    }

    // Opening volatility window (9:30 – 9:45)
    if (nowMins < marketOpenMinutes + noTradeOpenMinutes) {
      return this._reject(rule,
        `No trading during first ${noTradeOpenMinutes} min of market open (9:30-9:45 ET). Wait until 9:45.`);
    }

    // Closing window (3:45 – 4:00)
    if (nowMins >= marketCloseMinutes - noTradeCloseMinutes) {
      return this._reject(rule,
        `No trading during last ${noTradeCloseMinutes} min before close (3:45-4:00 ET).`);
    }

    return this._pass(rule);
  }

  /**
   * Options DTE must be within the allowed range.
   * Only applies to option orders (detected by OCC symbol format).
   * @param {OrderInput} order
   * @returns {ValidationResult}
   */
  _checkOptionsDTE(order) {
    const rule = 'options_dte';
    if (!this._isOptionSymbol(order.symbol)) return this._pass(rule);

    const parsed = parseOCCSymbol(order.symbol);
    if (!parsed) {
      return this._reject(rule, `Cannot parse OCC symbol "${order.symbol}". Verify format: SYMBOL+YYMMDD+C/P+8-digit strike.`);
    }

    const dte = computeDTE(parsed.expDate);

    if (dte < this.config.dteMin) {
      return this._reject(rule,
        `DTE ${dte} is below minimum ${this.config.dteMin}. Too close to expiration — theta decay risk.`);
    }
    if (dte > this.config.dteMax) {
      return this._reject(rule,
        `DTE ${dte} exceeds maximum ${this.config.dteMax}. Capital tied up too long.`);
    }
    return this._pass(rule);
  }

  /**
   * Option delta (absolute) must be within the allowed range.
   * Requires optionDetails.delta to be provided.
   * @param {OrderInput} order
   * @returns {ValidationResult}
   */
  _checkOptionsDelta(order) {
    const rule = 'options_delta';
    if (!this._isOptionSymbol(order.symbol)) return this._pass(rule);

    // Sell orders (closing) are exempt from delta check
    if (order.side === 'sell') return this._pass(rule);

    const delta = order.optionDetails?.delta;
    if (delta == null) {
      return this._reject(rule, 'Option delta not provided in optionDetails. Cannot validate strike selection.');
    }

    const absDelta = Math.abs(delta);
    if (absDelta < this.config.deltaMin) {
      return this._reject(rule,
        `Delta |${absDelta.toFixed(3)}| is below minimum ${this.config.deltaMin}. Too far OTM — low probability.`);
    }
    if (absDelta > this.config.deltaMax) {
      return this._reject(rule,
        `Delta |${absDelta.toFixed(3)}| exceeds maximum ${this.config.deltaMax}. Too deep ITM — no leverage.`);
    }
    return this._pass(rule);
  }

  /**
   * Bid-ask spread on the option must be < maxBidAskSpreadPct of mid price.
   * Requires optionDetails.bid and optionDetails.ask.
   * @param {OrderInput} order
   * @returns {ValidationResult}
   */
  _checkBidAskSpread(order) {
    const rule = 'bid_ask_spread';
    if (!this._isOptionSymbol(order.symbol)) return this._pass(rule);
    if (order.side === 'sell') return this._pass(rule);

    const { bid, ask } = order.optionDetails ?? {};
    if (bid == null || ask == null) {
      return this._reject(rule, 'Bid/ask not provided in optionDetails. Cannot validate spread quality.');
    }
    if (bid <= 0 || ask <= 0) {
      return this._reject(rule, `Invalid bid ($${bid}) / ask ($${ask}). Both must be positive.`);
    }

    const mid = (bid + ask) / 2;
    const spreadPct = ((ask - bid) / mid) * 100;

    if (spreadPct > this.config.maxBidAskSpreadPct) {
      return this._reject(rule,
        `Bid-ask spread ${spreadPct.toFixed(1)}% (bid $${bid}, ask $${ask}) exceeds ${this.config.maxBidAskSpreadPct}% limit. Illiquid option.`);
    }
    return this._pass(rule);
  }

  /**
   * Option must have minimum open interest for realistic fills.
   * Requires optionDetails.openInterest.
   * @param {OrderInput} order
   * @returns {ValidationResult}
   */
  _checkOpenInterest(order) {
    const rule = 'open_interest';
    if (!this._isOptionSymbol(order.symbol)) return this._pass(rule);
    if (order.side === 'sell') return this._pass(rule);

    const oi = order.optionDetails?.openInterest;
    if (oi == null) {
      return this._reject(rule, 'Open interest not provided in optionDetails. Cannot validate liquidity.');
    }

    if (oi < this.config.minOpenInterest) {
      return this._reject(rule,
        `Open interest ${oi} is below minimum ${this.config.minOpenInterest}. Low OI = bad fills.`);
    }
    return this._pass(rule);
  }

  /**
   * Market orders on options are forbidden — always use limit orders.
   * @param {OrderInput} order
   * @returns {ValidationResult}
   */
  _checkMarketOrderOnOptions(order) {
    const rule = 'no_market_order_options';
    if (!this._isOptionSymbol(order.symbol)) return this._pass(rule);

    if (order.type === 'market') {
      return this._reject(rule, 'Market orders on options are not allowed. Use limit orders only.');
    }
    return this._pass(rule);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Auto-reset daily counters when the ET date changes */
  _maybeResetDaily() {
    const today = getEasternDateStr();
    if (today !== this._dailyDate) {
      this.resetDaily();
    }
  }

  // -----------------------------------------------------------------------
  // State Persistence — survives restarts
  // -----------------------------------------------------------------------

  /** Save critical state to disk. Called after every state mutation. */
  _saveState() {
    try {
      mkdirSync(dirname(this._stateFile), { recursive: true });
      const state = {
        _v: 1,
        savedAt: new Date().toISOString(),
        dailyDate: this._dailyDate,
        dailyTradeCount: this._dailyTradeCount,
        lastLossTimestamp: this._lastLossTimestamp,
        peakEquity: this._peakEquity,
        halted: this._halted,
        haltReason: this._haltReason,
      };
      writeFileSync(this._stateFile, JSON.stringify(state, null, 2) + '\n');
    } catch (e) {
      console.error('[RiskGuard] Failed to persist state:', e.message);
    }
  }

  /** Load persisted state from disk if available and still valid for today. */
  _loadState() {
    try {
      const raw = readFileSync(this._stateFile, 'utf8');
      const state = JSON.parse(raw);
      if (!state || state._v !== 1) return;

      // Halted state persists across days — never auto-clear
      if (state.halted) {
        this._halted = true;
        this._haltReason = state.haltReason || 'Restored from persisted halt state';
      }
      this._peakEquity = state.peakEquity ?? this._peakEquity;
      this._lastLossTimestamp = state.lastLossTimestamp ?? 0;

      // Daily counters only restore if same trading day
      if (state.dailyDate === getEasternDateStr()) {
        this._dailyDate = state.dailyDate;
        this._dailyTradeCount = state.dailyTradeCount ?? 0;
      }

      console.error(`[RiskGuard] Restored state: ${this._dailyTradeCount} trades today, halted=${this._halted}, peak=$${this._peakEquity}`);
    } catch {
      // No state file or corrupt — start fresh (this is fine on first run)
    }
  }

  /** @returns {boolean} Whether we're within the revenge cooldown window */
  _isInRevengeCooldown() {
    if (this._lastLossTimestamp === 0) return false;
    return (Date.now() - this._lastLossTimestamp) < this.config.revengeCooldownMs;
  }

  /**
   * Detect if a symbol is an OCC option symbol (vs. plain stock ticker).
   * OCC symbols are >10 chars and match the SYMBOL+DATE+C/P+STRIKE pattern.
   * @param {string} symbol
   * @returns {boolean}
   */
  _isOptionSymbol(symbol) {
    if (!symbol || symbol.length <= 10) return false;
    return /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(symbol);
  }

  /**
   * Detect crypto trading pairs (e.g., BTC/USDT, ETH-USD, BTCUSDT).
   * @param {string} symbol
   * @returns {boolean}
   */
  _isCryptoSymbol(symbol) {
    if (!symbol) return false;
    return /[/\-_]/.test(symbol) || /^[A-Z]{3,10}(USDT|USD|USDC|BUSD|EUR|BTC|ETH)$/.test(symbol.toUpperCase());
  }

  /**
   * @param {string} rule
   * @param {string} reason
   * @returns {ValidationResult}
   */
  _reject(rule, reason) {
    return { allowed: false, rule, reason };
  }

  /**
   * @param {string} rule
   * @returns {ValidationResult}
   */
  _pass(rule) {
    return { allowed: true, rule };
  }

  /**
   * Append to the audit log.
   * @param {string} rule
   * @param {boolean} allowed
   * @param {string} details
   */
  _logEntry(rule, allowed, details) {
    this._log.push({
      ts: new Date().toISOString(),
      rule,
      allowed,
      details,
    });

    // Cap log at 10,000 entries to prevent unbounded growth
    if (this._log.length > 10_000) {
      this._log = this._log.slice(-5_000);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-account factory (keyed singletons)
// ---------------------------------------------------------------------------

const _instances = new Map();
let _defaultInstance = null;

/**
 * Get or create a RiskGuard instance. Supports per-account keying.
 * - createGuard(config) — default singleton (backward-compatible)
 * - createGuard(config, accountId) — per-account instance with separate state file
 *
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 * @param {string} [accountId] — optional account key for multi-account isolation
 * @returns {RiskGuard}
 */
function createGuard(config, accountId) {
  if (!accountId) {
    if (!_defaultInstance) _defaultInstance = new RiskGuard(config);
    return _defaultInstance;
  }
  if (!_instances.has(accountId)) {
    const acctConfig = {
      ...config,
      _stateFile: join(process.cwd(), 'data', `risk_guard_state_${accountId}.json`),
    };
    _instances.set(accountId, new RiskGuard(acctConfig));
  }
  return _instances.get(accountId);
}

/**
 * Reset singletons (for testing).
 */
function resetGuard() {
  _defaultInstance = null;
  _instances.clear();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { RiskGuard, createGuard, resetGuard, parseOCCSymbol, computeDTE, DEFAULT_CONFIG };
export default RiskGuard;
