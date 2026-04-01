/**
 * treasury.js — Agent treasury management for OpenProphet.
 *
 * Splits funds across yield farming, arbitrage reserve, and liquid balance.
 * Integrates with DeFi and arbitrage modules for harvesting and reporting.
 * Cron-compatible: daily harvest + rebalance support.
 *
 * @module wallet/treasury
 */

// ─── Logging ──────────────────────────────────────────────────────────────

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'wallet/treasury',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Default allocation ───────────────────────────────────────────────────

const DEFAULT_ALLOCATION = {
  yield: parseInt(process.env.DEFI_ALLOCATION_YIELD || '60', 10),
  arb: parseInt(process.env.DEFI_ALLOCATION_ARB || '20', 10),
  liquid: parseInt(process.env.DEFI_ALLOCATION_LIQUID || '20', 10),
};

/**
 * Validate that allocation percentages sum to 100.
 * @param {{ yield: number, arb: number, liquid: number }} alloc
 */
function validateAllocation(alloc) {
  const sum = alloc.yield + alloc.arb + alloc.liquid;
  if (sum !== 100) {
    throw new Error(`Allocation must sum to 100%, got ${sum}% (yield: ${alloc.yield}, arb: ${alloc.arb}, liquid: ${alloc.liquid})`);
  }
  for (const [key, val] of Object.entries(alloc)) {
    if (val < 0 || val > 100) {
      throw new Error(`Allocation '${key}' must be 0-100%, got ${val}%`);
    }
  }
}

// ─── Treasury Manager ─────────────────────────────────────────────────────

/**
 * Create a treasury manager for fund allocation and PnL tracking.
 *
 * @param {object} config
 * @param {object} config.walletManager   - WalletManager from agentkit.js
 * @param {object} config.defiManager     - DeFiManager from defi.js
 * @param {object} config.arbitrageManager - ArbitrageManager from arbitrage.js
 * @param {{ yield: number, arb: number, liquid: number }} [config.allocation] - Initial allocation %
 * @returns {TreasuryManager}
 */
export function createTreasuryManager(config) {
  const { walletManager, defiManager, arbitrageManager } = config;

  let allocation = { ...DEFAULT_ALLOCATION };
  if (config.allocation) {
    validateAllocation(config.allocation);
    allocation = { ...config.allocation };
  }

  // PnL tracking
  const pnlLog = [];
  let initialCapital = 0;

  /**
   * Allocate wallet funds according to the current strategy.
   * Reads total USDC balance and distributes across yield/arb/liquid.
   * @returns {Promise<{ totalBalance: number, yieldAlloc: number, arbAlloc: number, liquidAlloc: number, actions: string[], dryRun: boolean }>}
   */
  async function allocate() {
    const balances = await walletManager.getBalance(['USDC']);
    const totalUSDC = parseFloat(balances.USDC?.balance || '0');

    if (totalUSDC <= 0) {
      return {
        totalBalance: 0,
        yieldAlloc: 0,
        arbAlloc: 0,
        liquidAlloc: 0,
        actions: ['No USDC balance to allocate'],
        dryRun: true,
      };
    }

    const yieldAmount = totalUSDC * (allocation.yield / 100);
    const arbAmount = totalUSDC * (allocation.arb / 100);
    const liquidAmount = totalUSDC * (allocation.liquid / 100);

    const actions = [];

    // Deposit yield portion to Aave
    if (yieldAmount > 1) { // Minimum $1 to avoid dust
      try {
        const result = await defiManager.depositToAave(yieldAmount.toFixed(2));
        actions.push(`Deposited ${yieldAmount.toFixed(2)} USDC to Aave (${result.dryRun ? 'dry-run' : 'live'})`);
      } catch (err) {
        actions.push(`Failed to deposit to Aave: ${err.message}`);
      }
    }

    // Reserve arb and liquid portions (keep in wallet)
    actions.push(`Reserved ${arbAmount.toFixed(2)} USDC for arbitrage`);
    actions.push(`Reserved ${liquidAmount.toFixed(2)} USDC as liquid`);

    if (initialCapital === 0) {
      initialCapital = totalUSDC;
    }

    log('INFO', 'Treasury allocation complete', {
      total: totalUSDC,
      yield: yieldAmount,
      arb: arbAmount,
      liquid: liquidAmount,
    });

    return {
      totalBalance: totalUSDC,
      yieldAlloc: yieldAmount,
      arbAlloc: arbAmount,
      liquidAlloc: liquidAmount,
      allocation: { ...allocation },
      actions,
      dryRun: actions.some(a => a.includes('dry-run')),
    };
  }

  /**
   * Harvest all earned yields across protocols.
   * @returns {Promise<{ harvested: number, source: string, timestamp: string }>}
   */
  async function harvestYields() {
    const yieldReport = await defiManager.getYieldReport();
    const harvested = yieldReport.estimatedEarnings;

    const entry = {
      harvested,
      source: 'aave',
      timestamp: new Date().toISOString(),
    };

    if (harvested > 0) {
      pnlLog.push({
        type: 'harvest',
        amount: harvested,
        ...entry,
      });
      log('INFO', `Harvested ${harvested.toFixed(4)} USDC yield`, entry);
    }

    return entry;
  }

  /**
   * Generate PnL report for all wallet operations.
   * @returns {Promise<{ initialCapital: number, currentValue: number, totalYieldEarned: number, totalArbProfit: number, netPnL: number, netPnLPct: number, allocation: object, history: object[] }>}
   */
  async function reportPnL() {
    // Current wallet balance
    const balances = await walletManager.getBalance(['USDC', 'ETH']);
    const usdcBalance = parseFloat(balances.USDC?.balance || '0');

    // Yield earnings
    const yieldReport = await defiManager.getYieldReport();
    const yieldEarnings = yieldReport.estimatedEarnings;

    // Arb profits
    const arbHistory = arbitrageManager.getArbitrageHistory();
    const arbProfit = arbHistory
      .filter(h => h.executed)
      .reduce((sum, h) => sum + (h.estimatedProfit || 0), 0);

    // Total current value = wallet USDC + deposited in protocols + arb profits
    const currentValue = usdcBalance + yieldReport.currentBalance;
    const netPnL = currentValue - initialCapital + yieldEarnings + arbProfit;
    const netPnLPct = initialCapital > 0 ? (netPnL / initialCapital) * 100 : 0;

    return {
      initialCapital,
      currentValue,
      totalYieldEarned: yieldEarnings,
      totalArbProfit: arbProfit,
      netPnL,
      netPnLPct: Math.round(netPnLPct * 100) / 100,
      allocation: { ...allocation },
      history: [...pnlLog],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Update the allocation strategy.
   * @param {{ yield?: number, arb?: number, liquid?: number }} newAllocation
   * @returns {{ allocation: object, previous: object }}
   */
  function setAllocationStrategy(newAllocation) {
    const previous = { ...allocation };
    const updated = {
      yield: newAllocation.yield ?? allocation.yield,
      arb: newAllocation.arb ?? allocation.arb,
      liquid: newAllocation.liquid ?? allocation.liquid,
    };

    validateAllocation(updated);
    allocation = updated;

    log('INFO', 'Allocation strategy updated', { previous, updated });
    return { allocation: { ...allocation }, previous };
  }

  /**
   * Run daily cron: harvest yields and rebalance.
   * Intended for use with setInterval or external cron.
   * @returns {Promise<{ harvest: object, rebalance: object, timestamp: string }>}
   */
  async function dailyCron() {
    log('INFO', 'Running daily treasury cron');

    const harvest = await harvestYields();
    const rebalance = await defiManager.rebalance();

    return {
      harvest,
      rebalance,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get current allocation strategy.
   * @returns {{ yield: number, arb: number, liquid: number }}
   */
  function getAllocation() {
    return { ...allocation };
  }

  return {
    allocate,
    harvestYields,
    reportPnL,
    setAllocationStrategy,
    dailyCron,
    getAllocation,

    // Expose for testing
    _getPnlLog: () => pnlLog,
    _setInitialCapital: (val) => { initialCapital = val; },
  };
}

export default createTreasuryManager;
