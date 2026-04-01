/**
 * wallet/index.js — Barrel export and factory for the wallet subsystem.
 *
 * Usage:
 *   import { createWalletSystem } from './wallet/index.js';
 *   const wallet = createWalletSystem();
 *   await wallet.init();
 *
 * @module wallet
 */

import { createWalletManager } from './agentkit.js';
import { createDeFiManager } from './defi.js';
import { createArbitrageManager } from './arbitrage.js';
import { createTreasuryManager } from './treasury.js';

export { createWalletManager } from './agentkit.js';
export { createDeFiManager } from './defi.js';
export { createArbitrageManager } from './arbitrage.js';
export { createTreasuryManager } from './treasury.js';

/**
 * Create the full wallet subsystem with all modules wired together.
 *
 * @param {object} [config]
 * @param {string} [config.apiKey]
 * @param {string} [config.apiSecret]
 * @param {string} [config.encryptionKey]
 * @param {string} [config.rpcUrl]
 * @param {boolean} [config.dryRun]
 * @param {number} [config.maxTradeSize]
 * @param {number} [config.minSpread]
 * @param {{ yield: number, arb: number, liquid: number }} [config.allocation]
 * @returns {{ walletManager, defiManager, arbitrageManager, treasuryManager, init: Function, getStatus: Function }}
 */
export function createWalletSystem(config = {}) {
  const walletManager = createWalletManager(config);

  const defiManager = createDeFiManager({
    walletManager,
    dryRun: config.dryRun,
    rpcUrl: config.rpcUrl,
  });

  const arbitrageManager = createArbitrageManager({
    walletManager,
    dryRun: config.dryRun,
    maxTradeSize: config.maxTradeSize,
    minSpread: config.minSpread,
    rpcUrl: config.rpcUrl,
  });

  const treasuryManager = createTreasuryManager({
    walletManager,
    defiManager,
    arbitrageManager,
    allocation: config.allocation,
  });

  /**
   * Initialize the wallet system — creates/restores wallet.
   * @returns {Promise<{ address: string, isNew: boolean }>}
   */
  async function init() {
    return walletManager.initWallet();
  }

  /**
   * Get overall system status.
   */
  function getStatus() {
    return {
      wallet: walletManager.getStatus(),
      arbitrage: arbitrageManager.getConfig(),
      allocation: treasuryManager.getAllocation(),
    };
  }

  return {
    walletManager,
    defiManager,
    arbitrageManager,
    treasuryManager,
    init,
    getStatus,
  };
}

export default createWalletSystem;
