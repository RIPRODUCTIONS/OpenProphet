import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  runBacktest,
  normaliseBars,
  extractRules,
  sma,
  rsi,
  shouldExit,
  countBuySignals,
  loadBarsFromFile,
} from './engine.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helper: build a minimal strategy with configurable rules ─────────────────

function makeStrategy(overrides = {}) {
  return {
    id: 'test-strategy',
    symbols: { primary: ['TEST'] },
    riskGuard: {
      maxPositionPct: overrides.maxPositionPct ?? 100,
    },
    rules: {
      stopLoss: overrides.stopLoss ?? 0.10,
      profitTarget: {
        hardExit: overrides.takeProfitPct ?? 0.20,
      },
      technicalConfirmations: {
        required: overrides.requiredConfirmations ?? 0,
        signals: overrides.signals ?? [],
      },
      rsiThresholds: {
        oversold: overrides.rsiOversold ?? 30,
        overbought: overrides.rsiOverbought ?? 70,
      },
    },
  };
}

/**
 * Generate synthetic bars with a known price trajectory.
 * Prices follow the sequence provided in `closePrices`.
 */
function makeBars(closePrices) {
  return closePrices.map((close, i) => ({
    timestamp: `2025-01-${String(i + 1).padStart(2, '0')}T05:00:00Z`,
    open: close - 0.5,
    high: close + 1.0,
    low: close - 1.0,
    close,
    volume: 1_000_000,
  }));
}

// ─── Test 1: P&L calculation ─────────────────────────────────────────────────

describe('P&L calculation', () => {
  it('correctly calculates profit on a simple buy-and-sell', () => {
    // Strategy: no confirmations needed (requiredConfirmations = 0), generous take-profit
    // Price oscillates slightly during warmup to keep RSI moderate, then trends up
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    // Now go up steadily with minor pullbacks to avoid RSI spiking
    prices.push(103, 102, 106, 105, 109, 108, 112, 111, 116, 115, 120, 121, 125);

    const bars = makeBars(prices);
    const strategy = makeStrategy({
      stopLoss: 0.50,
      takeProfitPct: 0.20,
      requiredConfirmations: 0,
      maxPositionPct: 100,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });

    assert.ok(result.totalTrades >= 1, `Expected at least 1 trade, got ${result.totalTrades}`);

    // The first trade should be profitable
    const trade = result.trades[0];
    assert.ok(trade.pnl > 0, `Expected positive P&L, got ${trade.pnl}`);

    // Final capital should exceed initial
    assert.ok(result.finalCapital > 10_000, `Expected profit, got ${result.finalCapital}`);
    assert.ok(result.totalReturn > 0, `Expected positive return, got ${result.totalReturn}`);
  });

  it('tracks final capital correctly across multiple trades', () => {
    // Oscillating warmup, then trades
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    // Trade 1: up with pullbacks
    prices.push(103, 102, 106, 105, 109, 108, 112, 111, 116, 115, 120, 121, 125);
    // Back down then up for trade 2
    prices.push(100, 99, 95, 96, 90, 91, 95, 96, 100, 101, 105, 106, 110, 111, 115, 116, 120, 121, 125);

    const bars = makeBars(prices);
    const strategy = makeStrategy({
      stopLoss: 0.50,
      takeProfitPct: 0.20,
      requiredConfirmations: 0,
      maxPositionPct: 100,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });
    // Verify accounting: initial + sum of P&L = final
    const sumPnl = result.trades.reduce((s, t) => s + t.pnl, 0);
    assert.ok(
      Math.abs(result.finalCapital - (10_000 + sumPnl)) < 1,
      `Capital mismatch: final=${result.finalCapital}, expected=${10_000 + sumPnl}`,
    );
  });
});

// ─── Test 2: Stop-loss trigger ───────────────────────────────────────────────

describe('Stop-loss trigger', () => {
  it('exits position when price drops below stop-loss threshold', () => {
    // Price oscillates during warmup, then drops
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    // Buy triggers at warmup end, then price drops past 10% stop
    prices.push(98, 99, 95, 96, 92, 91, 88, 85);

    const bars = makeBars(prices);
    const strategy = makeStrategy({
      stopLoss: 0.10,
      takeProfitPct: 0.50,
      requiredConfirmations: 0,
      maxPositionPct: 100,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });

    assert.ok(result.totalTrades >= 1, `Expected at least 1 trade, got ${result.totalTrades}`);

    const stoppedTrade = result.trades.find((t) => t.reason === 'stop-loss');
    assert.ok(stoppedTrade, 'Expected a stop-loss exit');
    assert.ok(stoppedTrade.pnl < 0, `Stop-loss trade should be negative, got ${stoppedTrade.pnl}`);
    assert.ok(stoppedTrade.exitPrice <= 100 * 0.90, 'Exit price should be at or below stop level');
  });

  it('stop-loss limits maximum loss per trade', () => {
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    prices.push(95, 96, 92, 91, 88, 87, 85, 80, 75);

    const bars = makeBars(prices);
    const strategy = makeStrategy({
      stopLoss: 0.10,
      takeProfitPct: 0.50,
      requiredConfirmations: 0,
      maxPositionPct: 100,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });
    const trade = result.trades[0];
    assert.ok(trade, 'Expected at least one trade');
    // Loss per share should be roughly stopLoss% of entry, not the full drop
    const lossPerShare = trade.entryPrice - trade.exitPrice;
    assert.ok(
      lossPerShare <= trade.entryPrice * 0.15 + 1,
      `Loss per share (${lossPerShare}) too large — stop should have triggered earlier`,
    );
  });
});

// ─── Test 3: Take-profit trigger ─────────────────────────────────────────────

describe('Take-profit trigger', () => {
  it('exits position when price reaches take-profit threshold', () => {
    // Price oscillates during warmup, then trends up with pullbacks to keep RSI moderate
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    // Gentle uptrend with dips every other bar to avoid RSI saturation
    prices.push(103, 102, 106, 105, 109, 108, 112, 111, 116, 115, 120, 121, 125, 130);

    const bars = makeBars(prices);
    const strategy = makeStrategy({
      stopLoss: 0.50,
      takeProfitPct: 0.20,
      requiredConfirmations: 0,
      maxPositionPct: 100,
      rsiOverbought: 99,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });

    assert.ok(result.totalTrades >= 1, `Expected at least 1 trade, got ${result.totalTrades}`);
    const tpTrade = result.trades.find((t) => t.reason === 'take-profit');
    assert.ok(tpTrade, `Expected a take-profit exit, got reasons: ${result.trades.map(t => t.reason).join(', ')}`);
    assert.ok(tpTrade.pnl > 0, 'Take-profit trade should be positive');
  });

  it('take-profit triggers before stop-loss on upward move', () => {
    // Oscillating warmup, then steady up with minor pullbacks
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    // Up with dips to keep RSI from saturating
    for (let i = 1; i <= 12; i++) prices.push(100 + i * 2 + (i % 2 === 0 ? -1 : 0));

    const bars = makeBars(prices);
    const strategy = makeStrategy({
      stopLoss: 0.10,
      takeProfitPct: 0.15,
      requiredConfirmations: 0,
      maxPositionPct: 100,
      rsiOverbought: 99,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });
    const trade = result.trades[0];
    assert.ok(trade, 'Expected at least one trade');
    assert.equal(trade.reason, 'take-profit', `Expected take-profit, got ${trade.reason}`);
  });
});

// ─── Test 4: Empty / insufficient data ───────────────────────────────────────

describe('Empty and insufficient data', () => {
  it('returns zero metrics on empty bar array', () => {
    const strategy = makeStrategy();
    const result = runBacktest({ strategy, bars: [], capital: 10_000 });

    assert.equal(result.totalTrades, 0);
    assert.equal(result.totalReturn, 0);
    assert.equal(result.totalPnL, 0);
    assert.equal(result.maxDrawdown, 0);
    assert.equal(result.finalCapital, 10_000);
    assert.deepEqual(result.trades, []);
  });

  it('returns zero trades with too few bars for indicators', () => {
    // Only 5 bars — not enough for RSI/MACD warmup
    const bars = makeBars([100, 101, 102, 103, 104]);
    const strategy = makeStrategy({
      requiredConfirmations: 2,
      signals: ['rsi', 'macd'],
    });
    const result = runBacktest({ strategy, bars, capital: 10_000 });

    // Should not crash, capital should be unchanged
    assert.equal(result.finalCapital, 10_000);
    assert.equal(result.totalTrades, 0);
  });

  it('handles null bars gracefully', () => {
    const strategy = makeStrategy();
    const result = runBacktest({ strategy, bars: null, capital: 10_000 });

    assert.equal(result.totalTrades, 0);
    assert.equal(result.finalCapital, 10_000);
    assert.ok(result.error);
  });
});

// ─── Test 5: Position sizing ─────────────────────────────────────────────────

describe('Position sizing', () => {
  it('respects maxPositionPct — only invests fraction of capital', () => {
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    prices.push(103, 102, 106, 105, 109, 108, 112, 111, 116, 115, 120, 121, 125);

    const bars = makeBars(prices);
    // Only allow 30% of capital per position
    const strategy = makeStrategy({
      stopLoss: 0.50,
      takeProfitPct: 0.20,
      requiredConfirmations: 0,
      maxPositionPct: 30,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });
    assert.ok(result.totalTrades >= 1);

    const trade = result.trades[0];
    const investedAmount = trade.shares * trade.entryPrice;

    // Should invest ~30% of 10000 = ~3000 (allow some rounding for share lots)
    assert.ok(
      investedAmount <= 3_100,
      `Invested ${investedAmount} exceeds 30% of capital (3000)`,
    );
    assert.ok(
      investedAmount >= 2_900,
      `Invested ${investedAmount} too low — expected ~30% of capital`,
    );
  });

  it('100% position size invests nearly all capital', () => {
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    prices.push(103, 102, 106, 105, 120, 121, 125);

    const bars = makeBars(prices);
    const strategy = makeStrategy({
      stopLoss: 0.50,
      takeProfitPct: 0.20,
      requiredConfirmations: 0,
      maxPositionPct: 100,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });
    const trade = result.trades[0];
    const investedAmount = trade.shares * trade.entryPrice;

    assert.ok(investedAmount >= 9_900, `Expected ~100% invested, got ${investedAmount}`);
  });
});

// ─── Test 6: Metrics computation ─────────────────────────────────────────────

describe('Metrics computation', () => {
  it('win rate is calculated correctly', () => {
    const prices = [];
    for (let i = 0; i < 27; i++) prices.push(100 + (i % 3 === 0 ? -1 : 1));
    // Trade 1: win (up with dips)
    prices.push(103, 102, 106, 105, 109, 108, 112, 111, 116, 115, 120, 121, 125);
    // Trade 2: loss (down)
    prices.push(100, 99, 95, 96, 92, 91, 88, 85);
    // Trade 3: win (up again)
    prices.push(90, 89, 95, 94, 100, 99, 105, 104, 110, 109, 115, 114, 120, 125, 130);

    const bars = makeBars(prices);
    const strategy = makeStrategy({
      stopLoss: 0.10,
      takeProfitPct: 0.20,
      requiredConfirmations: 0,
      maxPositionPct: 100,
    });

    const result = runBacktest({ strategy, bars, capital: 10_000 });
    // There should be at least one win and one loss
    const wins = result.trades.filter((t) => t.pnl > 0);
    const losses = result.trades.filter((t) => t.pnl <= 0);

    if (result.totalTrades > 0) {
      const expectedWinRate = (wins.length / result.totalTrades) * 100;
      assert.ok(
        Math.abs(result.winRate - expectedWinRate) < 0.01,
        `Win rate mismatch: got ${result.winRate}, expected ${expectedWinRate}`,
      );
    }
  });

  it('max drawdown is non-negative', () => {
    const prices = [];
    for (let i = 0; i < 35; i++) prices.push(100 + Math.sin(i / 3) * 15);
    const bars = makeBars(prices);
    const strategy = makeStrategy({ requiredConfirmations: 0, maxPositionPct: 100 });
    const result = runBacktest({ strategy, bars, capital: 10_000 });
    assert.ok(result.maxDrawdown >= 0, `Drawdown should be >= 0, got ${result.maxDrawdown}`);
  });

  it('Sharpe ratio is a number (not NaN)', () => {
    const prices = [];
    for (let i = 0; i < 30; i++) prices.push(100 + i * 0.5);
    const bars = makeBars(prices);
    const strategy = makeStrategy({ requiredConfirmations: 0 });
    const result = runBacktest({ strategy, bars, capital: 10_000 });
    assert.ok(!isNaN(result.sharpeRatio), 'Sharpe ratio should not be NaN');
    assert.equal(typeof result.sharpeRatio, 'number');
  });
});

// ─── Test 7: Bar normalisation ───────────────────────────────────────────────

describe('Bar normalisation', () => {
  it('normalises Alpaca short-key format', () => {
    const raw = [
      { t: '2025-01-02T05:00:00Z', o: 100, h: 105, l: 99, c: 103, v: 5000 },
    ];
    const bars = normaliseBars(raw);
    assert.equal(bars.length, 1);
    assert.equal(bars[0].close, 103);
    assert.equal(bars[0].open, 100);
  });

  it('normalises Go-style capitalised keys', () => {
    const raw = [
      { Timestamp: '2025-01-02T05:00:00Z', Open: 100, High: 105, Low: 99, Close: 103, Volume: 5000 },
    ];
    const bars = normaliseBars(raw);
    assert.equal(bars.length, 1);
    assert.equal(bars[0].close, 103);
  });

  it('unwraps nested { bars: [...] } response', () => {
    const raw = {
      bars: [
        { t: '2025-01-02T05:00:00Z', o: 100, h: 105, l: 99, c: 103, v: 5000 },
      ],
    };
    const bars = normaliseBars(raw);
    assert.equal(bars.length, 1);
  });

  it('filters out bars with zero close price', () => {
    const raw = [
      { t: '2025-01-02T05:00:00Z', o: 100, h: 105, l: 99, c: 0, v: 5000 },
      { t: '2025-01-03T05:00:00Z', o: 100, h: 105, l: 99, c: 103, v: 5000 },
    ];
    const bars = normaliseBars(raw);
    assert.equal(bars.length, 1);
  });
});

// ─── Test 8: Indicator correctness ───────────────────────────────────────────

describe('Technical indicators', () => {
  it('SMA produces correct values', () => {
    const values = [1, 2, 3, 4, 5];
    const result = sma(values, 3);
    assert.equal(result[0], null);
    assert.equal(result[1], null);
    assert.equal(result[2], 2); // (1+2+3)/3
    assert.equal(result[3], 3); // (2+3+4)/3
    assert.equal(result[4], 4); // (3+4+5)/3
  });

  it('RSI returns null for warmup period', () => {
    const values = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = rsi(values, 14);
    assert.equal(result[0], null);
    assert.equal(result[13], null);
    assert.ok(result[14] !== null, 'RSI should be computed at index 14');
  });

  it('RSI is 100 when price only goes up', () => {
    const values = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = rsi(values, 14);
    assert.equal(result[14], 100);
  });
});

// ─── Test 9: Sample data file loads correctly ────────────────────────────────

describe('Sample data integration', () => {
  it('loads and runs backtest on AAPL-2025.json sample data', () => {
    const bars = loadBarsFromFile(resolve(__dirname, 'sample-data', 'AAPL-2025.json'));
    assert.equal(bars.length, 20);
    assert.ok(bars[0].close > 0);
    assert.ok(bars[0].timestamp);

    // Run with a simple strategy — should not crash
    const strategy = makeStrategy({
      requiredConfirmations: 0,
      maxPositionPct: 100,
      stopLoss: 0.10,
      takeProfitPct: 0.50,
    });
    const result = runBacktest({ strategy, bars, capital: 10_000 });
    assert.ok(result.barsProcessed === 20);
    assert.ok(typeof result.totalReturn === 'number');
  });
});
