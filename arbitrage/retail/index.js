/**
 * arbitrage/retail/index.js — Barrel export and factory for the retail arbitrage subsystem.
 *
 * Usage:
 *   import { createRetailArbitrageSystem } from './arbitrage/retail/index.js';
 *   const retail = createRetailArbitrageSystem({ dryRun: true });
 *   await retail.init();
 *
 * @module arbitrage/retail
 */

import { createRetailScanner } from './scanner.js';
import { createDealAnalyzer } from './analyzer.js';
import { createPurchaser } from './purchaser.js';
import { createLister } from './lister.js';
import { createTracker } from './tracker.js';
import { createScheduler } from './scheduler.js';

export { createRetailScanner } from './scanner.js';
export { createDealAnalyzer } from './analyzer.js';
export { createPurchaser } from './purchaser.js';
export { createLister } from './lister.js';
export { createTracker } from './tracker.js';
export { createScheduler } from './scheduler.js';

/**
 * Create and wire the full retail arbitrage subsystem.
 *
 * @param {object} [config]
 * @param {object} [config.apiKeys] - Retailer API keys
 * @param {boolean} [config.dryRun] - Dry-run mode
 * @param {number} [config.budgetPerCycle] - Budget limit per cycle
 * @param {number} [config.minMargin] - Minimum margin filter
 * @param {number} [config.maxRank] - Maximum sales rank filter
 * @param {string} [config.llmApiKey] - OpenAI API key for listing optimization
 * @param {string} [config.llmModel] - LLM model name
 * @param {number} [config.markupPct] - Markup percentage for listings
 * @param {object} [config.treasuryManager] - Optional treasury manager from wallet subsystem
 * @returns {{ scanner, analyzer, purchaser, lister, tracker, scheduler, init, getStatus }}
 */
export function createRetailArbitrageSystem(config = {}) {
  const {
    apiKeys,
    dryRun = false,
    budgetPerCycle,
    minMargin,
    maxRank,
    llmApiKey,
    llmModel,
    markupPct,
    treasuryManager,
  } = config;

  const scanner = createRetailScanner({ apiKeys });
  const analyzer = createDealAnalyzer({ minMargin, maxRank });
  const purchaser = createPurchaser({ budgetPerCycle, dryRun, treasuryManager });
  const lister = createLister({ llmApiKey, llmModel, markupPct, dryRun });
  const tracker = createTracker();
  const scheduler = createScheduler({ scanner, analyzer, purchaser, lister, tracker });

  /**
   * Initialize all retail arbitrage modules.
   * Validates configuration and runs an initial scan if enabled.
   *
   * @returns {Promise<{ ready: boolean, modules: string[], dryRun: boolean }>}
   */
  async function init() {
    console.log('[retail] Initializing retail arbitrage subsystem…');

    await Promise.all([
      scanner.init?.(),
      analyzer.init?.(),
      purchaser.init?.(),
      lister.init?.(),
      tracker.init?.(),
      scheduler.init?.(),
    ]);

    const modules = ['scanner', 'analyzer', 'purchaser', 'lister', 'tracker', 'scheduler'];
    console.log(`[retail] Ready — ${modules.length} modules loaded (dryRun=${dryRun})`);
    return { ready: true, modules, dryRun };
  }

  /**
   * Return the current status of every module.
   *
   * @returns {object}
   */
  function getStatus() {
    return {
      scanner: scanner.getConfig(),
      analyzer: analyzer.getConfig(),
      purchaser: purchaser.getConfig(),
      lister: lister.getConfig(),
      tracker: tracker.getInventorySummary(),
      scheduler: scheduler.getStatus(),
    };
  }

  return { scanner, analyzer, purchaser, lister, tracker, scheduler, init, getStatus };
}

export default createRetailArbitrageSystem;
