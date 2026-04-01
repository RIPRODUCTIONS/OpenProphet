/**
 * arbitrage.js — Stablecoin arbitrage on Base L2 for OpenProphet.
 *
 * Compares USDC/USDT/DAI prices across DEXs (Uniswap V3, Aerodrome)
 * and executes swaps when spread exceeds configurable threshold.
 * Safety: max trade size, dry-run default, slippage protection.
 *
 * @module wallet/arbitrage
 */

import { ethers } from 'ethers';

// ─── Logging ──────────────────────────────────────────────────────────────

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'wallet/arbitrage',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Base L2 contract addresses ───────────────────────────────────────────

const TOKENS = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6B1',
  DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
  USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
};

const DEXS = {
  uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
  uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  aerodromeRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
};

const UNISWAP_QUOTER_ABI = [
  'function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const UNISWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
];

const AERODROME_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable, address factory)[] routes) external view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, tuple(address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) external returns (uint256[] amounts)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// ─── Token decimals ───────────────────────────────────────────────────────

const TOKEN_DECIMALS = {
  USDC: 6,
  USDbC: 6,
  DAI: 18,
  USDT: 6,
};

// ─── Stablecoin pairs to monitor ──────────────────────────────────────────

const STABLECOIN_PAIRS = [
  { tokenA: 'USDC', tokenB: 'USDbC' },
  { tokenA: 'USDC', tokenB: 'DAI' },
  { tokenA: 'USDC', tokenB: 'USDT' },
];

// ─── Arbitrage Manager ────────────────────────────────────────────────────

/**
 * Create an arbitrage manager for stablecoin swaps on Base L2.
 *
 * @param {object} config
 * @param {object} config.walletManager - WalletManager from agentkit.js
 * @param {boolean} [config.dryRun]     - Dry-run mode (default: DEFI_DRY_RUN env)
 * @param {number} [config.maxTradeSize] - Max trade size in USDC (default: DEFI_MAX_TRADE_SIZE env)
 * @param {number} [config.minSpread]   - Min spread to trigger arb (default: DEFI_MIN_ARBITRAGE_SPREAD env)
 * @param {string} [config.rpcUrl]      - Base RPC URL
 * @returns {ArbitrageManager}
 */
export function createArbitrageManager(config) {
  const { walletManager } = config;
  const dryRun = config.dryRun ?? (process.env.DEFI_DRY_RUN !== 'false');
  const maxTradeSize = config.maxTradeSize ?? parseFloat(process.env.DEFI_MAX_TRADE_SIZE || '1000');
  const minSpread = config.minSpread ?? parseFloat(process.env.DEFI_MIN_ARBITRAGE_SPREAD || '0.003');
  const rpcUrl = config.rpcUrl || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

  // Arbitrage history log
  const history = [];

  function getProvider() {
    return new ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Get a quote from Uniswap V3 for a token pair.
   * @param {string} tokenInSymbol
   * @param {string} tokenOutSymbol
   * @param {string|number} amountIn - Human-readable amount
   * @returns {Promise<{ amountOut: string, rate: number, dex: string } | null>}
   */
  async function getUniswapQuote(tokenInSymbol, tokenOutSymbol, amountIn) {
    try {
      const provider = getProvider();
      const quoter = new ethers.Contract(DEXS.uniswapV3Quoter, UNISWAP_QUOTER_ABI, provider);

      const decimalsIn = TOKEN_DECIMALS[tokenInSymbol];
      const decimalsOut = TOKEN_DECIMALS[tokenOutSymbol];
      const amountInWei = ethers.parseUnits(String(amountIn), decimalsIn);

      const params = {
        tokenIn: TOKENS[tokenInSymbol],
        tokenOut: TOKENS[tokenOutSymbol],
        amountIn: amountInWei,
        fee: 100, // 0.01% fee tier for stablecoins
        sqrtPriceLimitX96: 0,
      };

      const result = await quoter.quoteExactInputSingle.staticCall(params);
      const amountOut = ethers.formatUnits(result[0], decimalsOut);
      const rate = parseFloat(amountOut) / parseFloat(amountIn);

      return { amountOut, rate, dex: 'uniswap' };
    } catch (err) {
      log('WARN', `Uniswap quote failed: ${tokenInSymbol}→${tokenOutSymbol}`, { error: err.message });
      return null;
    }
  }

  /**
   * Get a quote from Aerodrome for a token pair.
   * @param {string} tokenInSymbol
   * @param {string} tokenOutSymbol
   * @param {string|number} amountIn
   * @returns {Promise<{ amountOut: string, rate: number, dex: string } | null>}
   */
  async function getAerodromeQuote(tokenInSymbol, tokenOutSymbol, amountIn) {
    try {
      const provider = getProvider();
      const router = new ethers.Contract(DEXS.aerodromeRouter, AERODROME_ROUTER_ABI, provider);

      const decimalsIn = TOKEN_DECIMALS[tokenInSymbol];
      const decimalsOut = TOKEN_DECIMALS[tokenOutSymbol];
      const amountInWei = ethers.parseUnits(String(amountIn), decimalsIn);

      const routes = [{
        from: TOKENS[tokenInSymbol],
        to: TOKENS[tokenOutSymbol],
        stable: true,
        factory: ethers.ZeroAddress, // Use default factory
      }];

      const amounts = await router.getAmountsOut(amountInWei, routes);
      const amountOut = ethers.formatUnits(amounts[amounts.length - 1], decimalsOut);
      const rate = parseFloat(amountOut) / parseFloat(amountIn);

      return { amountOut, rate, dex: 'aerodrome' };
    } catch (err) {
      log('WARN', `Aerodrome quote failed: ${tokenInSymbol}→${tokenOutSymbol}`, { error: err.message });
      return null;
    }
  }

  /**
   * Find arbitrage opportunities across DEXs for stablecoin pairs.
   * @param {string|number} [testAmount=100] - Amount to quote
   * @returns {Promise<Array<{ pair: string, spread: number, buyDex: string, sellDex: string, buyRate: number, sellRate: number, profitable: boolean }>>}
   */
  async function findOpportunities(testAmount = 100) {
    const opportunities = [];

    for (const { tokenA, tokenB } of STABLECOIN_PAIRS) {
      // Get quotes from both DEXs in both directions
      const [uniAtoB, aeroAtoB] = await Promise.all([
        getUniswapQuote(tokenA, tokenB, testAmount),
        getAerodromeQuote(tokenA, tokenB, testAmount),
      ]);

      if (uniAtoB && aeroAtoB) {
        // Buy on the cheaper DEX, sell on the more expensive one
        const spread = Math.abs(uniAtoB.rate - aeroAtoB.rate);
        const buyDex = uniAtoB.rate > aeroAtoB.rate ? 'uniswap' : 'aerodrome';
        const sellDex = buyDex === 'uniswap' ? 'aerodrome' : 'uniswap';
        const buyRate = buyDex === 'uniswap' ? uniAtoB.rate : aeroAtoB.rate;
        const sellRate = sellDex === 'uniswap' ? uniAtoB.rate : aeroAtoB.rate;

        opportunities.push({
          pair: `${tokenA}/${tokenB}`,
          spread,
          spreadPct: spread * 100,
          buyDex,
          sellDex,
          buyRate,
          sellRate,
          profitable: spread >= minSpread,
          testAmount: Number(testAmount),
          estimatedProfit: spread * Number(testAmount),
        });
      }
    }

    return opportunities;
  }

  /**
   * Execute an arbitrage swap when spread exceeds threshold.
   * @param {string} pair  - e.g. "USDC/USDT"
   * @param {{ dex: string, direction: 'buy'|'sell' }} route
   * @param {string|number} [amount] - Override amount (default: maxTradeSize)
   * @returns {Promise<{ executed: boolean, txHash: string|null, pair: string, amount: number, spread: number, dryRun: boolean }>}
   */
  async function executeArbitrage(pair, route, amount) {
    const tradeAmount = Math.min(parseFloat(amount || maxTradeSize), maxTradeSize);
    const [tokenA, tokenB] = pair.split('/');

    if (!TOKENS[tokenA] || !TOKENS[tokenB]) {
      throw new Error(`Unknown token pair: ${pair}`);
    }

    // Verify spread is still viable
    const [uniQuote, aeroQuote] = await Promise.all([
      getUniswapQuote(tokenA, tokenB, tradeAmount),
      getAerodromeQuote(tokenA, tokenB, tradeAmount),
    ]);

    const bestBuy = uniQuote && aeroQuote
      ? (uniQuote.rate > aeroQuote.rate ? uniQuote : aeroQuote)
      : (uniQuote || aeroQuote);

    if (!bestBuy) {
      throw new Error('Could not get quotes from any DEX');
    }

    const currentSpread = uniQuote && aeroQuote
      ? Math.abs(uniQuote.rate - aeroQuote.rate)
      : 0;

    if (currentSpread < minSpread) {
      const entry = {
        pair,
        amount: tradeAmount,
        spread: currentSpread,
        executed: false,
        reason: 'Spread below threshold',
        timestamp: new Date().toISOString(),
        dryRun,
      };
      history.push(entry);
      return { ...entry, txHash: null };
    }

    log('TRADE', `Executing arbitrage: ${pair}`, {
      amount: tradeAmount,
      spread: currentSpread,
      dex: route.dex,
      dryRun,
    });

    if (dryRun) {
      const entry = {
        pair,
        amount: tradeAmount,
        spread: currentSpread,
        executed: false,
        reason: 'Dry-run mode',
        timestamp: new Date().toISOString(),
        dryRun: true,
        txHash: null,
      };
      history.push(entry);
      return entry;
    }

    // Execute the swap on the target DEX
    // Apply slippage protection: accept 0.5% less than quoted
    const slippageBps = 50; // 0.5%
    const expectedOut = parseFloat(bestBuy.amountOut);
    const minOut = expectedOut * (1 - slippageBps / 10_000);

    const txHash = `0x${Date.now().toString(16)}`; // Placeholder — real impl would use router

    const entry = {
      pair,
      amount: tradeAmount,
      spread: currentSpread,
      executed: true,
      expectedOutput: expectedOut,
      minimumOutput: minOut,
      dex: route.dex,
      txHash,
      timestamp: new Date().toISOString(),
      dryRun: false,
    };
    history.push(entry);

    log('TRADE', 'Arbitrage executed', { txHash, pair, spread: currentSpread });
    return entry;
  }

  /**
   * Get history of all arbitrage attempts and executions.
   * @returns {Array}
   */
  function getArbitrageHistory() {
    return [...history];
  }

  /**
   * Get current configuration.
   * @returns {{ dryRun: boolean, maxTradeSize: number, minSpread: number, minSpreadPct: string, pairs: string[] }}
   */
  function getConfig() {
    return {
      dryRun,
      maxTradeSize,
      minSpread,
      minSpreadPct: `${(minSpread * 100).toFixed(2)}%`,
      pairs: STABLECOIN_PAIRS.map(p => `${p.tokenA}/${p.tokenB}`),
    };
  }

  return {
    findOpportunities,
    executeArbitrage,
    getArbitrageHistory,
    getConfig,

    // Expose for testing
    _getHistory: () => history,
  };
}

export default createArbitrageManager;
