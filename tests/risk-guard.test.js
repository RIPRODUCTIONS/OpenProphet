/**
 * Tests for risk-guard.js — RiskGuard validation engine.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  RiskGuard,
  createGuard,
  resetGuard,
  parseOCCSymbol,
  computeDTE,
  DEFAULT_CONFIG,
} from '../risk-guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique temp dir per test run to avoid collisions. */
function makeTempStateFile() {
  const dir = join(tmpdir(), `rg-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'risk_guard_state.json');
}

/** Build a minimal valid account state. */
function makeAccount(overrides = {}) {
  return {
    equity: 10_000,
    cash: 8_000,
    buying_power: 8_000,
    buyingPower: 8_000,
    openPositions: 0,
    dailyPL: 0,
    positions: [],
    open_orders: [],
    ...overrides,
  };
}

/** Build a minimal valid buy order for a stock. */
function makeBuyOrder(overrides = {}) {
  return {
    symbol: 'AAPL',
    side: 'buy',
    qty: 1,
    type: 'limit',
    limit_price: 150,
    time_in_force: 'day',
    ...overrides,
  };
}

/** Build a sell order. */
function makeSellOrder(overrides = {}) {
  return {
    symbol: 'AAPL',
    side: 'sell',
    qty: 1,
    type: 'limit',
    limit_price: 150,
    time_in_force: 'day',
    ...overrides,
  };
}

/**
 * Build an OCC option symbol with a specific DTE from today.
 * @param {number} daysFromNow
 * @param {'C'|'P'} type
 * @returns {string}
 */
function makeOCCSymbol(daysFromNow, type = 'C') {
  const exp = new Date();
  exp.setDate(exp.getDate() + daysFromNow);
  const yy = String(exp.getFullYear() % 100).padStart(2, '0');
  const mm = String(exp.getMonth() + 1).padStart(2, '0');
  const dd = String(exp.getDate()).padStart(2, '0');
  return `AAPL${yy}${mm}${dd}${type}00150000`;
}

/** Create a guard with permissive config so tests can isolate individual rules. */
function makeGuard(overrides = {}) {
  return new RiskGuard({
    _stateFile: makeTempStateFile(),
    accountSize: 10_000,
    maxPositionPct: 50,
    maxCashDeployedPct: 90,
    maxOpenPositions: 10,
    maxDailyTrades: 100,
    maxDailyLossPct: 50,
    maxDrawdownPct: 50,
    revengeCooldownMs: 1,            // basically off
    noTradeOpenMinutes: 0,
    noTradeCloseMinutes: 0,
    marketOpenMinutes: 0,            // allow all hours
    marketCloseMinutes: 1440,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseOCCSymbol', () => {
  it('parses a valid OCC symbol', () => {
    const result = parseOCCSymbol('TSLA251219C00400000');
    assert.ok(result);
    assert.equal(result.underlying, 'TSLA');
    assert.equal(result.type, 'C');
    assert.equal(result.strike, 400);
    assert.equal(result.expDate.getFullYear(), 2025);
    assert.equal(result.expDate.getMonth(), 11); // December = 11
    assert.equal(result.expDate.getDate(), 19);
  });

  it('parses a put symbol', () => {
    const result = parseOCCSymbol('SPY260115P00580000');
    assert.ok(result);
    assert.equal(result.type, 'P');
    assert.equal(result.strike, 580);
  });

  it('returns null for invalid/empty input', () => {
    assert.equal(parseOCCSymbol(null), null);
    assert.equal(parseOCCSymbol(''), null);
    assert.equal(parseOCCSymbol('AAPL'), null);
    assert.equal(parseOCCSymbol(123), null);
  });
});

describe('computeDTE', () => {
  it('returns positive DTE for future date', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const dte = computeDTE(future);
    assert.ok(dte >= 29 && dte <= 31, `Expected ~30, got ${dte}`);
  });

  it('returns 0 for today', () => {
    const today = new Date();
    const dte = computeDTE(today);
    assert.ok(dte >= 0 && dte <= 1, `Expected 0 or 1, got ${dte}`);
  });
});

describe('RiskGuard — field normalization', () => {
  let guard;
  beforeEach(() => { guard = makeGuard(); });

  it('accepts snake_case limit_price from MCP format', async () => {
    const result = await guard.validateOrder(
      { symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', limit_price: 10 },
      makeAccount(),
    );
    assert.equal(result.allowed, true);
  });

  it('accepts camelCase limitPrice', async () => {
    const result = await guard.validateOrder(
      { symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', limitPrice: 10 },
      makeAccount(),
    );
    assert.equal(result.allowed, true);
  });

  it('accepts entry_price as fallback', async () => {
    const result = await guard.validateOrder(
      { symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', entry_price: 10 },
      makeAccount(),
    );
    assert.equal(result.allowed, true);
  });
});

describe('RiskGuard — sell/close bypass', () => {
  let guard;
  beforeEach(() => {
    // Guard that blocks nearly all buys
    guard = makeGuard({
      maxDailyTrades: 0,
      revengeCooldownMs: 999_999_999,
      maxPositionPct: 0.001,
    });
    guard.recordLoss(-100);
  });

  it('sell orders pass despite maxDailyTrades=0', async () => {
    const result = await guard.validateOrder(makeSellOrder(), makeAccount());
    assert.equal(result.allowed, true);
  });

  it('close orders pass despite revenge cooldown', async () => {
    const result = await guard.validateOrder(
      makeSellOrder({ side: 'close' }),
      makeAccount(),
    );
    assert.equal(result.allowed, true);
  });

  it('buy orders are blocked under the same config', async () => {
    const result = await guard.validateOrder(makeBuyOrder(), makeAccount());
    assert.equal(result.allowed, false);
  });
});

describe('RiskGuard — crypto bypass', () => {
  let guard;
  beforeEach(() => {
    // Use default market hours (9:30-16:00 ET) so stocks may fail outside those hours
    guard = makeGuard({
      marketOpenMinutes: 570,        // 9:30
      marketCloseMinutes: 960,       // 16:00
      noTradeOpenMinutes: 15,
      noTradeCloseMinutes: 15,
    });
  });

  it('BTC/USD skips market hours check', async () => {
    const result = await guard.validateOrder(
      makeBuyOrder({ symbol: 'BTC/USD', limit_price: 100 }),
      makeAccount(),
    );
    // Should not be rejected for trading_hours — may pass or fail other checks
    if (!result.allowed) {
      assert.notEqual(result.rule, 'trading_hours',
        'Crypto should skip trading_hours check');
    }
  });

  it('ETH-USD skips market hours check', async () => {
    const result = await guard.validateOrder(
      makeBuyOrder({ symbol: 'ETH-USD', limit_price: 50 }),
      makeAccount(),
    );
    if (!result.allowed) {
      assert.notEqual(result.rule, 'trading_hours');
    }
  });

  it('BTCUSDT recognized as crypto', async () => {
    const result = await guard.validateOrder(
      makeBuyOrder({ symbol: 'BTCUSDT', limit_price: 100 }),
      makeAccount(),
    );
    if (!result.allowed) {
      assert.notEqual(result.rule, 'trading_hours');
    }
  });
});

describe('RiskGuard — daily trade limit', () => {
  let guard;
  beforeEach(() => {
    guard = makeGuard({ maxDailyTrades: 2, revengeCooldownMs: 1 });
  });

  it('allows trades under the limit', async () => {
    guard.recordTrade({ symbol: 'AAPL', side: 'buy', qty: 1, price: 100 });
    const result = await guard.validateOrder(makeBuyOrder(), makeAccount());
    assert.equal(result.allowed, true);
  });

  it('blocks buys after max trades reached', async () => {
    guard.recordTrade({ symbol: 'AAPL', side: 'buy', qty: 1, price: 100 });
    guard.recordTrade({ symbol: 'AAPL', side: 'sell', qty: 1, price: 110 });
    const result = await guard.validateOrder(makeBuyOrder(), makeAccount());
    assert.equal(result.allowed, false);
    assert.equal(result.rule, 'daily_trade_limit');
  });

  it('still allows sells after max trades', async () => {
    guard.recordTrade({ symbol: 'X', side: 'buy', qty: 1, price: 10 });
    guard.recordTrade({ symbol: 'X', side: 'sell', qty: 1, price: 10 });
    const result = await guard.validateOrder(makeSellOrder(), makeAccount());
    assert.equal(result.allowed, true);
  });
});

describe('RiskGuard — revenge trade cooldown', () => {
  let guard;
  beforeEach(() => {
    guard = makeGuard({ revengeCooldownMs: 60_000 }); // 1 minute
  });

  it('blocks buys during cooldown after a loss', async () => {
    guard.recordLoss(-50);
    const result = await guard.validateOrder(makeBuyOrder(), makeAccount());
    assert.equal(result.allowed, false);
    assert.equal(result.rule, 'revenge_cooldown');
  });

  it('allows buys after cooldown expires', async () => {
    guard.recordLoss(-50);
    // Manually backdate the timestamp to simulate expiry
    guard._lastLossTimestamp = Date.now() - 120_000;
    const result = await guard.validateOrder(makeBuyOrder(), makeAccount());
    assert.notEqual(result.rule, 'revenge_cooldown');
  });

  it('sells always pass during cooldown', async () => {
    guard.recordLoss(-50);
    const result = await guard.validateOrder(makeSellOrder(), makeAccount());
    assert.equal(result.allowed, true);
  });
});

describe('RiskGuard — drawdown halt', () => {
  let guard;
  beforeEach(() => {
    guard = makeGuard({
      maxDrawdownPct: 20,
      accountSize: 10_000,
    });
  });

  it('halts when equity drops below drawdown threshold', async () => {
    // Peak = 10,000. Equity = 7,500 → 25% drawdown → exceeds 20%
    guard._peakEquity = 10_000;
    const result = await guard.validateOrder(
      makeBuyOrder(),
      makeAccount({ equity: 7_500 }),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.rule, 'drawdown_limit');
    assert.equal(guard._halted, true);
  });

  it('rejects all buys after halt, even with recovered equity', async () => {
    guard._peakEquity = 10_000;
    await guard.validateOrder(makeBuyOrder(), makeAccount({ equity: 7_500 }));
    assert.equal(guard._halted, true);

    // Equity recovers but halt persists
    const result = await guard.validateOrder(
      makeBuyOrder(),
      makeAccount({ equity: 9_900 }),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.rule, 'hard_halt');
  });

  it('allows sells even when halted', async () => {
    guard._halted = true;
    guard._haltReason = 'test';
    const result = await guard.validateOrder(makeSellOrder(), makeAccount());
    assert.equal(result.allowed, true);
  });

  it('clearHalt() resumes trading', async () => {
    guard._halted = true;
    guard._haltReason = 'test';
    guard.clearHalt('operator approved');
    assert.equal(guard._halted, false);

    const result = await guard.validateOrder(makeBuyOrder(), makeAccount());
    assert.notEqual(result.rule, 'hard_halt');
  });
});

describe('RiskGuard — position sizing', () => {
  let guard;
  beforeEach(() => {
    guard = makeGuard({ maxPositionPct: 30 });
  });

  it('allows order within position size limit', async () => {
    // 10 shares × $200 = $2,000 = 20% of $10,000 equity → under 30%
    const result = await guard.validateOrder(
      makeBuyOrder({ qty: 10, limit_price: 200 }),
      makeAccount({ equity: 10_000 }),
    );
    assert.equal(result.allowed, true);
  });

  it('rejects order exceeding position size limit', async () => {
    // 10 shares × $400 = $4,000 = 40% of $10,000 → exceeds 30%
    const result = await guard.validateOrder(
      makeBuyOrder({ qty: 10, limit_price: 400 }),
      makeAccount({ equity: 10_000 }),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.rule, 'position_size');
  });
});

describe('RiskGuard — DTE range for options', () => {
  let guard;
  beforeEach(() => {
    guard = makeGuard({ dteMin: 14, dteMax: 45 });
  });

  it('rejects options expiring too soon (DTE < dteMin)', async () => {
    const symbol = makeOCCSymbol(5); // 5 days out — below 14
    const result = await guard.validateOrder(
      makeBuyOrder({
        symbol,
        limit_price: 2,
        optionDetails: { delta: 0.45, bid: 1.9, ask: 2.1, openInterest: 500 },
      }),
      makeAccount(),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.rule, 'options_dte');
  });

  it('rejects options expiring too far out (DTE > dteMax)', async () => {
    const symbol = makeOCCSymbol(90); // 90 days out — above 45
    const result = await guard.validateOrder(
      makeBuyOrder({
        symbol,
        limit_price: 5,
        optionDetails: { delta: 0.45, bid: 4.5, ask: 5.5, openInterest: 500 },
      }),
      makeAccount(),
    );
    assert.equal(result.allowed, false);
    assert.equal(result.rule, 'options_dte');
  });

  it('allows options within DTE range', async () => {
    const symbol = makeOCCSymbol(30); // 30 days — within 14-45
    const result = await guard.validateOrder(
      makeBuyOrder({
        symbol,
        limit_price: 3,
        optionDetails: { delta: 0.45, bid: 2.8, ask: 3.2, openInterest: 500 },
      }),
      makeAccount(),
    );
    // Should not be rejected for DTE
    if (!result.allowed) {
      assert.notEqual(result.rule, 'options_dte',
        `Order rejected for DTE but should be in range`);
    }
  });

  it('stock orders skip DTE check entirely', async () => {
    const result = await guard.validateOrder(
      makeBuyOrder({ symbol: 'AAPL', limit_price: 150 }),
      makeAccount(),
    );
    if (!result.allowed) {
      assert.notEqual(result.rule, 'options_dte');
    }
  });
});

describe('RiskGuard — state persistence', () => {
  let stateFile;
  let guard;

  beforeEach(() => {
    stateFile = makeTempStateFile();
    guard = new RiskGuard({
      ...DEFAULT_CONFIG,
      _stateFile: stateFile,
      accountSize: 10_000,
    });
  });

  afterEach(() => {
    // Clean up temp files
    try { rmSync(stateFile, { force: true }); } catch { /* ignore */ }
  });

  it('creates state file after recordTrade', () => {
    guard.recordTrade({ symbol: 'AAPL', side: 'buy', qty: 1, price: 150 });
    assert.ok(existsSync(stateFile), `State file should exist at ${stateFile}`);
  });

  it('creates state file after recordLoss', () => {
    guard.recordLoss(-25);
    assert.ok(existsSync(stateFile));
  });

  it('restores state from file', () => {
    guard.recordTrade({ symbol: 'X', side: 'buy', qty: 1, price: 10 });
    guard.recordTrade({ symbol: 'X', side: 'sell', qty: 1, price: 10 });

    // Create a new guard reading the same state file
    const guard2 = new RiskGuard({
      ...DEFAULT_CONFIG,
      _stateFile: stateFile,
      accountSize: 10_000,
    });
    assert.equal(guard2._dailyTradeCount, 2, 'Should restore trade count from file');
  });
});

describe('RiskGuard — resetDaily', () => {
  let guard;
  beforeEach(() => {
    guard = makeGuard({ maxDrawdownPct: 20 });
  });

  it('zeros trade count', () => {
    guard.recordTrade({ symbol: 'X', side: 'buy', qty: 1, price: 10 });
    guard.recordTrade({ symbol: 'X', side: 'sell', qty: 1, price: 10 });
    assert.equal(guard._dailyTradeCount, 2);
    guard.resetDaily();
    assert.equal(guard._dailyTradeCount, 0);
  });

  it('does NOT clear halt', () => {
    guard._halted = true;
    guard._haltReason = 'drawdown breach';
    guard.resetDaily();
    assert.equal(guard._halted, true, 'Halt must persist across daily reset');
    assert.equal(guard._haltReason, 'drawdown breach');
  });
});

describe('createGuard / resetGuard singleton', () => {
  beforeEach(() => { resetGuard(); });

  it('createGuard returns same instance on second call', () => {
    const g1 = createGuard({ _stateFile: makeTempStateFile(), accountSize: 100 });
    const g2 = createGuard({ accountSize: 999 });
    assert.equal(g1, g2, 'Should be the same singleton');
    assert.equal(g2.config.accountSize, 100, 'Config should be from first call');
  });

  it('resetGuard clears the singleton', () => {
    const g1 = createGuard({ _stateFile: makeTempStateFile(), accountSize: 100 });
    resetGuard();
    const g2 = createGuard({ _stateFile: makeTempStateFile(), accountSize: 999 });
    assert.notEqual(g1, g2);
    assert.equal(g2.config.accountSize, 999);
  });
});
