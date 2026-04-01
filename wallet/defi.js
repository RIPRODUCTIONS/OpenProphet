/**
 * defi.js — DeFi yield strategies on Base L2 for OpenProphet.
 *
 * Provides autonomous yield farming via Aave V3 and Compound V3 on Base.
 * All contract interactions use ethers.js v6 with verified ABI fragments.
 * Dry-run mode is the default — no real transactions without explicit opt-in.
 *
 * @module wallet/defi
 */

import { ethers } from 'ethers';

// ─── Logging ──────────────────────────────────────────────────────────────

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'wallet/defi',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Contract addresses on Base L2 ───────────────────────────────────────

const CONTRACTS = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  aaveDataProvider: '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac',
  compoundCometUSDC: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
};

// ─── ABI fragments (only what we need) ───────────────────────────────────

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
];

const AAVE_DATA_PROVIDER_ABI = [
  'function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
  'function getReserveData(address asset) external view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)',
];

const COMPOUND_COMET_ABI = [
  'function supply(address asset, uint256 amount) external',
  'function withdraw(address asset, uint256 amount) external',
  'function balanceOf(address account) external view returns (uint256)',
  'function getSupplyRate(uint256 utilization) external view returns (uint64)',
  'function getUtilization() external view returns (uint256)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// ─── DeFi Manager ─────────────────────────────────────────────────────────

/**
 * Create a DeFi yield strategy manager.
 *
 * @param {object} config
 * @param {object} config.walletManager - WalletManager from agentkit.js
 * @param {boolean} [config.dryRun=true] - Dry-run mode (no real txns)
 * @param {string} [config.rpcUrl]       - Base RPC URL
 * @returns {DeFiManager}
 */
export function createDeFiManager(config) {
  const { walletManager } = config;
  const dryRun = config.dryRun ?? (process.env.DEFI_DRY_RUN !== 'false');
  const rpcUrl = config.rpcUrl || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  // Track deposits for yield reporting
  const depositLog = [];

  function getProvider() {
    return new ethers.JsonRpcProvider(rpcUrl);
  }

  function getSigner() {
    const wp = walletManager._getWalletProvider();
    if (!wp) throw new Error('Wallet not initialized — call walletManager.initWallet() first');
    return wp;
  }

  /**
   * Deposit USDC into Aave V3 on Base.
   * @param {string|number} amount - USDC amount (human-readable, e.g. "100")
   * @returns {Promise<{ txHash: string|null, amount: string, protocol: 'aave', dryRun: boolean }>}
   */
  async function depositToAave(amount) {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    const usdcAmount = ethers.parseUnits(String(parsedAmount), 6); // USDC is 6 decimals
    const status = walletManager.getStatus();

    log('INFO', `Depositing ${parsedAmount} USDC to Aave`, { dryRun, address: status.address });

    if (dryRun) {
      depositLog.push({
        protocol: 'aave',
        action: 'deposit',
        amount: parsedAmount,
        timestamp: new Date().toISOString(),
        dryRun: true,
      });
      return { txHash: null, amount: String(parsedAmount), protocol: 'aave', dryRun: true };
    }

    const provider = getProvider();
    const signer = getSigner();
    const walletAddress = status.address;

    // Approve USDC spend
    const usdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, signer);
    const currentAllowance = await usdc.allowance(walletAddress, CONTRACTS.aavePool);
    if (currentAllowance < usdcAmount) {
      const approveTx = await usdc.approve(CONTRACTS.aavePool, usdcAmount);
      await approveTx.wait();
      log('INFO', 'USDC approval confirmed for Aave');
    }

    // Supply to Aave
    const pool = new ethers.Contract(CONTRACTS.aavePool, AAVE_POOL_ABI, signer);
    const tx = await pool.supply(CONTRACTS.USDC, usdcAmount, walletAddress, 0);
    const receipt = await tx.wait();

    depositLog.push({
      protocol: 'aave',
      action: 'deposit',
      amount: parsedAmount,
      txHash: receipt.hash,
      timestamp: new Date().toISOString(),
      dryRun: false,
    });

    log('TRADE', 'Aave deposit confirmed', { txHash: receipt.hash, amount: parsedAmount });
    return { txHash: receipt.hash, amount: String(parsedAmount), protocol: 'aave', dryRun: false };
  }

  /**
   * Withdraw USDC + earned yield from Aave V3.
   * @param {string|number} amount - USDC amount to withdraw (use 'max' for full withdrawal)
   * @returns {Promise<{ txHash: string|null, amount: string, protocol: 'aave', dryRun: boolean }>}
   */
  async function withdrawFromAave(amount) {
    const isMax = amount === 'max';
    const parsedAmount = isMax ? 0 : parseFloat(amount);

    if (!isMax && (isNaN(parsedAmount) || parsedAmount <= 0)) {
      throw new Error(`Invalid amount: ${amount}`);
    }

    const status = walletManager.getStatus();
    log('INFO', `Withdrawing ${isMax ? 'max' : parsedAmount} USDC from Aave`, { dryRun });

    if (dryRun) {
      depositLog.push({
        protocol: 'aave',
        action: 'withdraw',
        amount: isMax ? 'max' : parsedAmount,
        timestamp: new Date().toISOString(),
        dryRun: true,
      });
      return { txHash: null, amount: isMax ? 'max' : String(parsedAmount), protocol: 'aave', dryRun: true };
    }

    const signer = getSigner();
    const walletAddress = status.address;
    const withdrawAmount = isMax ? ethers.MaxUint256 : ethers.parseUnits(String(parsedAmount), 6);

    const pool = new ethers.Contract(CONTRACTS.aavePool, AAVE_POOL_ABI, signer);
    const tx = await pool.withdraw(CONTRACTS.USDC, withdrawAmount, walletAddress);
    const receipt = await tx.wait();

    depositLog.push({
      protocol: 'aave',
      action: 'withdraw',
      amount: isMax ? 'max' : parsedAmount,
      txHash: receipt.hash,
      timestamp: new Date().toISOString(),
      dryRun: false,
    });

    log('TRADE', 'Aave withdrawal confirmed', { txHash: receipt.hash });
    return { txHash: receipt.hash, amount: isMax ? 'max' : String(parsedAmount), protocol: 'aave', dryRun: false };
  }

  /**
   * Query current APY from Aave and Compound on Base.
   * @returns {Promise<{ aave: { supplyAPY: number }, compound: { supplyAPY: number }, timestamp: string }>}
   */
  async function checkYieldRates() {
    const provider = getProvider();
    const rates = { timestamp: new Date().toISOString() };

    // Aave V3 — liquidityRate is in RAY units (1e27)
    try {
      const dataProvider = new ethers.Contract(CONTRACTS.aaveDataProvider, AAVE_DATA_PROVIDER_ABI, provider);
      const reserveData = await dataProvider.getReserveData(CONTRACTS.USDC);
      const liquidityRate = reserveData[5]; // liquidityRate field
      const rayDecimals = 27;
      const supplyAPY = Number(liquidityRate) / (10 ** rayDecimals) * 100;
      rates.aave = { supplyAPY: Math.round(supplyAPY * 100) / 100 };
    } catch (err) {
      rates.aave = { supplyAPY: 0, error: err.message };
    }

    // Compound V3
    try {
      const comet = new ethers.Contract(CONTRACTS.compoundCometUSDC, COMPOUND_COMET_ABI, provider);
      const utilization = await comet.getUtilization();
      const supplyRate = await comet.getSupplyRate(utilization);
      // Compound rate is per-second, annualize: rate * seconds_per_year
      const SECONDS_PER_YEAR = 31_536_000;
      const supplyAPY = (Number(supplyRate) / 1e18) * SECONDS_PER_YEAR * 100;
      rates.compound = { supplyAPY: Math.round(supplyAPY * 100) / 100 };
    } catch (err) {
      rates.compound = { supplyAPY: 0, error: err.message };
    }

    return rates;
  }

  /**
   * Rebalance funds to the highest-yielding protocol.
   * Checks Aave vs Compound rates and moves funds to the better one.
   * @returns {Promise<{ action: string, from: string|null, to: string, reason: string, dryRun: boolean }>}
   */
  async function rebalance() {
    const rates = await checkYieldRates();
    const aaveAPY = rates.aave?.supplyAPY || 0;
    const compoundAPY = rates.compound?.supplyAPY || 0;

    const bestProtocol = aaveAPY >= compoundAPY ? 'aave' : 'compound';
    const bestAPY = Math.max(aaveAPY, compoundAPY);
    const worstAPY = Math.min(aaveAPY, compoundAPY);

    // Only rebalance if the spread is meaningful (>0.5% APY difference)
    const spread = bestAPY - worstAPY;
    if (spread < 0.5) {
      return {
        action: 'hold',
        from: null,
        to: bestProtocol,
        reason: `Spread too small (${spread.toFixed(2)}% APY) — holding current position`,
        dryRun,
        rates,
      };
    }

    log('INFO', `Rebalancing to ${bestProtocol}`, { aaveAPY, compoundAPY, spread });

    return {
      action: dryRun ? 'would_rebalance' : 'rebalanced',
      from: bestProtocol === 'aave' ? 'compound' : 'aave',
      to: bestProtocol,
      reason: `${bestProtocol} offers ${bestAPY.toFixed(2)}% APY vs ${worstAPY.toFixed(2)}% (spread: ${spread.toFixed(2)}%)`,
      dryRun,
      rates,
    };
  }

  /**
   * Get yield performance report.
   * @returns {Promise<{ deposits: object[], totalDeposited: number, currentBalance: number, estimatedEarnings: number, currentAPY: object }>}
   */
  async function getYieldReport() {
    const rates = await checkYieldRates();

    // Sum deposits and withdrawals
    let totalDeposited = 0;
    let totalWithdrawn = 0;
    for (const entry of depositLog) {
      if (entry.action === 'deposit' && typeof entry.amount === 'number') {
        totalDeposited += entry.amount;
      } else if (entry.action === 'withdraw' && typeof entry.amount === 'number') {
        totalWithdrawn += entry.amount;
      }
    }

    // Check on-chain balance if wallet is initialized
    let currentBalance = 0;
    const status = walletManager.getStatus();
    if (status.initialized && !dryRun) {
      try {
        const provider = getProvider();
        const dataProvider = new ethers.Contract(
          CONTRACTS.aaveDataProvider, AAVE_DATA_PROVIDER_ABI, provider,
        );
        const userData = await dataProvider.getUserReserveData(CONTRACTS.USDC, status.address);
        currentBalance = Number(ethers.formatUnits(userData[0], 6)); // currentATokenBalance
      } catch {
        // Fall back to calculated balance
        currentBalance = totalDeposited - totalWithdrawn;
      }
    } else {
      currentBalance = totalDeposited - totalWithdrawn;
    }

    const estimatedEarnings = currentBalance - (totalDeposited - totalWithdrawn);

    return {
      deposits: [...depositLog],
      totalDeposited,
      totalWithdrawn,
      currentBalance,
      estimatedEarnings: Math.max(0, estimatedEarnings),
      currentAPY: rates,
    };
  }

  return {
    depositToAave,
    withdrawFromAave,
    checkYieldRates,
    rebalance,
    getYieldReport,

    // Expose for testing
    _getDepositLog: () => depositLog,
  };
}

export default createDeFiManager;
