/**
 * Tests for vol-analysis.js — Options volatility analysis module.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateIVRank,
  calculateIVPercentile,
  calculateHistoricalVol,
  analyzeSkew,
  analyzeTermStructure,
  getVolAnalysisToolDefinition,
  handleVolAnalysisToolCall,
} from '../vol-analysis.js';

// ─── Test Data Helpers ──────────────────────────────────────────────────────

/** Generate N daily bars with a gentle upward drift. */
function makeBars(count) {
  return Array.from({ length: count }, (_, i) => ({
    t: Date.now() - (count - i) * 86_400_000,
    o: 100 + i * 0.5,
    h: 102 + i * 0.5,
    l: 99 + i * 0.5,
    c: 101 + i * 0.5,
    v: 1_000_000,
  }));
}

/** Build a simple option entry. */
function opt(type, strike, iv, delta, expiration = '2025-06-20') {
  return { type, strike, bid: iv * 0.9, ask: iv * 1.1, implied_volatility: iv, delta, open_interest: 500, expiration };
}

// ─── IV Rank ────────────────────────────────────────────────────────────────

describe('calculateIVRank', () => {
  it('returns 50 when currentIV is midpoint of range', () => {
    const history = [20, 25, 30, 35, 40];
    assert.equal(calculateIVRank(30, history), 50);
  });

  it('returns 0 when currentIV equals historical low', () => {
    const history = [20, 25, 30, 35, 40];
    assert.equal(calculateIVRank(20, history), 0);
  });

  it('returns 100 when currentIV equals historical high', () => {
    const history = [20, 25, 30, 35, 40];
    assert.equal(calculateIVRank(40, history), 100);
  });

  it('returns -1 with empty history', () => {
    assert.equal(calculateIVRank(30, []), -1);
  });

  it('returns -1 with null history', () => {
    assert.equal(calculateIVRank(30, null), -1);
  });

  it('returns -1 when history contains only non-positive values', () => {
    assert.equal(calculateIVRank(30, [0, -5, -10]), -1);
  });

  it('returns 50 when all history values are identical', () => {
    assert.equal(calculateIVRank(30, [30, 30, 30]), 50);
  });
});

// ─── IV Percentile ──────────────────────────────────────────────────────────

describe('calculateIVPercentile', () => {
  it('returns 75 when 75% of history is below currentIV', () => {
    // 3 of 4 values below 35 → 75th percentile
    const history = [10, 20, 30, 40];
    assert.equal(calculateIVPercentile(35, history), 75);
  });

  it('returns 0 when currentIV is below all values', () => {
    assert.equal(calculateIVPercentile(5, [10, 20, 30]), 0);
  });

  it('returns 100 when currentIV is above all values', () => {
    assert.equal(calculateIVPercentile(50, [10, 20, 30]), 100);
  });

  it('returns -1 with empty or null history', () => {
    assert.equal(calculateIVPercentile(30, []), -1);
    assert.equal(calculateIVPercentile(30, null), -1);
  });
});

// ─── Historical Volatility ──────────────────────────────────────────────────

describe('calculateHistoricalVol', () => {
  it('returns a reasonable annualized vol for 30 bars', () => {
    const bars = makeBars(30);
    const hv = calculateHistoricalVol(bars);
    assert.ok(hv > 0, `expected hv > 0, got ${hv}`);
    assert.ok(hv < 200, `expected hv < 200, got ${hv}`);
  });

  it('returns -1 with insufficient bars (< period + 1)', () => {
    assert.equal(calculateHistoricalVol(makeBars(5)), -1);
  });

  it('returns -1 with null or empty input', () => {
    assert.equal(calculateHistoricalVol(null), -1);
    assert.equal(calculateHistoricalVol([]), -1);
  });

  it('respects custom period parameter', () => {
    const bars = makeBars(15);
    // period=10 needs 11 bars, 15 bars should suffice
    const hv = calculateHistoricalVol(bars, 10);
    assert.ok(hv > 0, `expected hv > 0 with period=10, got ${hv}`);
  });
});

// ─── Skew Analysis ──────────────────────────────────────────────────────────

describe('analyzeSkew', () => {
  it('detects put-heavy skew when put IV exceeds call IV', () => {
    const chain = [
      opt('put',  95, 40, -0.50),  // ATM put with high IV
      opt('call', 105, 28, 0.50),  // ATM call with lower IV
      opt('put',  85, 45, -0.25),  // OTM put wing — expensive
      opt('call', 115, 25, 0.25),  // OTM call wing — cheap
    ];
    const result = analyzeSkew(chain);
    assert.equal(result.skewDirection, 'put_heavy');
    assert.ok(result.skew25Delta > 0, 'skew25Delta should be positive for put-heavy');
    assert.ok(result.putCallRatio > 1, 'putCallRatio should exceed 1');
  });

  it('returns neutral defaults for empty chain', () => {
    const result = analyzeSkew([]);
    assert.equal(result.skewDirection, 'neutral');
    assert.equal(result.putCallRatio, 1.0);
    assert.equal(result.skew25Delta, 0);
  });

  it('returns neutral defaults for null chain', () => {
    const result = analyzeSkew(null);
    assert.equal(result.skewDirection, 'neutral');
  });
});

// ─── Term Structure ─────────────────────────────────────────────────────────

describe('analyzeTermStructure', () => {
  it('detects contango when near-term IV < far-term IV', () => {
    const nearChain = [
      opt('call', 100, 20, 0.50, '2025-06-20'),
      opt('put',  100, 20, -0.50, '2025-06-20'),
    ];
    const farChain = [
      opt('call', 100, 30, 0.50, '2025-09-19'),
      opt('put',  100, 30, -0.50, '2025-09-19'),
    ];
    const result = analyzeTermStructure([nearChain, farChain]);
    assert.equal(result.shape, 'contango');
    assert.ok(result.spread > 0, 'spread should be positive in contango');
    assert.equal(result.expirations.length, 2);
  });

  it('returns flat shape with fewer than 2 chains', () => {
    const result = analyzeTermStructure([]);
    assert.equal(result.shape, 'flat');
    assert.equal(result.expirations.length, 0);
  });

  it('returns flat shape for null input', () => {
    const result = analyzeTermStructure(null);
    assert.equal(result.shape, 'flat');
  });
});

// ─── MCP Tool Definition ────────────────────────────────────────────────────

describe('getVolAnalysisToolDefinition', () => {
  it('returns a valid MCP tool schema', () => {
    const def = getVolAnalysisToolDefinition();
    assert.equal(typeof def.name, 'string');
    assert.ok(def.name.length > 0);
    assert.equal(typeof def.description, 'string');
    assert.ok(def.inputSchema);
    assert.equal(def.inputSchema.type, 'object');
    assert.ok(def.inputSchema.properties);
    assert.ok(Array.isArray(def.inputSchema.required));
    assert.ok(def.inputSchema.required.includes('symbol'));
  });
});

// ─── MCP Tool Call Handler ──────────────────────────────────────────────────

describe('handleVolAnalysisToolCall', () => {
  it('returns error when symbol is missing', () => {
    const result = handleVolAnalysisToolCall({});
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('symbol'));
  });

  it('returns missing_data guidance when chain/bars absent', () => {
    const result = handleVolAnalysisToolCall({ symbol: 'SPY' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, 'missing_data');
    assert.ok(parsed.missing.length > 0);
  });
});
