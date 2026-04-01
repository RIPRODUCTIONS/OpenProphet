/**
 * position-sizing.js — Kelly criterion and risk-based position sizing for OpenProphet.
 *
 * Calculates optimal position size before every trade using:
 *   1. Kelly criterion (edge-based sizing from historical win rate / P&L)
 *   2. Volatility-adjusted sizing (stop-loss-based risk control)
 *   3. Options-specific sizing (premium + delta weighting)
 *
 * The AI agent calls the `calculate_position_size` MCP tool before entering
 * any trade. Both Kelly and volatility methods run; the SMALLER wins.
 *
 * No external dependencies.
 *
 * @module position-sizing
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Quarter-Kelly — much safer than full Kelly, still captures most of the edge */
const DEFAULT_KELLY_FRACTION = 0.25;

/** Don't bother with positions smaller than 1% of account */
const MIN_POSITION_PCT = 1.0;

/** Absolute ceiling regardless of what Kelly says */
const ABSOLUTE_MAX_POSITION_PCT = 50.0;

/** Conservative defaults when agent provides no history */
const CONSERVATIVE_DEFAULTS = {
  winRate: 0.50,
  avgWinPct: 3.0,
  avgLossPct: 3.0,
};

/** Default max risk per trade for volatility-adjusted sizing */
const DEFAULT_RISK_PER_TRADE_PCT = 2.0;

/** Default max risk for options trades */
const DEFAULT_OPTIONS_RISK_PCT = 2.0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Clamp a number between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round to N decimal places.
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Determine confidence level based on Kelly edge strength.
 * @param {number} edge - Raw Kelly percentage (before fraction)
 * @param {number} winRate
 * @returns {'high' | 'medium' | 'low'}
 */
function assessConfidence(edge, winRate) {
  if (edge <= 0) return 'low';
  if (edge >= 15 && winRate >= 0.55) return 'high';
  if (edge >= 5 && winRate >= 0.50) return 'medium';
  return 'low';
}

// ─── Kelly Criterion Calculator ──────────────────────────────────────────────

/**
 * @typedef {Object} KellyParams
 * @property {number} winRate              - Win probability 0.0–1.0
 * @property {number} avgWinPct            - Average winning trade % (e.g. 5.0)
 * @property {number} avgLossPct           - Average losing trade % (e.g. 3.0)
 * @property {number} accountEquity        - Current account value in dollars
 * @property {number} [maxPositionPct=30]  - Hard cap from risk guard
 * @property {number} [kellyFraction=0.25] - Fraction of full Kelly to use
 * @property {number} [currentExposurePct=0] - % of account already deployed
 * @property {number} [price]              - Entry price (for share calculation)
 */

/**
 * @typedef {Object} KellyResult
 * @property {number} fullKellyPct        - Raw Kelly % (can exceed 100%)
 * @property {number} adjustedKellyPct    - After fraction applied
 * @property {number} recommendedPct      - Final % after all constraints
 * @property {number} recommendedDollars  - Dollar amount to deploy
 * @property {number} maxSharesAtPrice    - Whole shares at given price (0 if no price)
 * @property {string} reasoning           - Human-readable explanation
 * @property {'high'|'medium'|'low'} confidence
 * @property {number} edge                - Kelly edge value (positive = has edge)
 */

/**
 * Calculate optimal position size using the Kelly criterion.
 *
 * Kelly % = W − (1−W) / R
 * where W = win rate, R = avg_win / avg_loss
 *
 * Full Kelly is notoriously aggressive — default uses quarter-Kelly.
 * Result is further constrained by maxPositionPct and available cash.
 *
 * @param {KellyParams} params
 * @returns {KellyResult}
 */
export function calculateKellySize(params) {
  const {
    winRate: rawWinRate,
    avgWinPct: rawAvgWin,
    avgLossPct: rawAvgLoss,
    accountEquity,
    maxPositionPct = 30,
    kellyFraction = DEFAULT_KELLY_FRACTION,
    currentExposurePct = 0,
    price,
  } = params;

  // ── Validate & sanitize inputs ──────────────────────────────────────────
  const winRate = clamp(rawWinRate ?? CONSERVATIVE_DEFAULTS.winRate, 0, 1);
  const avgWinPct = Math.max(rawAvgWin ?? CONSERVATIVE_DEFAULTS.avgWinPct, 0.01);
  const avgLossPct = Math.max(rawAvgLoss ?? CONSERVATIVE_DEFAULTS.avgLossPct, 0.01);
  const equity = Math.max(accountEquity ?? 0, 0);
  const cap = clamp(maxPositionPct, 0, ABSOLUTE_MAX_POSITION_PCT);
  const fraction = clamp(kellyFraction, 0.05, 1.0);
  const exposure = clamp(currentExposurePct, 0, 100);

  // ── Core Kelly formula ──────────────────────────────────────────────────
  // R = win/loss ratio (in percentage terms, ratio is the same)
  const R = avgWinPct / avgLossPct;
  const fullKellyPct = round((winRate - (1 - winRate) / R) * 100, 2);
  const edge = fullKellyPct;

  const reasons = [];

  // ── No edge → don't trade ──────────────────────────────────────────────
  if (fullKellyPct <= 0) {
    reasons.push(
      `Kelly = ${fullKellyPct}% — NO EDGE detected.`,
      `Win rate ${(winRate * 100).toFixed(1)}% with ${avgWinPct}/${avgLossPct} W/L ratio doesn't justify a trade.`,
      'Recommendation: skip this trade or wait for better setup.',
    );
    return {
      fullKellyPct,
      adjustedKellyPct: 0,
      recommendedPct: 0,
      recommendedDollars: 0,
      maxSharesAtPrice: 0,
      reasoning: reasons.join(' '),
      confidence: 'low',
      edge,
    };
  }

  // ── Apply Kelly fraction ────────────────────────────────────────────────
  let adjustedKellyPct = round(fullKellyPct * fraction, 2);
  reasons.push(
    `Full Kelly = ${fullKellyPct}% (W=${(winRate * 100).toFixed(1)}%, R=${round(R, 2)}).`,
    `Using ${(fraction * 100).toFixed(0)}% Kelly → ${adjustedKellyPct}%.`,
  );

  // ── Apply constraints ───────────────────────────────────────────────────
  let recommendedPct = adjustedKellyPct;

  // Cap at maxPositionPct
  if (recommendedPct > cap) {
    reasons.push(`Capped from ${recommendedPct}% to ${cap}% (risk guard max position).`);
    recommendedPct = cap;
  }

  // Can't deploy more than remaining cash
  const remainingPct = Math.max(100 - exposure, 0);
  if (recommendedPct > remainingPct) {
    reasons.push(
      `Reduced from ${recommendedPct}% to ${round(remainingPct, 2)}% (${round(exposure, 1)}% already deployed).`,
    );
    recommendedPct = remainingPct;
  }

  // Minimum threshold — don't bother with tiny positions
  if (recommendedPct > 0 && recommendedPct < MIN_POSITION_PCT) {
    reasons.push(
      `${round(recommendedPct, 2)}% is below ${MIN_POSITION_PCT}% minimum — rounding up to minimum.`,
    );
    recommendedPct = MIN_POSITION_PCT;
  }

  recommendedPct = round(recommendedPct, 2);

  // ── Dollar amount & shares ──────────────────────────────────────────────
  const recommendedDollars = round((equity * recommendedPct) / 100, 2);
  const maxSharesAtPrice = price && price > 0
    ? Math.floor(recommendedDollars / price)
    : 0;

  if (maxSharesAtPrice > 0) {
    reasons.push(`At $${price}, that's ${maxSharesAtPrice} shares ($${recommendedDollars}).`);
  } else if (price && price > 0) {
    reasons.push(`At $${price}, $${recommendedDollars} is less than 1 share — position too small.`);
  }

  return {
    fullKellyPct,
    adjustedKellyPct,
    recommendedPct,
    recommendedDollars,
    maxSharesAtPrice,
    reasoning: reasons.join(' '),
    confidence: assessConfidence(edge, winRate),
    edge,
  };
}

// ─── Volatility-Adjusted (Stop-Loss) Sizing ──────────────────────────────────

/**
 * @typedef {Object} VolatilityParams
 * @property {number} accountEquity
 * @property {number} [riskPerTradePct=2] - Max % of account to risk
 * @property {number} entryPrice
 * @property {number} stopLossPrice       - Where the stop loss sits
 * @property {number} [currentATR]        - Average True Range for vol adjustment
 */

/**
 * @typedef {Object} VolatilityResult
 * @property {number} shares            - Whole shares to buy
 * @property {number} riskPerShare      - Dollar risk per share (entry − stop)
 * @property {number} totalRiskDollars  - Total dollar risk if stop hits
 * @property {number} positionDollars   - Total position value
 * @property {number} positionPct       - Position as % of account
 * @property {string} reasoning
 */

/**
 * Calculate position size so that a stop-loss hit loses at most riskPerTradePct
 * of the account.
 *
 * shares = (accountEquity × riskPerTradePct/100) / |entryPrice − stopLossPrice|
 *
 * If ATR is provided, the risk-per-share is widened to at least 1× ATR to avoid
 * getting stopped out by normal volatility.
 *
 * @param {VolatilityParams} params
 * @returns {VolatilityResult}
 */
export function calculateVolatilityAdjustedSize(params) {
  const {
    accountEquity,
    riskPerTradePct = DEFAULT_RISK_PER_TRADE_PCT,
    entryPrice,
    stopLossPrice,
    currentATR,
  } = params;

  const equity = Math.max(accountEquity ?? 0, 0);
  const risk = clamp(riskPerTradePct, 0.1, 10);
  const entry = Math.max(entryPrice ?? 0, 0.01);
  const stop = Math.max(stopLossPrice ?? 0, 0);

  const reasons = [];

  // ── Risk per share ──────────────────────────────────────────────────────
  let riskPerShare = Math.abs(entry - stop);

  if (riskPerShare < 0.01) {
    reasons.push('Entry and stop loss are essentially equal — cannot calculate risk per share.');
    return {
      shares: 0,
      riskPerShare: 0,
      totalRiskDollars: 0,
      positionDollars: 0,
      positionPct: 0,
      reasoning: reasons.join(' '),
    };
  }

  // ATR floor: don't let stop be tighter than 1× ATR
  if (currentATR && currentATR > 0 && riskPerShare < currentATR) {
    reasons.push(
      `Stop distance $${round(riskPerShare, 2)} < 1× ATR ($${round(currentATR, 2)}). ` +
      `Widening to ATR to avoid noise stop-outs.`,
    );
    riskPerShare = currentATR;
  }

  // ── Position size ───────────────────────────────────────────────────────
  const maxRiskDollars = (equity * risk) / 100;
  const rawShares = maxRiskDollars / riskPerShare;
  const shares = Math.floor(rawShares);

  const totalRiskDollars = round(shares * riskPerShare, 2);
  const positionDollars = round(shares * entry, 2);
  const positionPct = equity > 0 ? round((positionDollars / equity) * 100, 2) : 0;

  reasons.push(
    `Risk budget: ${risk}% of $${equity} = $${round(maxRiskDollars, 2)}.`,
    `Risk/share: $${round(riskPerShare, 2)} (entry $${entry} → stop $${stop}).`,
    `Shares: ${shares} (total risk $${totalRiskDollars}, position $${positionDollars} = ${positionPct}% of account).`,
  );

  if (shares === 0) {
    reasons.push('Risk budget too small for even 1 share at this price/stop distance.');
  }

  return {
    shares,
    riskPerShare: round(riskPerShare, 2),
    totalRiskDollars,
    positionDollars,
    positionPct,
    reasoning: reasons.join(' '),
  };
}

// ─── Options Position Sizing ─────────────────────────────────────────────────

/**
 * @typedef {Object} OptionsParams
 * @property {number} accountEquity
 * @property {number} [maxRiskPct=2]      - Max % of account to risk
 * @property {number} contractPrice       - Premium per contract (e.g. 3.50 = $350)
 * @property {number} [maxContracts=10]   - Hard cap on contracts
 * @property {number} [delta=0.50]        - Option delta for risk weighting
 */

/**
 * @typedef {Object} OptionsResult
 * @property {number} contracts         - Number of contracts to buy
 * @property {number} totalPremium      - Total cost (contracts × price × 100)
 * @property {number} totalRiskDollars  - Premium at risk
 * @property {number} positionPct       - Premium as % of account
 * @property {number} deltaAdjustedPct  - Delta-weighted exposure
 * @property {string} reasoning
 */

/**
 * Calculate options position size where total premium stays within risk budget.
 *
 * Premium per contract = contractPrice × 100 (options are per 100 shares).
 * Delta weighting: effective exposure = premium × delta, so higher delta options
 * "count for more" risk.
 *
 * @param {OptionsParams} params
 * @returns {OptionsResult}
 */
export function calculateOptionsSize(params) {
  const {
    accountEquity,
    maxRiskPct = DEFAULT_OPTIONS_RISK_PCT,
    contractPrice,
    maxContracts = 10,
    delta: rawDelta = 0.50,
  } = params;

  const equity = Math.max(accountEquity ?? 0, 0);
  const risk = clamp(maxRiskPct, 0.1, 10);
  const premium = Math.max(contractPrice ?? 0, 0);
  const cap = Math.max(maxContracts, 1);
  const delta = clamp(Math.abs(rawDelta), 0.01, 1.0);

  const reasons = [];

  if (premium <= 0) {
    reasons.push('Contract price must be positive.');
    return {
      contracts: 0,
      totalPremium: 0,
      totalRiskDollars: 0,
      positionPct: 0,
      deltaAdjustedPct: 0,
      reasoning: reasons.join(' '),
    };
  }

  // ── Budget ──────────────────────────────────────────────────────────────
  const maxRiskDollars = (equity * risk) / 100;
  const costPerContract = premium * 100; // options = 100 shares

  // Delta weighting: higher delta → each contract "costs" more from risk standpoint
  // effectiveRiskPerContract = costPerContract × (1 + delta) / 2
  // At delta 0.50, multiplier = 0.75; at delta 1.0, multiplier = 1.0
  const deltaMultiplier = (1 + delta) / 2;
  const effectiveCostPerContract = costPerContract * deltaMultiplier;

  const rawContracts = maxRiskDollars / effectiveCostPerContract;
  const contracts = Math.min(Math.floor(rawContracts), cap);

  const totalPremium = round(contracts * costPerContract, 2);
  const totalRiskDollars = totalPremium; // max loss on long options = premium paid
  const positionPct = equity > 0 ? round((totalPremium / equity) * 100, 2) : 0;
  const deltaAdjustedPct = round(positionPct * delta, 2);

  reasons.push(
    `Risk budget: ${risk}% of $${equity} = $${round(maxRiskDollars, 2)}.`,
    `Cost/contract: $${round(costPerContract, 2)} (premium $${premium} × 100).`,
    `Delta-weighted cost: $${round(effectiveCostPerContract, 2)} (Δ=${round(delta, 2)}).`,
    `Contracts: ${contracts} (premium $${totalPremium} = ${positionPct}% of account, Δ-adjusted ${deltaAdjustedPct}%).`,
  );

  if (contracts >= cap) {
    reasons.push(`Hit hard cap of ${cap} contracts.`);
  }
  if (contracts === 0) {
    reasons.push('Risk budget too small for even 1 contract at this premium.');
  }

  return {
    contracts,
    totalPremium,
    totalRiskDollars,
    positionPct,
    deltaAdjustedPct,
    reasoning: reasons.join(' '),
  };
}

// ─── MCP Tool Definition ─────────────────────────────────────────────────────

/**
 * Returns the MCP tool schema for `calculate_position_size`.
 * Register this in mcp-server.js alongside other tool definitions.
 *
 * @returns {{ name: string, description: string, inputSchema: object }}
 */
export function getPositionSizingToolDefinition() {
  return {
    name: 'calculate_position_size',
    description:
      'Calculate optimal position size using Kelly criterion and risk management. ' +
      'Call before every trade to determine how many shares/contracts to buy. ' +
      'Uses your historical win rate and average P&L.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol' },
        side: {
          type: 'string',
          enum: ['buy', 'sell'],
          description: 'Trade direction',
        },
        price: { type: 'number', description: 'Entry price' },
        stop_loss: { type: 'number', description: 'Stop loss price' },
        win_rate: {
          type: 'number',
          description: 'Historical win rate 0-1 (e.g. 0.55)',
        },
        avg_win_pct: {
          type: 'number',
          description: 'Average winning trade %',
        },
        avg_loss_pct: {
          type: 'number',
          description: 'Average losing trade %',
        },
        is_option: {
          type: 'boolean',
          description: 'True if sizing an options trade',
        },
        delta: {
          type: 'number',
          description: 'Option delta (for options trades)',
        },
        contract_price: {
          type: 'number',
          description: 'Option premium per contract',
        },
      },
      required: ['symbol', 'price'],
    },
  };
}

// ─── MCP Tool Handler ────────────────────────────────────────────────────────

/**
 * Handle an incoming `calculate_position_size` MCP tool call.
 *
 * Runs Kelly sizing and (if stop_loss provided) volatility sizing, then
 * takes the more conservative recommendation. For options trades, uses
 * the options-specific calculator instead of volatility sizing.
 *
 * @param {object} args - Tool call arguments matching inputSchema above
 * @param {number} accountEquity - Current account equity in dollars
 * @param {number} [currentExposurePct=0] - % of account already deployed
 * @param {number} [maxPositionPct=30] - Max position size from risk guard
 * @returns {{ content: Array<{ type: string, text: string }>, isError?: boolean }}
 */
export function handlePositionSizingToolCall(
  args,
  accountEquity,
  currentExposurePct = 0,
  maxPositionPct = 30,
) {
  try {
    const {
      symbol,
      side = 'buy',
      price,
      stop_loss: stopLoss,
      win_rate: winRate,
      avg_win_pct: avgWinPct,
      avg_loss_pct: avgLossPct,
      is_option: isOption,
      delta,
      contract_price: contractPrice,
    } = args;

    if (!symbol || !price || price <= 0) {
      return {
        content: [{ type: 'text', text: 'Error: symbol and a positive price are required.' }],
        isError: true,
      };
    }

    const results = {
      symbol,
      side,
      price,
      accountEquity,
      methods: [],
    };

    // ── Kelly sizing (always runs) ────────────────────────────────────────
    const kellyResult = calculateKellySize({
      winRate: winRate ?? CONSERVATIVE_DEFAULTS.winRate,
      avgWinPct: avgWinPct ?? CONSERVATIVE_DEFAULTS.avgWinPct,
      avgLossPct: avgLossPct ?? CONSERVATIVE_DEFAULTS.avgLossPct,
      accountEquity,
      maxPositionPct,
      kellyFraction: DEFAULT_KELLY_FRACTION,
      currentExposurePct,
      price,
    });
    results.kelly = kellyResult;
    results.methods.push('kelly');

    let finalRecommendation = {
      pct: kellyResult.recommendedPct,
      dollars: kellyResult.recommendedDollars,
      shares: kellyResult.maxSharesAtPrice,
      contracts: 0,
      source: 'kelly',
    };

    // ── Options sizing ────────────────────────────────────────────────────
    if (isOption && contractPrice && contractPrice > 0) {
      const optionsResult = calculateOptionsSize({
        accountEquity,
        maxRiskPct: DEFAULT_OPTIONS_RISK_PCT,
        contractPrice,
        maxContracts: 10,
        delta: delta ?? 0.50,
      });
      results.options = optionsResult;
      results.methods.push('options');

      // For options, contracts are the primary output
      finalRecommendation = {
        pct: optionsResult.positionPct,
        dollars: optionsResult.totalPremium,
        shares: 0,
        contracts: optionsResult.contracts,
        source: 'options',
      };
    }

    // ── Volatility sizing (when stop loss provided, non-options) ──────────
    if (stopLoss && stopLoss > 0 && !isOption) {
      const volResult = calculateVolatilityAdjustedSize({
        accountEquity,
        riskPerTradePct: DEFAULT_RISK_PER_TRADE_PCT,
        entryPrice: price,
        stopLossPrice: stopLoss,
      });
      results.volatility = volResult;
      results.methods.push('volatility');

      // Take the SMALLER of Kelly and volatility recommendations
      if (volResult.shares < kellyResult.maxSharesAtPrice || kellyResult.maxSharesAtPrice === 0) {
        finalRecommendation = {
          pct: volResult.positionPct,
          dollars: volResult.positionDollars,
          shares: volResult.shares,
          contracts: 0,
          source: 'volatility (more conservative)',
        };
      } else {
        finalRecommendation.source = 'kelly (more conservative)';
      }
    }

    results.recommendation = finalRecommendation;

    // ── Build human-readable summary ──────────────────────────────────────
    const lines = [
      `📊 Position Sizing for ${symbol} @ $${price} (${side.toUpperCase()})`,
      `Account: $${accountEquity} | Deployed: ${currentExposurePct}%`,
      '',
    ];

    // Kelly summary
    lines.push(`🎰 Kelly Criterion:`);
    lines.push(`   ${kellyResult.reasoning}`);
    lines.push(`   Confidence: ${kellyResult.confidence.toUpperCase()} | Edge: ${kellyResult.edge}%`);
    lines.push('');

    // Volatility summary (if computed)
    if (results.volatility) {
      lines.push(`📉 Stop-Loss Sizing (stop @ $${stopLoss}):`);
      lines.push(`   ${results.volatility.reasoning}`);
      lines.push('');
    }

    // Options summary (if computed)
    if (results.options) {
      lines.push(`📋 Options Sizing (premium $${contractPrice}, Δ=${delta ?? 0.50}):`);
      lines.push(`   ${results.options.reasoning}`);
      lines.push('');
    }

    // Final recommendation
    lines.push('─'.repeat(50));
    if (isOption) {
      lines.push(
        `✅ RECOMMENDATION: ${finalRecommendation.contracts} contracts ` +
        `($${finalRecommendation.dollars} = ${finalRecommendation.pct}% of account)`,
      );
    } else if (finalRecommendation.shares > 0) {
      lines.push(
        `✅ RECOMMENDATION: ${finalRecommendation.shares} shares ` +
        `($${finalRecommendation.dollars} = ${finalRecommendation.pct}% of account)`,
      );
    } else if (kellyResult.edge <= 0) {
      lines.push('⛔ RECOMMENDATION: DO NOT TRADE — no statistical edge detected.');
    } else {
      lines.push('⚠️ RECOMMENDATION: Position too small at current price/risk. Consider skipping.');
    }
    lines.push(`   Method: ${finalRecommendation.source}`);

    const text = lines.join('\n');

    return {
      content: [{ type: 'text', text }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Position sizing error: ${err.message}` }],
      isError: true,
    };
  }
}
