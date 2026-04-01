import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  runBacktest,
  normaliseBars,
  formatReport,
  aggregateResults,
  fetchBarsFromAlpaca,
} from './engine.js';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, 'cli.js');
const SAMPLE = resolve(__dirname, 'sample-data', 'AAPL-2025.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStrategy(overrides = {}) {
  return {
    id: 'test-strategy',
    symbols: { primary: ['TEST'] },
    riskGuard: { maxPositionPct: overrides.maxPositionPct ?? 100 },
    rules: {
      stopLoss: overrides.stopLoss ?? 0.10,
      profitTarget: { hardExit: overrides.takeProfitPct ?? 0.20 },
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

function makeResult(symbol, overrides = {}) {
  return {
    symbol,
    strategy: overrides.strategy ?? 'test-strategy',
    startDate: '2025-01-01T05:00:00Z',
    endDate: '2025-06-01T05:00:00Z',
    barsProcessed: 100,
    initialCapital: overrides.initialCapital ?? 10_000,
    finalCapital: overrides.finalCapital ?? 11_000,
    totalReturn: overrides.totalReturn ?? 10.0,
    totalPnL: overrides.totalPnL ?? 1_000,
    sharpeRatio: overrides.sharpeRatio ?? 1.5,
    maxDrawdown: overrides.maxDrawdown ?? 5.0,
    winRate: overrides.winRate ?? 60.0,
    avgWin: overrides.avgWin ?? 200,
    avgLoss: overrides.avgLoss ?? -100,
    totalTrades: overrides.totalTrades ?? 10,
    trades: overrides.trades ?? [],
  };
}

function runCLI(extraArgs) {
  return execFileSync('node', [CLI, ...extraArgs], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

// ─── aggregateResults ────────────────────────────────────────────────────────

describe('aggregateResults', () => {
  it('aggregates a single result correctly', () => {
    const r = makeResult('AAPL');
    const agg = aggregateResults([r]);

    assert.equal(agg.combinedPnL, 1_000);
    assert.equal(agg.combinedReturn, 10.0);
    assert.equal(agg.avgSharpe, 1.5);
    assert.equal(agg.avgWinRate, 60.0);
    assert.equal(agg.totalTrades, 10);
    assert.equal(agg.tickerCount, 1);
  });

  it('aggregates multiple results', () => {
    const r1 = makeResult('AAPL', { totalPnL: 1000, sharpeRatio: 2.0, winRate: 70, totalTrades: 5 });
    const r2 = makeResult('MSFT', { totalPnL: -500, sharpeRatio: 0.5, winRate: 40, totalTrades: 8 });

    const agg = aggregateResults([r1, r2]);

    assert.equal(agg.combinedPnL, 500);
    assert.equal(agg.avgSharpe, 1.25);
    assert.equal(agg.avgWinRate, 55.0);
    assert.equal(agg.totalTrades, 13);
    assert.equal(agg.tickerCount, 2);
    assert.equal(agg.combinedInitialCapital, 20_000);
  });

  it('handles non-array input (single result)', () => {
    const r = makeResult('SPY');
    const agg = aggregateResults(r);

    assert.equal(agg.tickerCount, 1);
    assert.equal(agg.combinedPnL, 1_000);
  });
});

// ─── formatReport ────────────────────────────────────────────────────────────

describe('formatReport', () => {
  it('formats a single result into a readable report', () => {
    const r = makeResult('AAPL');
    const report = formatReport(r);

    assert.ok(report.includes('OpenProphet Backtest Report'), 'missing header');
    assert.ok(report.includes('test-strategy'), 'missing strategy name');
    assert.ok(report.includes('AAPL'), 'missing ticker');
    assert.ok(report.includes('Aggregated Metrics'), 'missing aggregated section');
    assert.ok(report.includes('$1,000.00'), 'missing P&L');
    assert.ok(!report.includes('Trade Log'), 'should not include trade log without verbose');
  });

  it('formats multi-ticker results with per-ticker table', () => {
    const results = [
      makeResult('AAPL', { totalReturn: 10, totalPnL: 1000, sharpeRatio: 1.5, winRate: 60, totalTrades: 5 }),
      makeResult('MSFT', { totalReturn: -5, totalPnL: -500, sharpeRatio: 0.3, winRate: 30, totalTrades: 3 }),
    ];

    const report = formatReport(results);

    assert.ok(report.includes('Per-Ticker Results'), 'missing per-ticker table');
    assert.ok(report.includes('AAPL'), 'missing AAPL in table');
    assert.ok(report.includes('MSFT'), 'missing MSFT in table');
    assert.ok(report.includes('Symbol'), 'missing table header');
  });

  it('includes trade log when verbose is true', () => {
    const trades = [{
      entryDate: '2025-01-05T05:00:00Z',
      exitDate: '2025-01-15T05:00:00Z',
      entryPrice: 100,
      exitPrice: 120,
      shares: 10,
      pnl: 200,
      returnPct: 20,
      reason: 'take-profit',
      holdBars: 10,
    }];
    const r = makeResult('AAPL', { trades });
    const report = formatReport(r, { verbose: true });

    assert.ok(report.includes('Trade Log'), 'missing trade log section');
    assert.ok(report.includes('take-profit'), 'missing trade reason');
    assert.ok(report.includes('10sh'), 'missing share count');
  });

  it('handles empty trades array with verbose', () => {
    const r = makeResult('AAPL', { trades: [] });
    const report = formatReport(r, { verbose: true });

    assert.ok(report.includes('(no trades)'), 'should show no trades message');
  });

  it('returns a string', () => {
    const r = makeResult('SPY');
    assert.equal(typeof formatReport(r), 'string');
  });
});

// ─── fetchBarsFromAlpaca ─────────────────────────────────────────────────────

describe('fetchBarsFromAlpaca', () => {
  it('throws when API credentials are missing', async () => {
    // Temporarily clear env vars
    const origPub = process.env.ALPACA_PUBLIC_KEY;
    const origApi = process.env.ALPACA_API_KEY;
    const origSec = process.env.ALPACA_SECRET_KEY;
    delete process.env.ALPACA_PUBLIC_KEY;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    try {
      await assert.rejects(
        () => fetchBarsFromAlpaca('AAPL', '2025-01-01', '2025-06-01'),
        { message: /Alpaca API credentials not found/ },
      );
    } finally {
      // Restore
      if (origPub !== undefined) process.env.ALPACA_PUBLIC_KEY = origPub;
      if (origApi !== undefined) process.env.ALPACA_API_KEY = origApi;
      if (origSec !== undefined) process.env.ALPACA_SECRET_KEY = origSec;
    }
  });
});

// ─── CLI integration: --report flag ──────────────────────────────────────────

describe('CLI --report flag', () => {
  it('outputs formatted text instead of JSON', () => {
    const out = runCLI([
      '--strategy', 'options-conservative',
      '--data-file', SAMPLE,
      '--report',
    ]);

    assert.ok(out.includes('OpenProphet Backtest Report'), 'missing report header');
    assert.ok(out.includes('options-conservative'), 'missing strategy');
    assert.ok(out.includes('Aggregated Metrics'), 'missing metrics');

    // Should NOT be valid JSON
    assert.throws(() => JSON.parse(out), 'report output should not be JSON');
  });

  it('includes trade log with --verbose', () => {
    const out = runCLI([
      '--strategy', 'options-conservative',
      '--data-file', SAMPLE,
      '--report',
      '--verbose',
    ]);

    assert.ok(out.includes('Trade Log'), 'missing trade log with verbose');
  });
});

// ─── CLI integration: backward compatibility ─────────────────────────────────

describe('CLI backward compatibility', () => {
  it('--data-file mode still produces valid JSON', () => {
    const out = runCLI([
      '--strategy', 'options-conservative',
      '--data-file', SAMPLE,
    ]);

    const parsed = JSON.parse(out);
    assert.equal(parsed.strategy, 'options-conservative');
    assert.equal(typeof parsed.totalReturn, 'number');
    assert.ok(Array.isArray(parsed.trades));
  });

  it('--pretty flag still works', () => {
    const out = runCLI([
      '--strategy', 'options-conservative',
      '--data-file', SAMPLE,
      '--pretty',
    ]);

    // Pretty JSON has newlines and indentation
    assert.ok(out.includes('\n  '), 'expected indented JSON');
    const parsed = JSON.parse(out);
    assert.equal(parsed.strategy, 'options-conservative');
  });

  it('missing --strategy still errors', () => {
    assert.throws(
      () => runCLI(['--data-file', SAMPLE]),
      /--strategy is required/,
    );
  });

  it('missing data source still errors', () => {
    assert.throws(
      () => runCLI(['--strategy', 'options-conservative']),
      /provide either/,
    );
  });
});

// ─── CLI integration: --symbol override ──────────────────────────────────────

describe('CLI --symbol with --data-file', () => {
  it('overrides strategy symbol in output', () => {
    const out = runCLI([
      '--strategy', 'options-conservative',
      '--data-file', SAMPLE,
      '--symbol', 'CUSTOM',
    ]);

    const parsed = JSON.parse(out);
    assert.equal(parsed.symbol, 'CUSTOM');
  });
});
