/**
 * Tests for perf-analytics.js — performance analytics engine.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  generateEquityCurve,
  calculatePerformanceMetrics,
  generatePerformanceReport,
  getPerformanceToolDefinition,
  handlePerformanceToolCall,
} from '../perf-analytics.js';

const trades = [
  { symbol: 'AAPL', side: 'buy', entryPrice: 150, exitPrice: 155, qty: 10, pnl: 50, date: '2024-01-15', strategy: 'momentum' },
  { symbol: 'MSFT', side: 'buy', entryPrice: 380, exitPrice: 375, qty: 5, pnl: -25, date: '2024-01-16', strategy: 'momentum' },
  { symbol: 'AAPL', side: 'buy', entryPrice: 152, exitPrice: 160, qty: 10, pnl: 80, date: '2024-01-17', strategy: 'momentum' },
];

// ─── Sharpe Ratio ───────────────────────────────────────────────────────────

describe('calculateSharpeRatio', () => {
  it('returns a positive ratio for consistent positive returns', () => {
    const returns = [0.01, 0.02, 0.015, 0.012, 0.018, 0.011, 0.014];
    const sharpe = calculateSharpeRatio(returns);
    assert.ok(sharpe > 0, `expected positive Sharpe, got ${sharpe}`);
  });

  it('handles zero variance gracefully (returns 0)', () => {
    const returns = [0.01, 0.01, 0.01, 0.01, 0.01];
    const sharpe = calculateSharpeRatio(returns);
    assert.equal(sharpe, 0, 'zero-variance returns should yield 0');
  });
});

// ─── Sortino Ratio ──────────────────────────────────────────────────────────

describe('calculateSortinoRatio', () => {
  it('is >= Sharpe for the same data (uses only downside deviation)', () => {
    const returns = [0.02, -0.005, 0.01, -0.003, 0.015, 0.008, -0.002];
    const sharpe = calculateSharpeRatio(returns);
    const sortino = calculateSortinoRatio(returns);
    assert.ok(
      sortino >= sharpe,
      `Sortino (${sortino}) should be >= Sharpe (${sharpe}) when positive returns exist`,
    );
  });
});

// ─── Max Drawdown ───────────────────────────────────────────────────────────

describe('calculateMaxDrawdown', () => {
  it('computes ~18.18% drawdown for [100,110,90,95,105]', () => {
    const dd = calculateMaxDrawdown([100, 110, 90, 95, 105]);
    // peak 110 → trough 90 = 18.18%
    assert.ok(
      Math.abs(dd.maxDrawdownPct - 18.18) < 0.1,
      `expected ~18.18%, got ${dd.maxDrawdownPct}%`,
    );
    assert.equal(dd.maxDrawdownDollars, 20);
    assert.ok(dd.drawdownPeriods.length >= 1, 'should record at least one drawdown period');
  });

  it('returns 0% for monotonically increasing equity', () => {
    const dd = calculateMaxDrawdown([100, 110, 120, 130, 140]);
    assert.equal(dd.maxDrawdownPct, 0);
    assert.equal(dd.maxDrawdownDollars, 0);
    assert.equal(dd.drawdownPeriods.length, 0);
  });
});

// ─── Equity Curve ───────────────────────────────────────────────────────────

describe('generateEquityCurve', () => {
  it('builds correct cumulative P&L for 3 trades on different days', () => {
    const curve = generateEquityCurve(trades, 10_000);
    assert.equal(curve.length, 3, 'one entry per unique trade date');

    assert.equal(curve[0].dailyPnl, 50);
    assert.equal(curve[0].cumulativePnl, 50);
    assert.equal(curve[0].equity, 10_050);

    assert.equal(curve[1].dailyPnl, -25);
    assert.equal(curve[1].cumulativePnl, 25);
    assert.equal(curve[1].equity, 10_025);

    assert.equal(curve[2].dailyPnl, 80);
    assert.equal(curve[2].cumulativePnl, 105);
    assert.equal(curve[2].equity, 10_105);
  });
});

// ─── Performance Metrics ────────────────────────────────────────────────────

describe('calculatePerformanceMetrics', () => {
  it('returns correct winRate and profitFactor for mixed trades', () => {
    const metrics = calculatePerformanceMetrics(trades);
    // 2 winners out of 3
    assert.ok(
      Math.abs(metrics.winRate - 2 / 3) < 0.01,
      `expected winRate ~0.667, got ${metrics.winRate}`,
    );
    // profitFactor = grossWins / grossLosses = 130 / 25 = 5.2
    assert.ok(
      Math.abs(metrics.profitFactor - 5.2) < 0.1,
      `expected profitFactor ~5.2, got ${metrics.profitFactor}`,
    );
    assert.equal(metrics.totalTrades, 3);
  });
});

// ─── Performance Report ─────────────────────────────────────────────────────

describe('generatePerformanceReport', () => {
  it('returns a non-empty formatted string', () => {
    const report = generatePerformanceReport(trades, 10_000);
    assert.equal(typeof report, 'string');
    assert.ok(report.length > 0, 'report should not be empty');
  });
});

// ─── MCP Tool Definition ───────────────────────────────────────────────────

describe('getPerformanceToolDefinition', () => {
  it('returns a valid MCP tool schema', () => {
    const def = getPerformanceToolDefinition();
    assert.ok(def.name, 'tool definition must have a name');
    assert.ok(def.description, 'tool definition must have a description');
    assert.ok(def.inputSchema || def.parameters, 'tool must declare input schema or parameters');
  });
});
