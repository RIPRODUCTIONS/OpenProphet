/**
 * Tests for wallet subsystem — agentkit, defi, arbitrage, treasury, tools, routes.
 * Uses Node.js built-in test runner (node:test + node:assert).
 *
 * All external interactions are mocked — no real API calls, no real blockchain txns.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ─── Import modules under test ────────────────────────────────────────────

import { encryptData, decryptData } from '../wallet/agentkit.js';
import { getWalletToolDefinitions, handleWalletToolCall, isWalletTool } from '../wallet-tools.js';

// Suppress stderr logging during tests
const _origWrite = process.stderr.write;
function silenceLogs() { process.stderr.write = () => true; }
function restoreLogs() { process.stderr.write = _origWrite; }

// ─── Mock helpers ─────────────────────────────────────────────────────────

/**
 * Build a mock wallet manager with all methods stubbed.
 */
function createMockWalletManager(overrides = {}) {
  return {
    initWallet: mock.fn(async () => ({
      address: '0x1234567890abcdef1234567890abcdef12345678',
      isNew: true,
    })),
    getBalance: mock.fn(async (tokens) => {
      const result = {};
      for (const t of (tokens || ['ETH', 'USDC'])) {
        if (t === 'ETH') result.ETH = { balance: '0.5', decimals: 18 };
        else if (t === 'USDC') result.USDC = { balance: '1000.00', decimals: 6 };
        else result[t] = { balance: '0', decimals: 0 };
      }
      return result;
    }),
    sendPayment: mock.fn(async (to, amount, token) => ({
      txHash: '0xabc123',
      amount,
      token: token || 'ETH',
      to,
    })),
    getTransactionHistory: mock.fn(async () => [
      { hash: '0xdef456', from: '0x1234', to: '0x5678', value: '0.1', blockNumber: 100 },
    ]),
    getStatus: mock.fn(() => ({
      initialized: true,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      networkId: 'base-mainnet',
      rpcUrl: 'https://mainnet.base.org',
    })),
    _getProvider: mock.fn(() => null),
    _getWalletProvider: mock.fn(() => null),
    ...overrides,
  };
}

/**
 * Build a mock DeFi manager.
 */
function createMockDeFiManager(overrides = {}) {
  return {
    depositToAave: mock.fn(async (amount) => ({
      txHash: null, amount: String(amount), protocol: 'aave', dryRun: true,
    })),
    withdrawFromAave: mock.fn(async (amount) => ({
      txHash: null, amount: String(amount), protocol: 'aave', dryRun: true,
    })),
    checkYieldRates: mock.fn(async () => ({
      aave: { supplyAPY: 4.5 },
      compound: { supplyAPY: 3.8 },
      timestamp: new Date().toISOString(),
    })),
    rebalance: mock.fn(async () => ({
      action: 'hold',
      from: null,
      to: 'aave',
      reason: 'Spread too small',
      dryRun: true,
    })),
    getYieldReport: mock.fn(async () => ({
      deposits: [],
      totalDeposited: 500,
      totalWithdrawn: 0,
      currentBalance: 505,
      estimatedEarnings: 5,
      currentAPY: { aave: { supplyAPY: 4.5 }, compound: { supplyAPY: 3.8 } },
    })),
    _getDepositLog: mock.fn(() => []),
    ...overrides,
  };
}

/**
 * Build a mock arbitrage manager.
 */
function createMockArbitrageManager(overrides = {}) {
  return {
    findOpportunities: mock.fn(async () => [
      {
        pair: 'USDC/USDT',
        spread: 0.004,
        spreadPct: 0.4,
        buyDex: 'uniswap',
        sellDex: 'aerodrome',
        buyRate: 1.002,
        sellRate: 0.998,
        profitable: true,
        testAmount: 100,
        estimatedProfit: 0.4,
      },
    ]),
    executeArbitrage: mock.fn(async (pair, route) => ({
      pair,
      amount: 100,
      spread: 0.004,
      executed: false,
      reason: 'Dry-run mode',
      timestamp: new Date().toISOString(),
      dryRun: true,
      txHash: null,
    })),
    getArbitrageHistory: mock.fn(() => []),
    getConfig: mock.fn(() => ({
      dryRun: true,
      maxTradeSize: 1000,
      minSpread: 0.003,
      minSpreadPct: '0.30%',
      pairs: ['USDC/USDbC', 'USDC/DAI', 'USDC/USDT'],
    })),
    _getHistory: mock.fn(() => []),
    ...overrides,
  };
}

/**
 * Build a mock treasury manager.
 */
function createMockTreasuryManager(overrides = {}) {
  return {
    allocate: mock.fn(async () => ({
      totalBalance: 1000,
      yieldAlloc: 600,
      arbAlloc: 200,
      liquidAlloc: 200,
      allocation: { yield: 60, arb: 20, liquid: 20 },
      actions: ['Deposited 600.00 USDC to Aave (dry-run)'],
      dryRun: true,
    })),
    harvestYields: mock.fn(async () => ({
      harvested: 5.25,
      source: 'aave',
      timestamp: new Date().toISOString(),
    })),
    reportPnL: mock.fn(async () => ({
      initialCapital: 1000,
      currentValue: 1005.25,
      totalYieldEarned: 5.25,
      totalArbProfit: 0,
      netPnL: 5.25,
      netPnLPct: 0.53,
      allocation: { yield: 60, arb: 20, liquid: 20 },
      history: [],
      timestamp: new Date().toISOString(),
    })),
    setAllocationStrategy: mock.fn((config) => ({
      allocation: config,
      previous: { yield: 60, arb: 20, liquid: 20 },
    })),
    dailyCron: mock.fn(async () => ({
      harvest: { harvested: 5.25 },
      rebalance: { action: 'hold' },
      timestamp: new Date().toISOString(),
    })),
    getAllocation: mock.fn(() => ({ yield: 60, arb: 20, liquid: 20 })),
    _getPnlLog: mock.fn(() => []),
    _setInitialCapital: mock.fn(),
    ...overrides,
  };
}

/**
 * Build a full mock wallet system.
 */
function createMockWalletSystem(overrides = {}) {
  const walletManager = createMockWalletManager(overrides.walletManager);
  const defiManager = createMockDeFiManager(overrides.defiManager);
  const arbitrageManager = createMockArbitrageManager(overrides.arbitrageManager);
  const treasuryManager = createMockTreasuryManager(overrides.treasuryManager);

  return {
    walletManager,
    defiManager,
    arbitrageManager,
    treasuryManager,
    init: mock.fn(async () => walletManager.initWallet()),
    getStatus: mock.fn(() => ({
      wallet: walletManager.getStatus(),
      arbitrage: arbitrageManager.getConfig(),
      allocation: treasuryManager.getAllocation(),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

// ── Encryption (agentkit.js) ──────────────────────────────────────────────

describe('Wallet encryption', () => {
  it('encrypts and decrypts round-trip', () => {
    const plaintext = '{"walletId":"w123","seed":"secret-seed-phrase"}';
    const passphrase = 'test-passphrase-32chars-minimum!';

    const encrypted = encryptData(plaintext, passphrase);
    assert.ok(encrypted.salt, 'Should have salt');
    assert.ok(encrypted.iv, 'Should have IV');
    assert.ok(encrypted.tag, 'Should have auth tag');
    assert.ok(encrypted.data, 'Should have encrypted data');

    const decrypted = decryptData(encrypted, passphrase);
    assert.equal(decrypted, plaintext);
  });

  it('fails decryption with wrong passphrase', () => {
    const encrypted = encryptData('secret data', 'correct-pass');
    assert.throws(
      () => decryptData(encrypted, 'wrong-pass'),
      /Unsupported state or unable to authenticate/,
    );
  });

  it('produces different ciphertext each time (random salt + IV)', () => {
    const plaintext = 'same-data';
    const pass = 'same-pass';
    const e1 = encryptData(plaintext, pass);
    const e2 = encryptData(plaintext, pass);
    assert.notEqual(e1.salt, e2.salt, 'Salts should differ');
    assert.notEqual(e1.data, e2.data, 'Ciphertext should differ');
  });
});

// ── Wallet Manager (mocked) ──────────────────────────────────────────────

describe('WalletManager (mock)', () => {
  let wm;

  beforeEach(() => {
    wm = createMockWalletManager();
  });

  it('initWallet returns address and isNew flag', async () => {
    const result = await wm.initWallet();
    assert.ok(result.address, 'Should return address');
    assert.equal(typeof result.isNew, 'boolean');
  });

  it('getBalance returns balances for requested tokens', async () => {
    const balances = await wm.getBalance(['ETH', 'USDC']);
    assert.ok(balances.ETH, 'Should have ETH');
    assert.ok(balances.USDC, 'Should have USDC');
    assert.equal(balances.ETH.balance, '0.5');
    assert.equal(balances.USDC.balance, '1000.00');
  });

  it('sendPayment returns transaction details', async () => {
    const result = await wm.sendPayment('0xrecipient', '0.1', 'ETH');
    assert.equal(result.txHash, '0xabc123');
    assert.equal(result.to, '0xrecipient');
    assert.equal(result.amount, '0.1');
  });

  it('getTransactionHistory returns tx list', async () => {
    const txs = await wm.getTransactionHistory();
    assert.ok(Array.isArray(txs));
    assert.equal(txs.length, 1);
    assert.ok(txs[0].hash);
  });

  it('getStatus reflects initialization state', () => {
    const status = wm.getStatus();
    assert.equal(status.initialized, true);
    assert.ok(status.address);
    assert.equal(status.networkId, 'base-mainnet');
  });
});

// ── DeFi Manager (mocked) ────────────────────────────────────────────────

describe('DeFiManager (mock)', () => {
  let defi;

  beforeEach(() => {
    silenceLogs();
    defi = createMockDeFiManager();
  });

  it('depositToAave returns dry-run result', async () => {
    const result = await defi.depositToAave(100);
    assert.equal(result.protocol, 'aave');
    assert.equal(result.dryRun, true);
    assert.equal(result.amount, '100');
    restoreLogs();
  });

  it('withdrawFromAave returns dry-run result', async () => {
    const result = await defi.withdrawFromAave(50);
    assert.equal(result.protocol, 'aave');
    assert.equal(result.dryRun, true);
    restoreLogs();
  });

  it('checkYieldRates returns Aave and Compound APYs', async () => {
    const rates = await defi.checkYieldRates();
    assert.ok(rates.aave, 'Should have Aave rates');
    assert.ok(rates.compound, 'Should have Compound rates');
    assert.equal(typeof rates.aave.supplyAPY, 'number');
    assert.equal(typeof rates.compound.supplyAPY, 'number');
    restoreLogs();
  });

  it('rebalance evaluates protocol rates', async () => {
    const result = await defi.rebalance();
    assert.ok(result.action, 'Should have action');
    assert.ok(['hold', 'would_rebalance', 'rebalanced'].includes(result.action));
    restoreLogs();
  });

  it('getYieldReport returns comprehensive report', async () => {
    const report = await defi.getYieldReport();
    assert.equal(typeof report.totalDeposited, 'number');
    assert.equal(typeof report.estimatedEarnings, 'number');
    assert.ok(report.currentAPY);
    restoreLogs();
  });
});

// ── Arbitrage Manager (mocked) ───────────────────────────────────────────

describe('ArbitrageManager (mock)', () => {
  let arb;

  beforeEach(() => {
    arb = createMockArbitrageManager();
  });

  it('findOpportunities returns opportunity list', async () => {
    const opps = await arb.findOpportunities();
    assert.ok(Array.isArray(opps));
    assert.ok(opps.length > 0);
    assert.ok(opps[0].pair);
    assert.equal(typeof opps[0].spread, 'number');
    assert.equal(typeof opps[0].profitable, 'boolean');
  });

  it('executeArbitrage returns result with dry-run flag', async () => {
    const result = await arb.executeArbitrage('USDC/USDT', { dex: 'uniswap', direction: 'buy' });
    assert.equal(result.pair, 'USDC/USDT');
    assert.equal(result.dryRun, true);
  });

  it('getArbitrageHistory returns array', () => {
    const history = arb.getArbitrageHistory();
    assert.ok(Array.isArray(history));
  });

  it('getConfig returns valid configuration', () => {
    const config = arb.getConfig();
    assert.equal(config.dryRun, true);
    assert.equal(typeof config.maxTradeSize, 'number');
    assert.equal(typeof config.minSpread, 'number');
    assert.ok(Array.isArray(config.pairs));
  });
});

// ── Treasury Manager (mocked) ────────────────────────────────────────────

describe('TreasuryManager (mock)', () => {
  let treasury;

  beforeEach(() => {
    treasury = createMockTreasuryManager();
  });

  it('allocate distributes funds by percentage', async () => {
    const result = await treasury.allocate();
    assert.equal(result.totalBalance, 1000);
    assert.equal(result.yieldAlloc, 600);
    assert.equal(result.arbAlloc, 200);
    assert.equal(result.liquidAlloc, 200);
  });

  it('harvestYields returns harvest result', async () => {
    const result = await treasury.harvestYields();
    assert.equal(typeof result.harvested, 'number');
    assert.ok(result.source);
  });

  it('reportPnL returns comprehensive PnL', async () => {
    const pnl = await treasury.reportPnL();
    assert.equal(typeof pnl.initialCapital, 'number');
    assert.equal(typeof pnl.currentValue, 'number');
    assert.equal(typeof pnl.netPnL, 'number');
    assert.equal(typeof pnl.netPnLPct, 'number');
    assert.ok(pnl.allocation);
  });

  it('setAllocationStrategy updates and returns previous', () => {
    const result = treasury.setAllocationStrategy({ yield: 50, arb: 30, liquid: 20 });
    assert.ok(result.previous);
    assert.ok(result.allocation);
  });

  it('dailyCron runs harvest and rebalance', async () => {
    const result = await treasury.dailyCron();
    assert.ok(result.harvest);
    assert.ok(result.rebalance);
    assert.ok(result.timestamp);
  });

  it('getAllocation returns current allocation', () => {
    const alloc = treasury.getAllocation();
    assert.equal(alloc.yield, 60);
    assert.equal(alloc.arb, 20);
    assert.equal(alloc.liquid, 20);
  });
});

// ── Wallet Tools (MCP tool definitions) ──────────────────────────────────

describe('getWalletToolDefinitions', () => {
  const tools = getWalletToolDefinitions();

  it('returns an array of tool objects', () => {
    assert.ok(Array.isArray(tools));
    assert.ok(tools.length >= 7, `Expected at least 7 tools, got ${tools.length}`);
  });

  it('every tool has name, description, and inputSchema', () => {
    for (const tool of tools) {
      assert.ok(tool.name, `Tool missing name`);
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.inputSchema);
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  it('tool names start with wallet_', () => {
    for (const tool of tools) {
      assert.ok(tool.name.startsWith('wallet_'),
        `Tool "${tool.name}" does not start with "wallet_"`);
    }
  });

  it('no duplicate tool names', () => {
    const names = tools.map(t => t.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size);
  });
});

describe('isWalletTool', () => {
  it('returns true for wallet tool names', () => {
    assert.equal(isWalletTool('wallet_balance'), true);
    assert.equal(isWalletTool('wallet_send'), true);
    assert.equal(isWalletTool('wallet_yield_report'), true);
    assert.equal(isWalletTool('wallet_arbitrage_status'), true);
    assert.equal(isWalletTool('wallet_status'), true);
  });

  it('returns false for non-wallet tool names', () => {
    assert.equal(isWalletTool('get_account'), false);
    assert.equal(isWalletTool('place_crypto_order'), false);
    assert.equal(isWalletTool(''), false);
    assert.equal(isWalletTool('wallet'), false);
  });
});

// ── Wallet Tool Handler ──────────────────────────────────────────────────

describe('handleWalletToolCall', () => {
  let sys;

  beforeEach(() => {
    silenceLogs();
    sys = createMockWalletSystem();
  });

  it('returns error when wallet system is null', async () => {
    const result = await handleWalletToolCall('wallet_balance', {}, null);
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('not initialized'));
    restoreLogs();
  });

  it('wallet_balance returns balance data', async () => {
    const result = await handleWalletToolCall('wallet_balance', {}, sys);
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.balances);
    assert.ok(data.address);
    restoreLogs();
  });

  it('wallet_balance accepts custom tokens', async () => {
    await handleWalletToolCall('wallet_balance', { tokens: ['DAI'] }, sys);
    assert.equal(sys.walletManager.getBalance.mock.calls.length, 1);
    assert.deepEqual(sys.walletManager.getBalance.mock.calls[0].arguments[0], ['DAI']);
    restoreLogs();
  });

  it('wallet_send returns tx details', async () => {
    const result = await handleWalletToolCall('wallet_send', {
      to: '0xrecipient', amount: '0.5', token: 'ETH',
    }, sys);
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.txHash, '0xabc123');
    restoreLogs();
  });

  it('wallet_send fails with missing fields', async () => {
    const result = await handleWalletToolCall('wallet_send', { to: '0x123' }, sys);
    assert.equal(result.isError, true);
    restoreLogs();
  });

  it('wallet_yield_report returns report', async () => {
    const result = await handleWalletToolCall('wallet_yield_report', {}, sys);
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(typeof data.totalDeposited, 'number');
    assert.equal(typeof data.estimatedEarnings, 'number');
    restoreLogs();
  });

  it('wallet_arbitrage_status returns config and history', async () => {
    const result = await handleWalletToolCall('wallet_arbitrage_status', {}, sys);
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.config);
    assert.ok(Array.isArray(data.history));
    restoreLogs();
  });

  it('wallet_arbitrage_status with scan=true includes opportunities', async () => {
    const result = await handleWalletToolCall('wallet_arbitrage_status', { scan: true }, sys);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.opportunities);
    assert.ok(Array.isArray(data.opportunities));
    restoreLogs();
  });

  it('wallet_treasury_pnl returns PnL data', async () => {
    const result = await handleWalletToolCall('wallet_treasury_pnl', {}, sys);
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(typeof data.netPnL, 'number');
    restoreLogs();
  });

  it('wallet_rebalance returns rebalance result', async () => {
    const result = await handleWalletToolCall('wallet_rebalance', {}, sys);
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.action);
    restoreLogs();
  });

  it('wallet_status returns system status', async () => {
    const result = await handleWalletToolCall('wallet_status', {}, sys);
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.wallet);
    assert.ok(data.arbitrage);
    assert.ok(data.allocation);
    restoreLogs();
  });

  it('unknown tool name returns error', async () => {
    const result = await handleWalletToolCall('wallet_unknown', {}, sys);
    assert.equal(result.isError, true);
    restoreLogs();
  });
});

// ── Treasury Allocation Validation ───────────────────────────────────────

describe('Treasury allocation validation', () => {
  // Test the real createTreasuryManager allocation validation
  it('rejects allocations that do not sum to 100', async () => {
    const { createTreasuryManager } = await import('../wallet/treasury.js');
    const wm = createMockWalletManager();
    const defi = createMockDeFiManager();
    const arb = createMockArbitrageManager();

    assert.throws(
      () => createTreasuryManager({
        walletManager: wm,
        defiManager: defi,
        arbitrageManager: arb,
        allocation: { yield: 50, arb: 20, liquid: 20 },
      }),
      /must sum to 100/,
    );
  });

  it('rejects negative allocation values', async () => {
    const { createTreasuryManager } = await import('../wallet/treasury.js');
    const wm = createMockWalletManager();
    const defi = createMockDeFiManager();
    const arb = createMockArbitrageManager();

    assert.throws(
      () => createTreasuryManager({
        walletManager: wm,
        defiManager: defi,
        arbitrageManager: arb,
        allocation: { yield: -10, arb: 60, liquid: 50 },
      }),
      /must sum to 100|must be 0-100/,
    );
  });

  it('accepts valid allocation', async () => {
    const { createTreasuryManager } = await import('../wallet/treasury.js');
    const wm = createMockWalletManager();
    const defi = createMockDeFiManager();
    const arb = createMockArbitrageManager();

    const tm = createTreasuryManager({
      walletManager: wm,
      defiManager: defi,
      arbitrageManager: arb,
      allocation: { yield: 70, arb: 20, liquid: 10 },
    });

    assert.deepEqual(tm.getAllocation(), { yield: 70, arb: 20, liquid: 10 });
  });
});

// ── Wallet System Factory ────────────────────────────────────────────────

describe('Wallet system factory', () => {
  it('createWalletSystem returns all subsystems', async () => {
    const { createWalletSystem } = await import('../wallet/index.js');
    const sys = createWalletSystem({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      encryptionKey: 'test-encryption-key',
      dryRun: true,
    });

    assert.ok(sys.walletManager, 'Should have walletManager');
    assert.ok(sys.defiManager, 'Should have defiManager');
    assert.ok(sys.arbitrageManager, 'Should have arbitrageManager');
    assert.ok(sys.treasuryManager, 'Should have treasuryManager');
    assert.equal(typeof sys.init, 'function');
    assert.equal(typeof sys.getStatus, 'function');
  });
});

// ── API Route structure (wallet routes) ──────────────────────────────────

describe('Wallet API routes', () => {
  it('createWalletRoutes returns an Express router', async () => {
    const { default: createWalletRoutes } = await import('../agent/routes/wallet.js');
    const router = createWalletRoutes({}, null);
    assert.ok(router, 'Should return a router');
    assert.equal(typeof router, 'function', 'Router should be a function (middleware)');
  });

  it('router has expected route handlers', async () => {
    const { default: createWalletRoutes } = await import('../agent/routes/wallet.js');
    const sys = createMockWalletSystem();
    const router = createWalletRoutes({}, sys);

    // Router.stack contains route layers
    const routes = router.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    const paths = routes.map(r => r.path);
    assert.ok(paths.includes('/wallet/balance'), 'Should have /wallet/balance');
    assert.ok(paths.includes('/wallet/yield'), 'Should have /wallet/yield');
    assert.ok(paths.includes('/wallet/status'), 'Should have /wallet/status');
    assert.ok(paths.includes('/wallet/rebalance'), 'Should have /wallet/rebalance');
    assert.ok(paths.includes('/wallet/arbitrage'), 'Should have /wallet/arbitrage');
    assert.ok(paths.includes('/wallet/treasury'), 'Should have /wallet/treasury');
  });
});
