// ── arbitrage/retail/analyzer.js ── Deal analysis, scoring, and filtering
// Part of the OpenProphet trading system.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Deal
 * @property {number}  sourcePrice  - Purchase price at source
 * @property {number}  targetPrice  - Expected selling price on target platform
 * @property {string}  [category]   - Product category (electronics, toys, etc.)
 * @property {number}  [weightLbs]  - Item weight in pounds
 * @property {boolean} [isMedia]    - Whether the item is media (books, DVDs, etc.)
 * @property {number}  [salesRank]  - Best Sellers Rank on target platform
 * @property {number}  [reviewCount] - Number of reviews (demand proxy)
 * @property {number}  [competitorCount] - Number of competing sellers
 * @property {number}  [priceStability]  - 0-1 score; 1 = perfectly stable
 */

/**
 * @typedef {Object} FeeBreakdown
 * @property {number} referralFee
 * @property {number} fbaFee
 * @property {number} inboundShipping
 * @property {number} storageFee
 * @property {number} totalFees
 * @property {number} netProfit
 * @property {number} margin
 * @property {number} roi
 */

// ── Fee constants — Amazon FBA fee structure ─────────────────────────────────

const FBA_FEES = {
  referralPct:      0.15,  // 15% referral fee (most categories)
  referralPctMedia: 0.08,  // 8% for media
  closingFee:       1.80,  // Per-item closing for media
  fbaSmall:         3.22,  // FBA fulfillment: small standard
  fbaMedium:        4.75,  // FBA fulfillment: large standard (1-2 lb)
  fbaLarge:         5.79,  // FBA fulfillment: large standard (2-3 lb)
  fbaOversize:      9.73,  // FBA fulfillment: small oversize
  storagePerCuFt:   0.87,  // Monthly storage per cubic foot
  inboundPerLb:     0.31,  // Inbound shipping per pound (partnered)
};

const CATEGORY_REFERRAL_RATES = {
  electronics: 0.08,
  toys:        0.15,
  home:        0.15,
  health:      0.15,
  sports:      0.15,
  beauty:      0.08,
  grocery:     0.08,
  media:       0.15,
  clothing:    0.17,
  jewelry:     0.20,
  default:     0.15,
};

// ── Scoring weights ──────────────────────────────────────────────────────────

const SCORE_WEIGHTS = {
  margin: 0.30,
  roi:    0.25,
  rank:   0.20,
  volume: 0.15,
  risk:   0.10,
};

/**
 * Structured logger — writes JSON to stderr so it never interferes with
 * MCP's stdout transport.
 * @param {'INFO'|'WARN'|'ERROR'|'TRADE'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'arbitrage/retail/analyzer',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a retail-arbitrage deal analyzer instance.
 * @param {Object} [config]
 * @param {number} [config.minMargin]  - explicit → env → 0.30
 * @param {number} [config.minROI]     - explicit → env → 0.30
 * @param {number} [config.maxRank]    - explicit → env → 100000
 * @param {number} [config.maxWeight]  - explicit → env → 20
 * @returns {Object} Analyzer public API
 */
export function createDealAnalyzer(config = {}) {
  const minMargin  = config.minMargin  ?? parseFloat(process.env.RETAIL_MIN_MARGIN || '0.30');
  const minROI     = config.minROI     ?? parseFloat(process.env.RETAIL_MIN_ROI || '0.30');
  const maxRank    = config.maxRank    ?? parseInt(process.env.RETAIL_MAX_RANK || '100000', 10);
  const maxWeight  = config.maxWeight  ?? parseFloat(process.env.RETAIL_MAX_WEIGHT_LBS || '20');

  // ── Internal state ──────────────────────────────────────────────────────

  /** @type {Object[]} */
  const analysisHistory = [];

  /** @type {Map<string, number>} asin/id → last score */
  const dealScores = new Map();

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * Pick the referral rate for a category.
   * @param {string} [category]
   * @param {boolean} [isMedia]
   * @returns {number}
   */
  function _getReferralRate(category, isMedia) {
    if (isMedia) return FBA_FEES.referralPctMedia;
    const key = (category || 'default').toLowerCase();
    return CATEGORY_REFERRAL_RATES[key] ?? CATEGORY_REFERRAL_RATES.default;
  }

  /**
   * Pick the FBA fulfillment fee by weight tier.
   * @param {number} weightLbs
   * @returns {number}
   */
  function _getFbaFee(weightLbs) {
    if (weightLbs <= 0.75)  return FBA_FEES.fbaSmall;
    if (weightLbs <= 2)     return FBA_FEES.fbaMedium;
    if (weightLbs <= 3)     return FBA_FEES.fbaLarge;
    return FBA_FEES.fbaOversize;
  }

  /**
   * Assign a letter grade from a numeric score.
   * @param {number} score 0-100
   * @returns {'A'|'B'|'C'|'D'|'F'}
   */
  function _gradeFromScore(score) {
    if (score >= 80) return 'A';
    if (score >= 65) return 'B';
    if (score >= 50) return 'C';
    if (score >= 35) return 'D';
    return 'F';
  }

  // ── Public methods ──────────────────────────────────────────────────────

  /**
   * Calculate all Amazon FBA fees for a deal.
   * @param {Deal} deal
   * @returns {FeeBreakdown}
   */
  function calculateFees(deal) {
    const { sourcePrice, targetPrice, category, weightLbs = 1, isMedia = false } = deal;

    const referralRate = _getReferralRate(category, isMedia);
    const referralFee  = targetPrice * referralRate;
    const fbaFee       = _getFbaFee(weightLbs);
    const inboundShipping = weightLbs * FBA_FEES.inboundPerLb;

    // Estimate ~0.1 cu ft per lb as rough volume proxy for storage
    const estimatedCuFt = Math.max(0.1, weightLbs * 0.1);
    const storageFee    = estimatedCuFt * FBA_FEES.storagePerCuFt;

    let totalFees = referralFee + fbaFee + inboundShipping + storageFee;
    if (isMedia) totalFees += FBA_FEES.closingFee;

    const netProfit = targetPrice - sourcePrice - totalFees;
    const margin    = targetPrice > 0 ? netProfit / targetPrice : 0;
    const roi       = sourcePrice > 0 ? netProfit / sourcePrice : 0;

    return {
      referralFee:     round2(referralFee),
      fbaFee:          round2(fbaFee),
      inboundShipping: round2(inboundShipping),
      storageFee:      round2(storageFee),
      totalFees:       round2(totalFees),
      netProfit:       round2(netProfit),
      margin:          round4(margin),
      roi:             round4(roi),
    };
  }

  /**
   * Score a deal 0-100 based on weighted criteria.
   * @param {Deal} deal
   * @returns {{ score: number, breakdown: Object, grade: string }}
   */
  function scoreDeal(deal) {
    const fees = calculateFees(deal);

    // ── Margin component (0-100) — cap at 60% margin for max score
    const marginScore = Math.min(100, (fees.margin / 0.60) * 100);

    // ── ROI component (0-100) — cap at 200% ROI for max score
    const roiScore = Math.min(100, (fees.roi / 2.0) * 100);

    // ── Rank component (0-100) — log scale, rank 1 = 100, rank 100K = 0
    const rank      = deal.salesRank || maxRank;
    const logMax    = Math.log10(maxRank);    // log10(100000) = 5
    const logRank   = Math.log10(Math.max(1, rank));
    const rankScore = Math.max(0, ((logMax - logRank) / logMax) * 100);

    // ── Volume/demand component (0-100) — reviews as proxy, 1000+ = 100
    const reviews     = deal.reviewCount || 0;
    const volumeScore = Math.min(100, (reviews / 1000) * 100);

    // ── Risk component (0-100) — low competition & stable price = high score
    const competition  = deal.competitorCount ?? 5;
    const stability    = deal.priceStability ?? 0.5;
    const compScore    = Math.max(0, 100 - (competition * 10));  // 0 sellers = 100, 10+ = 0
    const riskScore    = (compScore * 0.5) + (stability * 100 * 0.5);

    // ── Weighted total
    const score = round2(
      marginScore * SCORE_WEIGHTS.margin
      + roiScore  * SCORE_WEIGHTS.roi
      + rankScore * SCORE_WEIGHTS.rank
      + volumeScore * SCORE_WEIGHTS.volume
      + riskScore * SCORE_WEIGHTS.risk
    );

    const breakdown = {
      margin: round2(marginScore),
      roi:    round2(roiScore),
      rank:   round2(rankScore),
      volume: round2(volumeScore),
      risk:   round2(riskScore),
    };

    const grade = _gradeFromScore(score);

    // Cache the score
    const key = deal.asin || deal.id || `${deal.sourcePrice}-${deal.targetPrice}`;
    dealScores.set(key, score);

    return { score, breakdown, grade };
  }

  /**
   * Full analysis pipeline: calculate fees → score → apply filters.
   * @param {Deal} deal
   * @returns {Promise<Object>} Analysis result with pass/fail and reasons
   */
  async function analyzeDeal(deal) {
    const fees    = calculateFees(deal);
    const scoring = scoreDeal(deal);
    const reasons = [];

    // ── Apply filters
    let pass = true;

    if (fees.margin < minMargin) {
      pass = false;
      reasons.push(`margin ${(fees.margin * 100).toFixed(1)}% < min ${(minMargin * 100).toFixed(1)}%`);
    }
    if (fees.roi < minROI) {
      pass = false;
      reasons.push(`ROI ${(fees.roi * 100).toFixed(1)}% < min ${(minROI * 100).toFixed(1)}%`);
    }
    if ((deal.salesRank || 0) > maxRank && deal.salesRank != null) {
      pass = false;
      reasons.push(`rank ${deal.salesRank} > max ${maxRank}`);
    }
    if ((deal.weightLbs || 0) > maxWeight) {
      pass = false;
      reasons.push(`weight ${deal.weightLbs} lbs > max ${maxWeight} lbs`);
    }

    const analysis = {
      deal:      { ...deal },
      fees,
      scoring,
      pass,
      reasons,
      analyzedAt: new Date().toISOString(),
    };

    analysisHistory.push(analysis);
    log('INFO', pass ? 'deal passed filters' : 'deal rejected', {
      pass,
      margin: fees.margin,
      roi: fees.roi,
      score: scoring.score,
      reasons,
    });

    return { ...analysis };
  }

  /**
   * Analyze an array of opportunities from the scanner.
   * @param {Deal[]} opportunities
   * @returns {Promise<{ deals: Object[], passed: Object[], rejected: Object[], summary: Object }>}
   */
  async function analyzeOpportunities(opportunities) {
    if (!Array.isArray(opportunities) || opportunities.length === 0) {
      log('WARN', 'analyzeOpportunities called with empty list');
      return { deals: [], passed: [], rejected: [], summary: _emptySummary() };
    }

    log('INFO', `analyzing ${opportunities.length} opportunities`);

    const deals    = [];
    const passed   = [];
    const rejected = [];

    for (const opp of opportunities) {
      const result = await analyzeDeal(opp);
      deals.push(result);
      if (result.pass) {
        passed.push(result);
      } else {
        rejected.push(result);
      }
    }

    // Sort passed deals by score descending
    passed.sort((a, b) => b.scoring.score - a.scoring.score);

    const margins = passed.map((d) => d.fees.margin);
    const rois    = passed.map((d) => d.fees.roi);
    const avgMargin = margins.length > 0 ? round4(margins.reduce((a, b) => a + b, 0) / margins.length) : 0;
    const avgROI    = rois.length > 0    ? round4(rois.reduce((a, b) => a + b, 0) / rois.length)       : 0;

    const summary = {
      total:    deals.length,
      passed:   passed.length,
      rejected: rejected.length,
      avgMargin,
      avgROI,
      bestDeal: passed.length > 0 ? { ...passed[0] } : null,
    };

    log('INFO', 'analysis complete', {
      total: summary.total,
      passed: summary.passed,
      rejected: summary.rejected,
      avgMargin,
      avgROI,
    });

    return {
      deals:    deals.map((d) => ({ ...d })),
      passed:   passed.map((d) => ({ ...d })),
      rejected: rejected.map((d) => ({ ...d })),
      summary,
    };
  }

  /** Defensive copy of analysis history. @returns {Object[]} */
  function getAnalysisHistory() { return analysisHistory.map((a) => ({ ...a })); }

  /** Current config snapshot. @returns {Object} */
  function getConfig() { return { minMargin, minROI, maxRank, maxWeight }; }

  /**
   * Build an empty summary object.
   * @returns {Object}
   */
  function _emptySummary() {
    return { total: 0, passed: 0, rejected: 0, avgMargin: 0, avgROI: 0, bestDeal: null };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    calculateFees, scoreDeal, analyzeDeal, analyzeOpportunities,
    getAnalysisHistory, getConfig,
    // Test backdoors
    _analysisHistory: analysisHistory, _dealScores: dealScores,
    _getReferralRate, _getFbaFee, _gradeFromScore, _emptySummary,
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

export default createDealAnalyzer;
