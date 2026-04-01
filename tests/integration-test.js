#!/usr/bin/env node
/**
 * integration-test.js — Dry-run the full trading pipeline without live services.
 * Tests: risk guard → position sizing → correlation check → vol analysis →
 *        execution tracking → performance analytics → regime detection
 *
 * Run: node tests/integration-test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, resetGuard } from '../risk-guard.js';
import { calculateKellySize, calculateVolatilityAdjustedSize, calculateOptionsSize } from '../position-sizing.js';
import { analyzePortfolioRisk } from '../correlation-guard.js';
import { analyzeVolatility, calculateHistoricalVol } from '../vol-analysis.js';
import { createExecutionTracker } from '../execution-tracker.js';
import { calculatePerformanceMetrics, generatePerformanceReport, generateEquityCurve } from '../perf-analytics.js';
import { detectRegime, calculateSMA, calculateMACD, calculateRSI } from '../regime-detector.js';
import { validateEnv } from '../env-check.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// Helper: generate fake daily bars
function makeBars(count, startPrice = 450, trend = 0.0005) {
  const bars = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price *= (1 + trend + (Math.random() - 0.5) * 0.02);
    const d = new Date(2025, 0, 2 + i);
    bars.push({
      t: d.toISOString(),
      o: price * (1 - Math.random() * 0.005),
      h: price * (1 + Math.random() * 0.01),
      l: price * (1 - Math.random() * 0.01),
      c: price,
      v: Math.floor(50e6 + Math.random() * 50e6),
    });
  }
  return bars;
}

describe('Integration: Full Trading Pipeline', () => {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'openprophet-test-'));

  it('Step 1: Env validation runs without crash', () => {
    const saved = { ...process.env };
    process.env.ALPACA_PUBLIC_KEY = 'test';
    process.env.ALPACA_SECRET_KEY = 'test';
    process.env.TRADING_BOT_URL = 'http://localhost:4534';
    const result = validateEnv({ fatal: false });
    assert.ok(result.ok, 'Should pass with required vars set');
    Object.keys(process.env).forEach(k => { if (!(k in saved)) delete process.env[k]; });
    Object.assign(process.env, saved);
  });

  it('Step 2: Risk guard validates a buy order', async () => {
    resetGuard();
    const guard = createGuard({
      accountSize: 100000,
      maxPositionPct: 30,
      maxCashDeployedPct: 80,
      maxOpenPositions: 5,
      maxDailyTrades: 10,
      maxDrawdownPct: 20,
      revengeCooldownMs: 60000,
      _stateFile: join(tmpDir, 'guard.json'),
    }, 'test-acct');

    const result = await guard.validateOrder(
      { symbol: 'AAPL', side: 'buy', qty: 10, type: 'limit', limit_price: 180 },
      { equity: 100000, cash: 60000, buyingPower: 60000, openPositions: 1, dailyPL: -200 }
    );
    assert.ok(result.allowed, `Order should be allowed: ${JSON.stringify(result.violations)}`);
  });

  it('Step 3: Risk guard blocks oversized position', async () => {
    resetGuard();
    const guard = createGuard({
      accountSize: 100000,
      maxPositionPct: 10,
      _stateFile: join(tmpDir, 'guard2.json'),
    }, 'test-acct-2');

    const result = await guard.validateOrder(
      { symbol: 'NVDA', side: 'buy', qty: 100, type: 'limit', limit_price: 800 },
      { equity: 100000, cash: 90000, buyingPower: 90000, openPositions: 0, dailyPL: 0 }
    );
    assert.ok(!result.allowed, 'Should block: $80k order on $100k account with 10% max');
  });

  it('Step 4: Kelly position sizing recommends conservative size', () => {
    const result = calculateKellySize({
      winRate: 0.55,
      avgWinPct: 5,
      avgLossPct: 3,
      accountEquity: 100000,
      maxPositionPct: 30,
      kellyFraction: 0.25,
      currentExposurePct: 20,
    });
    assert.ok(result.recommendedPct > 0, 'Should recommend positive position');
    assert.ok(result.recommendedPct <= 30, 'Should not exceed max position');
    assert.ok(result.edge > 0, 'Should show positive edge');
    assert.ok(result.reasoning.length > 0, 'Should explain reasoning');
  });

  it('Step 5: Vol-adjusted sizing with stop loss', () => {
    const result = calculateVolatilityAdjustedSize({
      accountEquity: 100000,
      riskPerTradePct: 2,
      entryPrice: 150,
      stopLossPrice: 145,
    });
    // Risk = $2000, risk per share = $5, so ~400 shares
    assert.ok(result.shares > 0, 'Should recommend shares');
    assert.ok(result.shares <= 500, 'Should be reasonable quantity');
  });

  it('Step 6: Correlation guard detects concentration', () => {
    const positions = [
      { symbol: 'AAPL', market_value: 30000 },
      { symbol: 'MSFT', market_value: 25000 },
      { symbol: 'NVDA', market_value: 20000 },
      { symbol: 'GOOGL', market_value: 15000 },
    ];
    const result = analyzePortfolioRisk(positions, { symbol: 'AMD', amount_pct: 10 });
    assert.ok(result.warnings.length > 0, 'Should warn about tech concentration');
    assert.ok(result.metrics.sectorConcentration, 'Should report sector data');
  });

  it('Step 7: Vol analysis calculates historical vol', () => {
    const bars = makeBars(30);
    const hv = calculateHistoricalVol(bars, 20);
    assert.ok(typeof hv === 'number', 'Should return a number');
    assert.ok(hv > 0 && hv < 200, `HV should be reasonable: got ${hv}`);
  });

  it('Step 8: RSI calculation', () => {
    const bars = makeBars(30);
    const rsi = calculateRSI(bars, 14);
    assert.ok(rsi >= 0 && rsi <= 100, `RSI should be 0-100: got ${rsi}`);
  });

  it('Step 9: Regime detection on bull market data', () => {
    const bars = makeBars(250, 400, 0.001); // uptrend
    const result = detectRegime({ spyBars: bars });
    assert.ok(result.regime, 'Should classify a regime');
    assert.ok(['bull', 'bear', 'chop', 'crash', 'recovery'].includes(result.regime));
    assert.ok(result.confidence >= 0 && result.confidence <= 100);
    assert.ok(result.signals.trend, 'Should have trend signals');
    assert.ok(result.signals.momentum, 'Should have momentum signals');
    assert.ok(result.strategyRecommendation, 'Should recommend strategy');
  });

  it('Step 10: Execution tracker records and reports', () => {
    const tracker = createExecutionTracker(tmpDir);
    tracker.recordOrder({
      orderId: 'ord-001', symbol: 'SPY', side: 'buy', qty: 50,
      type: 'limit', limitPrice: 450, bid: 449.90, ask: 450.10,
    });
    tracker.recordFill('ord-001', { price: 449.95, qty: 50 });

    const stats = tracker.getExecutionStats();
    assert.equal(stats.totalOrders, 1);
    assert.equal(stats.filledOrders, 1);
    assert.equal(stats.fillRate, 100);
    assert.ok(stats.avgSlippagePct !== undefined, 'Should track slippage');
  });

  it('Step 11: Performance metrics from trade data', () => {
    const trades = [
      { symbol: 'AAPL', side: 'buy', entryPrice: 150, exitPrice: 160, qty: 10, pnl: 100, date: '2025-01-10' },
      { symbol: 'MSFT', side: 'buy', entryPrice: 300, exitPrice: 290, qty: 5, pnl: -50, date: '2025-01-12' },
      { symbol: 'SPY', side: 'buy', entryPrice: 450, exitPrice: 465, qty: 20, pnl: 300, date: '2025-01-15' },
      { symbol: 'NVDA', side: 'buy', entryPrice: 800, exitPrice: 780, qty: 3, pnl: -60, date: '2025-01-17' },
      { symbol: 'AAPL', side: 'buy', entryPrice: 155, exitPrice: 170, qty: 10, pnl: 150, date: '2025-01-20' },
    ];
    const metrics = calculatePerformanceMetrics(trades);
    assert.equal(metrics.totalTrades, 5);
    assert.equal(metrics.winners, 3);
    assert.equal(metrics.losers, 2);
    assert.ok(metrics.winRate > 0.5, 'Win rate should be 60%');
    assert.ok(metrics.profitFactor > 1, 'Should be profitable');
    assert.ok(metrics.expectancy > 0, 'Positive expectancy');
  });

  it('Step 12: Equity curve generation', () => {
    const trades = [
      { pnl: 500, date: '2025-01-10' },
      { pnl: -200, date: '2025-01-12' },
      { pnl: 800, date: '2025-01-15' },
    ];
    const curve = generateEquityCurve(trades, 100000);
    assert.ok(curve.length > 0, 'Should produce equity points');
    const last = curve[curve.length - 1];
    assert.ok(last.equity > 100000, 'Equity should grow from net positive P&L');
  });

  it('Step 13: Performance report generates readable text', () => {
    const trades = [
      { symbol: 'SPY', pnl: 500, date: '2025-01-10', strategy: 'momentum' },
      { symbol: 'AAPL', pnl: -100, date: '2025-01-12', strategy: 'momentum' },
    ];
    const report = generatePerformanceReport(trades, 100000);
    assert.ok(typeof report === 'string');
    assert.ok(report.length > 50, 'Report should have substance');
  });

  it('Step 14: Full pipeline sequence completes', async () => {
    // Simulate what the agent does on a real trade
    resetGuard();
    const guard = createGuard({
      accountSize: 100000,
      maxPositionPct: 30,
      maxDailyTrades: 10,
      maxOpenPositions: 10,
      maxCashDeployedPct: 80,
      maxDrawdownPct: 20,
      _stateFile: join(tmpDir, 'pipeline.json'),
    }, 'pipeline-test');

    // 1. Regime check
    const bars = makeBars(250, 450, 0.0008);
    const regime = detectRegime({ spyBars: bars });
    assert.ok(regime.regime);

    // 2. Position sizing
    const sizing = calculateKellySize({
      winRate: 0.55, avgWinPct: 4, avgLossPct: 2.5,
      accountEquity: 100000, maxPositionPct: 30,
      kellyFraction: 0.25, currentExposurePct: 10,
    });
    assert.ok(sizing.recommendedDollars > 0);

    // 3. Correlation check
    const corrCheck = analyzePortfolioRisk(
      [{ symbol: 'MSFT', market_value: 10000 }],
      { symbol: 'AAPL', amount_pct: sizing.recommendedPct }
    );

    // 4. Risk guard validation
    const qty = Math.floor(sizing.recommendedDollars / 180);
    const guardResult = await guard.validateOrder(
      { symbol: 'AAPL', side: 'buy', qty, type: 'limit', limit_price: 180 },
      { equity: 100000, cash: 80000, buyingPower: 80000, openPositions: 1, dailyPL: 0 }
    );
    if (!guardResult.allowed) {
      // If position too large, resize to fit and retry
      const maxQty = Math.floor((100000 * 0.30) / 180);
      const retryResult = await guard.validateOrder(
        { symbol: 'AAPL', side: 'buy', qty: maxQty, type: 'limit', limit_price: 180 },
        { equity: 100000, cash: 80000, buyingPower: 80000, openPositions: 1, dailyPL: 0 }
      );
      assert.ok(retryResult.allowed, `Pipeline order should pass after resize to ${maxQty} shares: ${JSON.stringify(retryResult.violations)}`);
    }

    // 5. Record trade
    guard.recordTrade({ symbol: 'AAPL', side: 'buy', qty, price: 180, pnl: 0 });
    const status = guard.getStatus();
    assert.ok(status.dailyTradeCount >= 1, 'Should record at least 1 trade');

    // 6. Execution tracking
    const tracker = createExecutionTracker(join(tmpDir, 'pipeline-exec'));
    tracker.recordOrder({
      orderId: 'pipe-001', symbol: 'AAPL', side: 'buy', qty,
      type: 'limit', limitPrice: 180, bid: 179.90, ask: 180.10,
    });
    tracker.recordFill('pipe-001', { price: 179.95, qty });
    const execStats = tracker.getExecutionStats();
    assert.ok(execStats.filledOrders >= 1, 'Should have filled orders');

    console.log(`✅ Full pipeline: regime=${regime.regime}, sized=${qty} shares ($${(qty*180).toFixed(0)}), corr_ok=${corrCheck.allowed}, guard=PASS, fill=$179.95`);
  });

  // Cleanup
  it('Cleanup temp files', () => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});
