/**
 * Tests for position-sizing.js — Kelly, volatility, and options sizing.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateKellySize,
  calculateVolatilityAdjustedSize,
  calculateOptionsSize,
  getPositionSizingToolDefinition,
  handlePositionSizingToolCall,
} from '../position-sizing.js';

// ─── Kelly Criterion ─────────────────────────────────────────────────────────

describe('calculateKellySize', () => {
  it('60% win rate with 5/3 W/L → positive edge and reasonable size', () => {
    const r = calculateKellySize({
      winRate: 0.60, avgWinPct: 5, avgLossPct: 3,
      accountEquity: 100_000, price: 50,
    });
    assert.ok(r.fullKellyPct > 0, 'full Kelly should be positive');
    assert.ok(r.edge > 0, 'edge should be positive');
    assert.ok(r.adjustedKellyPct > 0 && r.adjustedKellyPct < r.fullKellyPct,
      'quarter-Kelly should be between 0 and full Kelly');
    assert.ok(r.recommendedPct >= 1 && r.recommendedPct <= 30,
      `recommendedPct ${r.recommendedPct} out of sensible range`);
    assert.ok(r.recommendedDollars > 0);
    assert.ok(r.maxSharesAtPrice > 0);
    assert.ok(['high', 'medium', 'low'].includes(r.confidence));
    assert.ok(r.reasoning.length > 0);
  });

  it('30% win rate → negative edge, zero position', () => {
    const r = calculateKellySize({
      winRate: 0.30, avgWinPct: 3, avgLossPct: 3,
      accountEquity: 100_000,
    });
    assert.ok(r.fullKellyPct <= 0, 'full Kelly should be non-positive');
    assert.equal(r.adjustedKellyPct, 0);
    assert.equal(r.recommendedPct, 0);
    assert.equal(r.recommendedDollars, 0);
    assert.equal(r.maxSharesAtPrice, 0);
    assert.equal(r.confidence, 'low');
  });

  it('respects maxPositionPct cap', () => {
    const r = calculateKellySize({
      winRate: 0.80, avgWinPct: 10, avgLossPct: 2,
      accountEquity: 100_000, maxPositionPct: 5,
    });
    assert.ok(r.fullKellyPct > 5, 'raw Kelly should exceed cap');
    assert.ok(r.recommendedPct <= 5, 'recommended should respect cap');
  });

  it('zero equity → zero dollars', () => {
    const r = calculateKellySize({
      winRate: 0.60, avgWinPct: 5, avgLossPct: 3,
      accountEquity: 0, price: 50,
    });
    assert.equal(r.recommendedDollars, 0);
    assert.equal(r.maxSharesAtPrice, 0);
  });
});

// ─── Volatility-Adjusted Sizing ──────────────────────────────────────────────

describe('calculateVolatilityAdjustedSize', () => {
  it('$100k equity, $50→$48 stop → correct shares and risk', () => {
    const r = calculateVolatilityAdjustedSize({
      accountEquity: 100_000, entryPrice: 50, stopLossPrice: 48,
    });
    // default risk = 2% → $2,000 budget, $2/share risk → 1000 shares
    assert.equal(r.riskPerShare, 2);
    assert.equal(r.shares, 1000);
    assert.equal(r.totalRiskDollars, 2000);
    assert.equal(r.positionDollars, 50_000);
    assert.equal(r.positionPct, 50);
    assert.ok(r.reasoning.length > 0);
  });

  it('ATR widens stop distance when stop is tighter than ATR', () => {
    const r = calculateVolatilityAdjustedSize({
      accountEquity: 100_000, entryPrice: 50, stopLossPrice: 49,
      currentATR: 3,
    });
    // stop distance $1 < ATR $3, widened to $3 → $2000 / $3 = 666 shares
    assert.equal(r.riskPerShare, 3);
    assert.equal(r.shares, 666);
    assert.ok(r.reasoning.includes('ATR'));
  });

  it('equal entry and stop → zero shares', () => {
    const r = calculateVolatilityAdjustedSize({
      accountEquity: 100_000, entryPrice: 50, stopLossPrice: 50,
    });
    assert.equal(r.shares, 0);
    assert.equal(r.riskPerShare, 0);
  });
});

// ─── Options Sizing ──────────────────────────────────────────────────────────

describe('calculateOptionsSize', () => {
  it('$100k equity, $3.50 premium → reasonable contracts', () => {
    const r = calculateOptionsSize({
      accountEquity: 100_000, contractPrice: 3.50,
    });
    assert.ok(r.contracts > 0, 'should recommend at least 1 contract');
    assert.ok(r.contracts <= 10, 'should not exceed default maxContracts');
    assert.equal(r.totalPremium, r.contracts * 350);
    assert.equal(r.totalRiskDollars, r.totalPremium);
    assert.ok(r.positionPct > 0 && r.positionPct <= 5,
      `positionPct ${r.positionPct} out of range — delta weighting may exceed raw budget`);
    assert.ok(r.deltaAdjustedPct <= r.positionPct);
    assert.ok(r.reasoning.length > 0);
  });
});

// ─── MCP Tool Definition ─────────────────────────────────────────────────────

describe('getPositionSizingToolDefinition', () => {
  it('returns valid MCP tool schema', () => {
    const def = getPositionSizingToolDefinition();
    assert.equal(def.name, 'calculate_position_size');
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 10);
    assert.equal(def.inputSchema.type, 'object');
    assert.ok(def.inputSchema.properties.symbol);
    assert.ok(def.inputSchema.properties.price);
    assert.ok(Array.isArray(def.inputSchema.required));
    assert.ok(def.inputSchema.required.includes('symbol'));
    assert.ok(def.inputSchema.required.includes('price'));
  });
});
