/**
 * Tests for regime-detector.js — market regime detection engine.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSMA,
  calculateRSI,
  calculateMACD,
  calculateADX,
  calculateVolatility,
  detectRegime,
  getRegimeHistory,
  getRegimeToolDefinition,
  handleRegimeToolCall,
} from '../regime-detector.js';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

/** 250 bars in a smooth uptrend (400 → 525) */
const bullBars = Array.from({ length: 250 }, (_, i) => ({
  c: 400 + i * 0.5, h: 402 + i * 0.5,
  l: 399 + i * 0.5, o: 400 + i * 0.5, v: 5_000_000,
}));

/** 250 bars in a steep downtrend (500 → 125) */
const bearBars = Array.from({ length: 250 }, (_, i) => ({
  c: 500 - i * 1.5, h: 502 - i * 1.5,
  l: 498 - i * 1.5, o: 500 - i * 1.5, v: 8_000_000,
}));

// ---------------------------------------------------------------------------
// calculateSMA
// ---------------------------------------------------------------------------
describe('calculateSMA', () => {
  it('returns correct SMA for known values', () => {
    const bars = [100, 102, 104, 106, 108].map((c) => ({ c }));
    const sma = calculateSMA(bars, 3);
    // last 3 closes: 104, 106, 108 → mean = 106
    assert.equal(sma, 106);
  });

  it('returns NaN when data is insufficient', () => {
    const bars = [{ c: 100 }, { c: 102 }];
    const sma = calculateSMA(bars, 5);
    assert.ok(Number.isNaN(sma), 'expected NaN for insufficient data');
  });
});

// ---------------------------------------------------------------------------
// calculateRSI
// ---------------------------------------------------------------------------
describe('calculateRSI', () => {
  it('returns RSI > 50 for an uptrend', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ c: 100 + i * 2 }));
    const rsi = calculateRSI(bars, 14);
    assert.ok(rsi > 50, `expected RSI > 50, got ${rsi}`);
  });

  it('returns RSI between 0 and 100', () => {
    const rsi = calculateRSI(bullBars, 14);
    assert.ok(rsi >= 0 && rsi <= 100, `RSI out of range: ${rsi}`);
  });
});

// ---------------------------------------------------------------------------
// calculateMACD
// ---------------------------------------------------------------------------
describe('calculateMACD', () => {
  it('returns an object with macd, signal, histogram', () => {
    const result = calculateMACD(bullBars);
    assert.ok(typeof result === 'object' && result !== null);
    assert.ok('macd' in result, 'missing macd property');
    assert.ok('signal' in result, 'missing signal property');
    assert.ok('histogram' in result, 'missing histogram property');
  });

  it('histogram equals macd minus signal', () => {
    const { macd, signal, histogram } = calculateMACD(bullBars, 12, 26, 9);
    const expected = macd - signal;
    assert.ok(Math.abs(histogram - expected) < 1e-9, 'histogram ≠ macd - signal');
  });
});

// ---------------------------------------------------------------------------
// calculateADX & calculateVolatility (smoke tests)
// ---------------------------------------------------------------------------
describe('calculateADX', () => {
  it('returns a number between 0 and 100', () => {
    const adx = calculateADX(bullBars, 14);
    assert.equal(typeof adx, 'number');
    assert.ok(adx >= 0 && adx <= 100, `ADX out of range: ${adx}`);
  });
});

describe('calculateVolatility', () => {
  it('returns a non-negative number', () => {
    const vol = calculateVolatility(bullBars, 20);
    assert.equal(typeof vol, 'number');
    assert.ok(vol >= 0, `volatility should be non-negative: ${vol}`);
  });
});

// ---------------------------------------------------------------------------
// detectRegime
// ---------------------------------------------------------------------------
describe('detectRegime', () => {
  it('detects bull regime for a strong uptrend with low VIX', () => {
    const result = detectRegime({ spyBars: bullBars, vixLevel: 14 });
    assert.equal(result.regime, 'bull');
    assert.ok(result.confidence > 0, 'confidence should be positive');
    assert.ok(typeof result.signals === 'object' && result.signals !== null, 'signals should be an object');
    assert.ok(result.reasoning || result.strategyRecommendation, 'should include reasoning or strategy recommendation');
  });

  it('detects bear or crash regime for steep decline', () => {
    const result = detectRegime({ spyBars: bearBars, vixLevel: 35 });
    assert.ok(
      result.regime === 'bear' || result.regime === 'crash',
      `expected bear/crash, got ${result.regime}`,
    );
  });

  it('includes strategyRecommendation in output', () => {
    const result = detectRegime({ spyBars: bullBars });
    assert.ok('strategyRecommendation' in result, 'missing strategyRecommendation');
  });
});

// ---------------------------------------------------------------------------
// getRegimeHistory
// ---------------------------------------------------------------------------
describe('getRegimeHistory', () => {
  it('tracks current regime and transitions', () => {
    const entries = [
      { regime: 'bull', confidence: 0.8, date: '2025-01-01' },
      { regime: 'bull', confidence: 0.7, date: '2025-01-15' },
      { regime: 'bear', confidence: 0.6, date: '2025-02-01' },
    ];
    const history = getRegimeHistory(entries);
    assert.equal(history.currentRegime, 'bear');
    assert.ok(typeof history.daysSinceChange === 'number');
    assert.ok(Array.isArray(history.regimeChanges));
    assert.ok(history.regimeChanges.length >= 1, 'should record at least one transition');
  });
});

// ---------------------------------------------------------------------------
// MCP tool definition
// ---------------------------------------------------------------------------
describe('getRegimeToolDefinition', () => {
  it('returns a valid MCP tool schema', () => {
    const def = getRegimeToolDefinition();
    assert.ok(def.name, 'tool schema must have a name');
    assert.ok(def.description, 'tool schema must have a description');
    assert.ok(def.inputSchema || def.parameters, 'tool schema must define inputs');
  });
});
