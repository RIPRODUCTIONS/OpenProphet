import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSectorMap,
  classifySector,
  analyzePortfolioRisk,
  getCorrelationToolDefinition,
  handleCorrelationToolCall,
} from '../correlation-guard.js';

// ---------------------------------------------------------------------------
// getSectorMap
// ---------------------------------------------------------------------------
describe('getSectorMap', () => {
  it('returns object with all expected sectors', () => {
    const map = getSectorMap();
    const expected = ['Technology', 'Financials', 'Healthcare', 'Energy', 'Consumer', 'Industrials', 'Crypto', 'ETFs'];
    for (const sector of expected) {
      assert.ok(Array.isArray(map[sector]), `missing sector: ${sector}`);
      assert.ok(map[sector].length > 0, `sector ${sector} is empty`);
    }
  });

  it('returns a defensive copy', () => {
    const a = getSectorMap();
    a.Technology.push('FAKE');
    const b = getSectorMap();
    assert.ok(!b.Technology.includes('FAKE'));
  });
});

// ---------------------------------------------------------------------------
// classifySector
// ---------------------------------------------------------------------------
describe('classifySector', () => {
  it('maps known tickers to correct sectors', () => {
    assert.equal(classifySector('AAPL'), 'Technology');
    assert.equal(classifySector('JPM'), 'Financials');
    assert.equal(classifySector('BTC'), 'Crypto');
    assert.equal(classifySector('SPY'), 'ETFs');
    assert.equal(classifySector('XOM'), 'Energy');
    assert.equal(classifySector('UNH'), 'Healthcare');
  });

  it('returns Unknown for unmapped symbols', () => {
    assert.equal(classifySector('ZZZZ'), 'Unknown');
  });

  it('is case-insensitive', () => {
    assert.equal(classifySector('aapl'), 'Technology');
  });
});

// ---------------------------------------------------------------------------
// analyzePortfolioRisk
// ---------------------------------------------------------------------------
describe('analyzePortfolioRisk', () => {
  it('allows trade on empty portfolio', () => {
    const result = analyzePortfolioRisk([], { symbol: 'AAPL', amountPct: 10 });
    assert.equal(result.allowed, true);
    assert.ok(Array.isArray(result.warnings));
    assert.equal(typeof result.recommendation, 'string');
  });

  it('returns expected metrics shape', () => {
    const result = analyzePortfolioRisk(
      [{ symbol: 'AAPL', marketValue: 5000 }],
      { symbol: 'MSFT', amountPct: 10 },
    );
    const { metrics } = result;
    assert.equal(typeof metrics.sectorConcentration, 'object');
    assert.equal(typeof metrics.topHolding, 'object');
    assert.equal(typeof metrics.correlationScore, 'number');
    assert.equal(typeof metrics.diversificationScore, 'number');
    assert.ok('symbol' in metrics.topHolding);
    assert.ok('pct' in metrics.topHolding);
  });

  it('warns when a sector exceeds 50%', () => {
    const positions = [
      { symbol: 'AAPL', marketValue: 3000 },
      { symbol: 'MSFT', marketValue: 3000 },
      { symbol: 'JPM', marketValue: 4000 },
    ];
    // Tech = 60%, above SECTOR_WARN_PCT (50) but below SECTOR_BLOCK_PCT (70)
    const result = analyzePortfolioRisk(positions, { symbol: 'JPM', amountPct: 5 });
    const techWarning = result.warnings.find((w) => /Technology/.test(w) && /WARNING/.test(w));
    assert.ok(techWarning, 'expected a sector warning for Technology');
  });

  it('blocks when position exceeds 40%', () => {
    const result = analyzePortfolioRisk([], { symbol: 'AAPL', amountPct: 45 });
    assert.equal(result.allowed, false);
    assert.ok(result.warnings.some((w) => /BLOCKED/.test(w)));
  });
});

// ---------------------------------------------------------------------------
// getCorrelationToolDefinition
// ---------------------------------------------------------------------------
describe('getCorrelationToolDefinition', () => {
  it('returns valid MCP tool shape', () => {
    const def = getCorrelationToolDefinition();
    assert.equal(typeof def.name, 'string');
    assert.ok(def.name.length > 0);
    assert.equal(typeof def.description, 'string');
    assert.equal(typeof def.inputSchema, 'object');
    assert.equal(def.inputSchema.type, 'object');
    assert.ok('properties' in def.inputSchema);
    assert.ok('new_symbol' in def.inputSchema.properties);
  });
});

// ---------------------------------------------------------------------------
// handleCorrelationToolCall
// ---------------------------------------------------------------------------
describe('handleCorrelationToolCall', () => {
  it('returns formatted MCP response', () => {
    const res = handleCorrelationToolCall(
      { new_symbol: 'AAPL', new_amount_pct: 10 },
      [{ symbol: 'MSFT', marketValue: 5000 }],
      50000,
    );
    assert.ok(Array.isArray(res.content));
    assert.equal(res.content[0].type, 'text');
    const payload = JSON.parse(res.content[0].text);
    assert.equal(typeof payload.allowed, 'boolean');
    assert.ok('metrics' in payload);
    assert.ok('newSymbolSector' in payload);
  });

  it('returns error when new_symbol is missing', () => {
    const res = handleCorrelationToolCall({}, [], 10000);
    assert.equal(res.isError, true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('edge cases', () => {
  it('handles null positions gracefully', () => {
    const result = analyzePortfolioRisk(null, { symbol: 'AAPL', amountPct: 5 });
    assert.equal(result.allowed, true);
  });

  it('handles empty/missing newOrder', () => {
    const result = analyzePortfolioRisk([{ symbol: 'AAPL', marketValue: 1000 }], null);
    assert.equal(typeof result.allowed, 'boolean');
    assert.ok(Array.isArray(result.warnings));
  });
});
