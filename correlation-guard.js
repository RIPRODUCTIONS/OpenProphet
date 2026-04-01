/**
 * @fileoverview Portfolio correlation and concentration analyzer for OpenProphet.
 * Evaluates sector exposure, position sizing, and diversification before new trades.
 * Called by the AI trading agent to guard against over-concentration risk.
 *
 * @module correlation-guard
 * @example
 * ```js
 * import { analyzePortfolioRisk, getCorrelationToolDefinition } from './correlation-guard.js';
 *
 * const result = analyzePortfolioRisk(positions, { symbol: 'NVDA', amountPct: 15 });
 * if (!result.allowed) console.warn(result.recommendation);
 * ```
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum single-sector weight before warning. */
const SECTOR_WARN_PCT = 50;

/** Maximum single-sector weight before hard block. */
const SECTOR_BLOCK_PCT = 70;

/** Adding to a sector would push it past this → blocked. */
const SECTOR_ADD_BLOCK_PCT = 60;

/** Maximum single-position weight before warning. */
const POSITION_WARN_PCT = 30;

/** Maximum single-position weight before hard block. */
const POSITION_BLOCK_PCT = 40;

/** Crypto allocation warning threshold. */
const CRYPTO_WARN_PCT = 25;

/** Minimum sectors before undiversification warning. */
const MIN_SECTORS = 2;

/** Correlation bump for same-sector pair. */
const CORR_SAME_SECTOR = 20;

/** Correlation bump for related-sector pair. */
const CORR_RELATED_SECTOR = 10;

/** Correlation reduction per unique sector. */
const CORR_SECTOR_BONUS = 5;

/** Correlation ceiling. */
const CORR_MAX = 100;

const MODULE_NAME = 'correlation-guard';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Structured JSON log to stderr (MCP convention).
 *
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: MODULE_NAME,
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// Sector Map (~100 popular tickers)
// ---------------------------------------------------------------------------

/** @type {Record<string, string[]>} */
const SECTOR_TICKERS = {
  Technology: [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'META', 'AMZN', 'AMD', 'INTC',
    'TSM', 'AVGO', 'CRM', 'ORCL', 'ADBE', 'NFLX', 'TSLA', 'QCOM', 'MU',
    'AMAT', 'PANW', 'SNOW', 'NOW', 'SHOP', 'UBER', 'SQ', 'PLTR', 'NET',
    'MRVL', 'KLAC', 'LRCX',
  ],
  Financials: [
    'JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'BRK.B', 'BRK.A', 'AXP', 'V',
    'MA', 'SCHW', 'BLK', 'SPGI', 'ICE', 'COF', 'USB', 'PNC',
  ],
  Healthcare: [
    'UNH', 'JNJ', 'PFE', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT', 'BMY',
    'AMGN', 'GILD', 'ISRG', 'MDT', 'CI', 'ELV', 'VRTX', 'REGN', 'ZTS',
  ],
  Energy: [
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY', 'MPC', 'PSX', 'VLO',
    'PXD', 'HAL', 'DVN', 'FANG', 'HES',
  ],
  Consumer: [
    'WMT', 'COST', 'PG', 'KO', 'PEP', 'MCD', 'SBUX', 'NKE', 'TGT',
    'HD', 'LOW', 'TJX', 'CL', 'EL', 'MNST', 'DG', 'DLTR', 'YUM',
  ],
  Industrials: [
    'CAT', 'BA', 'HON', 'UPS', 'GE', 'RTX', 'LMT', 'DE', 'MMM',
    'FDX', 'NOC', 'GD', 'WM', 'EMR', 'ITW', 'ETN',
  ],
  Crypto: [
    'BTC', 'ETH', 'SOL', 'ADA', 'DOT', 'AVAX', 'LINK', 'MATIC', 'ATOM',
    'UNI', 'DOGE', 'SHIB', 'XRP', 'BNB', 'LTC', 'NEAR', 'APT', 'ARB',
    'OP', 'FTM',
  ],
  ETFs: [
    'SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI',
    'XLP', 'XLY', 'XLU', 'XLB', 'XLRE', 'VTI', 'VOO', 'VXX', 'ARKK',
    'SOXL', 'TQQQ', 'TLT', 'GLD', 'SLV', 'HYG', 'EEM',
  ],
};

/**
 * Pre-computed reverse lookup: symbol → sector.
 * @type {Map<string, string>}
 */
const SYMBOL_TO_SECTOR = new Map();
for (const [sector, tickers] of Object.entries(SECTOR_TICKERS)) {
  for (const ticker of tickers) {
    SYMBOL_TO_SECTOR.set(ticker.toUpperCase(), sector);
  }
}

/**
 * Sectors that share meaningful macro correlation.
 * Pairs are bidirectional — order doesn't matter.
 * @type {[string, string][]}
 */
const RELATED_SECTORS = [
  ['Technology', 'Consumer'],    // AMZN, TSLA straddle both
  ['Technology', 'ETFs'],        // QQQ, XLK are tech-heavy
  ['Financials', 'ETFs'],        // XLF overlap
  ['Energy', 'Industrials'],     // macro-cycle correlation
  ['Consumer', 'Industrials'],   // domestic demand linkage
  ['Crypto', 'Technology'],      // risk-on correlation
];

/**
 * Pre-computed set of related sector pairs for O(1) lookup.
 * @type {Set<string>}
 */
const RELATED_PAIR_SET = new Set();
for (const [a, b] of RELATED_SECTORS) {
  RELATED_PAIR_SET.add(`${a}|${b}`);
  RELATED_PAIR_SET.add(`${b}|${a}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the sector for a symbol.
 *
 * @param {string} symbol
 * @returns {string} Sector name or "Unknown"
 */
function classifySymbol(symbol) {
  return SYMBOL_TO_SECTOR.get(symbol.toUpperCase()) ?? 'Unknown';
}

/**
 * Check whether two sectors are considered related.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function areSectorsRelated(a, b) {
  return RELATED_PAIR_SET.has(`${a}|${b}`);
}

/**
 * Round a number to two decimal places.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Sector Concentration
// ---------------------------------------------------------------------------

/**
 * Compute per-sector allocation percentages.
 *
 * @param {{ symbol: string, marketValue: number }[]} positions
 * @param {number} totalValue
 * @returns {Record<string, number>} Sector → percentage of portfolio
 */
function computeSectorConcentration(positions, totalValue) {
  if (totalValue <= 0) return {};

  /** @type {Record<string, number>} */
  const sectorValue = {};
  for (const pos of positions) {
    const sector = classifySymbol(pos.symbol);
    sectorValue[sector] = (sectorValue[sector] ?? 0) + Math.abs(pos.marketValue);
  }

  /** @type {Record<string, number>} */
  const sectorPct = {};
  for (const [sector, value] of Object.entries(sectorValue)) {
    sectorPct[sector] = round2((value / totalValue) * 100);
  }
  return sectorPct;
}

// ---------------------------------------------------------------------------
// Correlation Score
// ---------------------------------------------------------------------------

/**
 * Calculate a synthetic correlation score (0–100) for the portfolio.
 *
 * Scoring rules:
 * - +20 for every pair of positions in the same sector
 * - +10 for every pair of positions in related sectors
 * - −5  for every unique sector represented
 * - Clamped to [0, 100]
 *
 * @param {{ symbol: string }[]} positions
 * @returns {number}
 */
function computeCorrelationScore(positions) {
  if (positions.length < 2) return 0;

  const sectors = positions.map((p) => classifySymbol(p.symbol));
  const uniqueSectors = new Set(sectors);
  let score = 0;

  // Pairwise comparison
  for (let i = 0; i < sectors.length; i++) {
    for (let j = i + 1; j < sectors.length; j++) {
      if (sectors[i] === sectors[j]) {
        score += CORR_SAME_SECTOR;
      } else if (areSectorsRelated(sectors[i], sectors[j])) {
        score += CORR_RELATED_SECTOR;
      }
    }
  }

  // Bonus for breadth
  score -= uniqueSectors.size * CORR_SECTOR_BONUS;

  return Math.max(0, Math.min(CORR_MAX, score));
}

// ---------------------------------------------------------------------------
// Diversification Score (HHI-based)
// ---------------------------------------------------------------------------

/**
 * Compute diversification score from Herfindahl–Hirschman Index.
 *
 * Formula: `100 / (1 + HHI)` where HHI = Σ (weight_i)²
 * A perfectly even 10-position portfolio scores ~91.
 * A single-position portfolio scores ~50.
 *
 * @param {{ marketValue: number }[]} positions
 * @param {number} totalValue
 * @returns {number} 0–100, higher = better diversified
 */
function computeDiversificationScore(positions, totalValue) {
  if (totalValue <= 0 || positions.length === 0) return 0;

  let hhi = 0;
  for (const pos of positions) {
    const weight = Math.abs(pos.marketValue) / totalValue;
    hhi += weight * weight;
  }

  // HHI ranges from 1/n (perfectly even) to 1.0 (single position).
  // Transform so higher = better.
  return round2(100 / (1 + hhi));
}

// ---------------------------------------------------------------------------
// Beta-Weighted Delta (simplified)
// ---------------------------------------------------------------------------

/**
 * Estimate portfolio beta vs SPY using sector-level beta proxies.
 * No external data required — uses static heuristics.
 *
 * @type {Record<string, number>}
 */
const SECTOR_BETA = {
  Technology:   1.25,
  Financials:   1.10,
  Healthcare:   0.80,
  Energy:       1.15,
  Consumer:     0.85,
  Industrials:  1.05,
  Crypto:       2.00,
  ETFs:         1.00,
  Unknown:      1.00,
};

/**
 * Compute a weighted-average portfolio beta using sector proxies.
 *
 * @param {{ symbol: string, marketValue: number }[]} positions
 * @param {number} totalValue
 * @returns {number}
 */
function computeBetaWeightedDelta(positions, totalValue) {
  if (totalValue <= 0 || positions.length === 0) return 0;

  let weightedBeta = 0;
  for (const pos of positions) {
    const sector = classifySymbol(pos.symbol);
    const weight = Math.abs(pos.marketValue) / totalValue;
    weightedBeta += weight * (SECTOR_BETA[sector] ?? 1.0);
  }
  return round2(weightedBeta);
}

// ---------------------------------------------------------------------------
// Risk Rules Engine
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RiskAssessment
 * @property {boolean} allowed - Whether the new order should proceed.
 * @property {string[]} warnings - Non-blocking concerns.
 * @property {Object} metrics
 * @property {Record<string, number>} metrics.sectorConcentration
 * @property {{ symbol: string, pct: number }} metrics.topHolding
 * @property {number} metrics.correlationScore
 * @property {number} metrics.betaWeightedDelta
 * @property {number} metrics.diversificationScore
 * @property {string} recommendation - Human-readable summary.
 */

/**
 * @typedef {Object} Position
 * @property {string} symbol
 * @property {number} marketValue
 */

/**
 * @typedef {Object} NewOrder
 * @property {string} symbol
 * @property {number} [amountPct] - What percentage of portfolio this trade represents.
 */

/**
 * Find the largest single position.
 *
 * @param {Position[]} positions
 * @param {number} totalValue
 * @returns {{ symbol: string, pct: number }}
 */
function findTopHolding(positions, totalValue) {
  if (positions.length === 0 || totalValue <= 0) {
    return { symbol: 'N/A', pct: 0 };
  }

  let top = positions[0];
  for (const pos of positions) {
    if (Math.abs(pos.marketValue) > Math.abs(top.marketValue)) {
      top = pos;
    }
  }
  return {
    symbol: top.symbol,
    pct: round2((Math.abs(top.marketValue) / totalValue) * 100),
  };
}

/**
 * Evaluate all risk rules and return warnings/blocks.
 *
 * @param {Record<string, number>} sectorConc - Sector → pct
 * @param {{ symbol: string, pct: number }} topHolding
 * @param {NewOrder} newOrder
 * @param {Position[]} positions
 * @param {number} totalValue
 * @returns {{ allowed: boolean, warnings: string[] }}
 */
function evaluateRules(sectorConc, topHolding, newOrder, positions, totalValue) {
  const warnings = [];
  let blocked = false;

  const newSector = classifySymbol(newOrder.symbol);
  const newPct = newOrder.amountPct ?? 0;

  // --- Sector concentration (existing portfolio) ---
  for (const [sector, pct] of Object.entries(sectorConc)) {
    if (pct > SECTOR_BLOCK_PCT) {
      warnings.push(`BLOCKED: ${sector} sector at ${pct}% exceeds ${SECTOR_BLOCK_PCT}% hard limit`);
      blocked = true;
    } else if (pct > SECTOR_WARN_PCT) {
      warnings.push(`WARNING: ${sector} sector at ${pct}% exceeds ${SECTOR_WARN_PCT}% soft limit`);
    }
  }

  // --- Adding to a sector that would breach threshold ---
  if (newPct > 0) {
    const currentSectorPct = sectorConc[newSector] ?? 0;
    const projectedPct = round2(currentSectorPct + newPct);

    if (projectedPct > SECTOR_ADD_BLOCK_PCT) {
      warnings.push(
        `BLOCKED: Adding ${newPct}% in ${newOrder.symbol} (${newSector}) would push sector to ${projectedPct}%, exceeding ${SECTOR_ADD_BLOCK_PCT}% add-limit`
      );
      blocked = true;
    }
  }

  // --- Single-position concentration ---
  // Check if the new order itself would be too large
  if (newPct > POSITION_BLOCK_PCT) {
    warnings.push(
      `BLOCKED: Proposed ${newOrder.symbol} at ${newPct}% exceeds ${POSITION_BLOCK_PCT}% single-position hard limit`
    );
    blocked = true;
  } else if (newPct > POSITION_WARN_PCT) {
    warnings.push(
      `WARNING: Proposed ${newOrder.symbol} at ${newPct}% exceeds ${POSITION_WARN_PCT}% single-position soft limit`
    );
  }

  // Check existing top holding
  if (topHolding.pct > POSITION_BLOCK_PCT) {
    warnings.push(
      `BLOCKED: Top holding ${topHolding.symbol} at ${topHolding.pct}% exceeds ${POSITION_BLOCK_PCT}% hard limit`
    );
    blocked = true;
  } else if (topHolding.pct > POSITION_WARN_PCT) {
    warnings.push(
      `WARNING: Top holding ${topHolding.symbol} at ${topHolding.pct}% exceeds ${POSITION_WARN_PCT}% soft limit`
    );
  }

  // --- Crypto allocation ---
  const cryptoPct = sectorConc['Crypto'] ?? 0;
  const projectedCrypto = newSector === 'Crypto' ? round2(cryptoPct + newPct) : cryptoPct;
  if (projectedCrypto > CRYPTO_WARN_PCT) {
    warnings.push(
      `WARNING: Crypto allocation at ${projectedCrypto}% exceeds ${CRYPTO_WARN_PCT}% advisory limit`
    );
  }

  // --- Minimum sector diversification ---
  const uniqueSectors = new Set(Object.keys(sectorConc));
  if (newPct > 0) uniqueSectors.add(newSector);
  if (uniqueSectors.size < MIN_SECTORS && positions.length > 0) {
    warnings.push(
      `WARNING: Only ${uniqueSectors.size} sector(s) represented — dangerously undiversified`
    );
  }

  return { allowed: !blocked, warnings };
}

/**
 * Build a human-readable recommendation string.
 *
 * @param {boolean} allowed
 * @param {string[]} warnings
 * @param {NewOrder} newOrder
 * @param {Record<string, number>} sectorConc
 * @param {number} diversificationScore
 * @returns {string}
 */
function buildRecommendation(allowed, warnings, newOrder, sectorConc, diversificationScore) {
  const newSector = classifySymbol(newOrder.symbol);
  const parts = [];

  if (!allowed) {
    parts.push(`❌ TRADE BLOCKED: ${newOrder.symbol} (${newSector}).`);
  } else if (warnings.length > 0) {
    parts.push(`⚠️  TRADE ALLOWED WITH WARNINGS: ${newOrder.symbol} (${newSector}).`);
  } else {
    parts.push(`✅ TRADE APPROVED: ${newOrder.symbol} (${newSector}).`);
  }

  // Sector summary
  const topSectors = Object.entries(sectorConc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s, p]) => `${s} ${p}%`)
    .join(', ');
  if (topSectors) {
    parts.push(`Top sectors: ${topSectors}.`);
  }

  parts.push(`Diversification score: ${diversificationScore}/100.`);

  if (diversificationScore < 40) {
    parts.push('Consider spreading risk across more sectors.');
  } else if (diversificationScore >= 70) {
    parts.push('Portfolio is well-diversified.');
  }

  if (warnings.length > 0) {
    parts.push(`Issues (${warnings.length}): ${warnings.join(' | ')}`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the hardcoded sector → tickers mapping.
 *
 * @returns {Record<string, string[]>}
 */
export function getSectorMap() {
  // Return a copy so callers can't mutate the internal map
  const copy = {};
  for (const [sector, tickers] of Object.entries(SECTOR_TICKERS)) {
    copy[sector] = [...tickers];
  }
  return copy;
}

/**
 * Analyze the current portfolio for concentration and correlation risk,
 * accounting for a proposed new order.
 *
 * @param {Position[]} positions - Current open positions with `symbol` and `marketValue`.
 * @param {NewOrder}   newOrder  - The trade under consideration.
 * @returns {RiskAssessment}
 *
 * @example
 * ```js
 * const result = analyzePortfolioRisk(
 *   [
 *     { symbol: 'AAPL', marketValue: 15000 },
 *     { symbol: 'MSFT', marketValue: 12000 },
 *     { symbol: 'JPM',  marketValue: 8000 },
 *   ],
 *   { symbol: 'NVDA', amountPct: 20 }
 * );
 *
 * if (!result.allowed) {
 *   console.error(result.recommendation);
 * }
 * ```
 */
export function analyzePortfolioRisk(positions, newOrder) {
  const safePositions = Array.isArray(positions) ? positions : [];
  const safeOrder = newOrder ?? { symbol: 'UNKNOWN' };

  const totalValue = safePositions.reduce(
    (sum, p) => sum + Math.abs(p.marketValue ?? 0),
    0
  );

  const sectorConcentration = computeSectorConcentration(safePositions, totalValue);
  const topHolding = findTopHolding(safePositions, totalValue);
  const correlationScore = computeCorrelationScore(safePositions);
  const betaWeightedDelta = computeBetaWeightedDelta(safePositions, totalValue);
  const diversificationScore = computeDiversificationScore(safePositions, totalValue);

  const { allowed, warnings } = evaluateRules(
    sectorConcentration,
    topHolding,
    safeOrder,
    safePositions,
    totalValue,
  );

  const recommendation = buildRecommendation(
    allowed,
    warnings,
    safeOrder,
    sectorConcentration,
    diversificationScore,
  );

  log(allowed ? 'INFO' : 'WARN', `Portfolio risk check for ${safeOrder.symbol}`, {
    allowed,
    warningCount: warnings.length,
    correlationScore,
    diversificationScore,
  });

  return {
    allowed,
    warnings,
    metrics: {
      sectorConcentration,
      topHolding,
      correlationScore,
      betaWeightedDelta,
      diversificationScore,
    },
    recommendation,
  };
}

/**
 * Return the MCP tool definition for `analyze_portfolio_correlation`.
 *
 * @returns {{ name: string, description: string, inputSchema: object }}
 */
export function getCorrelationToolDefinition() {
  return {
    name: 'analyze_portfolio_correlation',
    description:
      'Analyze portfolio concentration, sector exposure, and correlation risk before placing a new trade. ' +
      'Call this before buying to check if the position would over-concentrate the portfolio.',
    inputSchema: {
      type: 'object',
      properties: {
        new_symbol: {
          type: 'string',
          description: 'Symbol you are considering buying',
        },
        new_amount_pct: {
          type: 'number',
          description: 'What percentage of portfolio this trade would represent',
        },
      },
      required: ['new_symbol'],
    },
  };
}

/**
 * MCP tool call handler for `analyze_portfolio_correlation`.
 *
 * Converts raw MCP args into the internal format, runs the analysis, and
 * returns a structured MCP response.
 *
 * @param {{ new_symbol: string, new_amount_pct?: number }} args
 * @param {Position[]} positions - Current open positions (injected by caller).
 * @param {number} accountEquity - Total account equity in dollars.
 * @returns {{ content: { type: string, text: string }[], isError?: boolean }}
 */
export function handleCorrelationToolCall(args, positions, accountEquity) {
  try {
    if (!args?.new_symbol) {
      return {
        content: [{ type: 'text', text: 'Error: new_symbol is required' }],
        isError: true,
      };
    }

    const newOrder = {
      symbol: args.new_symbol.toUpperCase(),
      amountPct: args.new_amount_pct ?? 0,
    };

    const result = analyzePortfolioRisk(positions, newOrder);

    const payload = {
      ...result,
      accountEquity: round2(accountEquity),
      newSymbolSector: classifySymbol(newOrder.symbol),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err) {
    log('ERROR', 'Correlation tool call failed', { error: err.message });
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience: classify a single symbol (useful for callers)
// ---------------------------------------------------------------------------

/**
 * Look up the sector for a given ticker symbol.
 *
 * @param {string} symbol
 * @returns {string} Sector name or "Unknown"
 */
export function classifySector(symbol) {
  return classifySymbol(symbol);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default analyzePortfolioRisk;
