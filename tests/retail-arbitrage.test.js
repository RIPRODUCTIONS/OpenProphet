import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createRetailScanner } from '../arbitrage/retail/scanner.js';
import { createDealAnalyzer } from '../arbitrage/retail/analyzer.js';
import { createPurchaser } from '../arbitrage/retail/purchaser.js';
import { createLister } from '../arbitrage/retail/lister.js';
import { createTracker } from '../arbitrage/retail/tracker.js';
import { createScheduler } from '../arbitrage/retail/scheduler.js';
import { createRetailArbitrageSystem } from '../arbitrage/retail/index.js';

// ---------------------------------------------------------------------------
// Suppress stderr logging during tests
// ---------------------------------------------------------------------------
const _origWrite = process.stderr.write;
function silenceLogs() { process.stderr.write = () => true; }
function restoreLogs() { process.stderr.write = _origWrite; }

// ---------------------------------------------------------------------------
// Mock module factories (used by Scheduler & integration tests)
// ---------------------------------------------------------------------------
function createMockScanner(overrides = {}) {
  return {
    findArbitrageOpportunities: mock.fn(async () => []),
    scanDeals: mock.fn(async () => []),
    getConfig: mock.fn(() => ({ scanInterval: 300000, maxResults: 50, minDiscount: 15, categories: [] })),
    getScanHistory: mock.fn(() => []),
    ...overrides,
  };
}

function createMockAnalyzer(overrides = {}) {
  return {
    analyzeOpportunities: mock.fn(async (opps) => ({
      deals: [], passed: [], rejected: [],
      summary: { total: 0, passed: 0, rejected: 0, avgMargin: 0, avgROI: 0, bestDeal: null },
    })),
    analyzeDeal: mock.fn(async (d) => ({ deal: d, fees: {}, scoring: {}, pass: true, reasons: [] })),
    calculateFees: mock.fn((d) => ({ totalFees: 5, netProfit: 10, margin: 0.40, roi: 0.50 })),
    scoreDeal: mock.fn((d) => ({ score: 75, grade: 'B', breakdown: {} })),
    getConfig: mock.fn(() => ({ minMargin: 0.30, minROI: 0.30, maxRank: 100000, maxWeight: 20 })),
    getAnalysisHistory: mock.fn(() => []),
    ...overrides,
  };
}

function createMockPurchaser(overrides = {}) {
  return {
    addToCart: mock.fn((deal) => ({ added: true, reason: 'ok', cartSize: 1, remainingBudget: 450 })),
    executePurchases: mock.fn(async () => ({ orders: [], totalSpent: 0, itemCount: 0, dryRun: true, errors: [] })),
    getCart: mock.fn(() => []),
    clearCart: mock.fn(() => ({ cleared: 0 })),
    resetCycle: mock.fn(() => ({ previousSpend: 0, previousItemCount: 0 })),
    checkBudget: mock.fn(async () => ({ remaining: 500 })),
    getConfig: mock.fn(() => ({ budgetPerCycle: 500, maxItemPrice: 200, dryRun: true })),
    getPurchaseHistory: mock.fn(() => []),
    ...overrides,
  };
}

function createMockLister(overrides = {}) {
  return {
    createListing: mock.fn(async (deal) => ({
      listingId: 'lst-mock-001', asin: deal.asin, status: 'draft', price: deal.price * 1.4,
    })),
    publishListing: mock.fn(async (id) => ({ listingId: id, status: 'active' })),
    optimizeListings: mock.fn(async () => ({ optimized: 0, priceChanges: [], unchanged: 0 })),
    getListings: mock.fn(() => []),
    getConfig: mock.fn(() => ({ defaultPlatform: 'amazon_fba', markupPct: 0.40, dryRun: true })),
    getListingHistory: mock.fn(() => []),
    ...overrides,
  };
}

function createMockTracker(overrides = {}) {
  return {
    addItem: mock.fn((item) => ({ asin: item.asin, status: 'purchased' })),
    updateStatus: mock.fn((asin, status) => ({ asin, status })),
    recordSale: mock.fn((asin, data) => ({ asin, salePrice: data.salePrice })),
    recordReturn: mock.fn((asin) => ({ asin, status: 'returned' })),
    getInventory: mock.fn(() => []),
    getInventorySummary: mock.fn(() => ({ total: 0, sold: 0, returned: 0 })),
    getAggregatePnL: mock.fn(() => ({ netProfit: 0, totalInvested: 0, roi: 0 })),
    getItemPnL: mock.fn(() => ({ netProfit: 0 })),
    getSales: mock.fn(() => []),
    getReturns: mock.fn(() => []),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: minimal deal object reused across tests
// ---------------------------------------------------------------------------
function makeDeal(overrides = {}) {
  return {
    asin: 'B000TEST01',
    name: 'Test Widget',
    sourcePrice: 25.00,
    price: 25.00,
    targetPrice: 55.00,
    sellingPrice: 55.00,
    category: 'toys',
    retailer: 'walmart',
    rank: 5000,
    weight: 1.5,
    reviews: 500,
    sellers: 3,
    priceStability: 0.9,
    discountPct: 30,
    ...overrides,
  };
}

// ===========================================================================
// RetailScanner
// ===========================================================================
describe('RetailScanner', () => {
  let scanner;

  beforeEach(() => {
    silenceLogs();
    scanner = createRetailScanner({
      apiKeys: { amazon: 'ak_test_1', walmart: 'wk_test_2', target: '', bestbuy: '' },
    });
  });

  it('creates scanner with default config', () => {
    const cfg = createRetailScanner().getConfig();
    assert.equal(cfg.scanInterval, 300000, 'default scan interval should be 300000 ms');
    assert.equal(cfg.maxResults, 50, 'default maxResults should be 50');
    assert.equal(cfg.minDiscount, 15, 'default minDiscount should be 15%');
    assert.ok(Array.isArray(cfg.categories), 'categories should be an array');
    assert.ok(cfg.categories.length > 0, 'should have default categories');
    restoreLogs();
  });

  it('creates scanner with custom config', () => {
    const custom = createRetailScanner({
      apiKeys: { amazon: 'custom_key', walmart: '', target: '', bestbuy: '' },
      maxResults: 100,
      minDiscount: 25,
    });
    const cfg = custom.getConfig();
    assert.equal(cfg.maxResults, 100, 'maxResults should reflect custom value');
    assert.equal(cfg.minDiscount, 25, 'minDiscount should reflect custom value');
    restoreLogs();
  });

  it('getScanHistory returns empty initially', () => {
    const history = scanner.getScanHistory();
    assert.ok(Array.isArray(history), 'scan history should be an array');
    assert.equal(history.length, 0, 'scan history should be empty on creation');
    restoreLogs();
  });

  it('getConfig masks API keys', () => {
    const cfg = scanner.getConfig();
    assert.ok(cfg.apiKeys, 'apiKeys should be present in config');
    const amazonKey = cfg.apiKeys.amazon;
    assert.notEqual(amazonKey, 'ak_test_1', 'amazon API key should be masked');
    assert.ok(
      amazonKey.includes('…') || amazonKey.includes('*') || amazonKey === '[set]',
      'masked key should contain ellipsis, asterisks, or a placeholder',
    );
    restoreLogs();
  });
});

// ===========================================================================
// DealAnalyzer
// ===========================================================================
describe('DealAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    silenceLogs();
    analyzer = createDealAnalyzer();
  });

  it('calculates FBA fees correctly', () => {
    const deal = makeDeal({ price: 20, sellingPrice: 50, weight: 1.5, category: 'toys' });
    const fees = analyzer.calculateFees(deal);

    assert.ok(typeof fees.referralFee === 'number', 'referralFee should be a number');
    assert.ok(typeof fees.fbaFee === 'number', 'fbaFee should be a number');
    assert.ok(typeof fees.totalFees === 'number', 'totalFees should be a number');
    assert.ok(typeof fees.netProfit === 'number', 'netProfit should be a number');
    assert.ok(fees.totalFees > 0, 'totalFees should be positive');
    // totalFees should equal sum of components
    const componentSum = fees.referralFee + fees.fbaFee + (fees.inboundShipping || 0) + (fees.storageFee || 0);
    assert.equal(
      fees.totalFees,
      parseFloat(componentSum.toFixed(2)),
      'totalFees should equal sum of fee components',
    );
    restoreLogs();
  });

  it('applies correct referral rates by category', () => {
    const electronicsDeal = makeDeal({ category: 'electronics', sourcePrice: 30, targetPrice: 60, weightLbs: 1.0 });
    const toysDeal = makeDeal({ category: 'toys', sourcePrice: 30, targetPrice: 60, weightLbs: 1.0 });

    const eFees = analyzer.calculateFees(electronicsDeal);
    const tFees = analyzer.calculateFees(toysDeal);

    // Electronics 8% of 60 = 4.80, Toys 15% of 60 = 9.00
    assert.ok(
      eFees.referralFee < tFees.referralFee,
      'electronics referral fee should be lower than toys (8% vs 15%)',
    );
    const expectedElecRef = parseFloat((60 * 0.08).toFixed(2));
    const expectedToysRef = parseFloat((60 * 0.15).toFixed(2));
    assert.equal(eFees.referralFee, expectedElecRef, 'electronics referral should be 8% of selling price');
    assert.equal(tFees.referralFee, expectedToysRef, 'toys referral should be 15% of selling price');
    restoreLogs();
  });

  it('scores deals 0-100 with grade', () => {
    const greatDeal = makeDeal({
      sourcePrice: 10, targetPrice: 60, salesRank: 500, reviewCount: 2000,
      competitorCount: 2, weightLbs: 0.5, priceStability: 0.95,
    });
    const scoring = analyzer.scoreDeal(greatDeal);

    assert.ok(typeof scoring.score === 'number', 'score should be a number');
    assert.ok(scoring.score >= 0 && scoring.score <= 100, 'score should be between 0 and 100');
    assert.ok(scoring.score > 80, 'great deal should score above 80');
    assert.equal(scoring.grade, 'A', 'score above 80 should earn grade A');
    assert.ok(scoring.breakdown, 'scoring should include breakdown');
    restoreLogs();
  });

  it('rejects deals below minimum margin', async () => {
    const strictAnalyzer = createDealAnalyzer({ minMargin: 0.30 });
    // Tiny margin: buy at 45, sell at 50 → ~10% margin before fees
    const lowMarginDeal = makeDeal({ price: 45, sellingPrice: 50, sourcePrice: 45, targetPrice: 50, weight: 1.0 });
    const result = await strictAnalyzer.analyzeDeal(lowMarginDeal);

    assert.equal(result.pass, false, 'deal with margin below minMargin should not pass');
    assert.ok(result.reasons.length > 0, 'rejection should include reasons');
    restoreLogs();
  });

  it('rejects deals with rank above maximum', async () => {
    const strictAnalyzer = createDealAnalyzer({ maxRank: 100000 });
    const highRankDeal = makeDeal({ salesRank: 200000, sourcePrice: 10, targetPrice: 50 });
    const result = await strictAnalyzer.analyzeDeal(highRankDeal);

    assert.equal(result.pass, false, 'deal with rank above maxRank should not pass');
    assert.ok(
      result.reasons.some((r) => /rank/i.test(r)),
      'rejection reasons should mention rank',
    );
    restoreLogs();
  });

  it('analyzeOpportunities returns summary stats', async () => {
    const deals = [
      makeDeal({ asin: 'B001', price: 10, sellingPrice: 50, rank: 1000 }),
      makeDeal({ asin: 'B002', price: 40, sellingPrice: 45, rank: 500000 }),
      makeDeal({ asin: 'B003', price: 15, sellingPrice: 55, rank: 2000 }),
    ];
    const result = await analyzer.analyzeOpportunities(deals);

    assert.ok(result.summary, 'result should have summary');
    assert.equal(result.summary.total, 3, 'total should equal number of input deals');
    assert.ok(typeof result.summary.passed === 'number', 'summary.passed should be a number');
    assert.ok(typeof result.summary.rejected === 'number', 'summary.rejected should be a number');
    assert.equal(
      result.summary.passed + result.summary.rejected,
      result.summary.total,
      'passed + rejected should equal total',
    );
    restoreLogs();
  });
});

// ===========================================================================
// Purchaser
// ===========================================================================
describe('Purchaser', () => {
  let purchaser;

  beforeEach(() => {
    silenceLogs();
    purchaser = createPurchaser({ budgetPerCycle: 500, maxItemPrice: 200, dryRun: true });
  });

  it('adds items to cart within budget', () => {
    const deal = makeDeal({ asin: 'B000CART01', price: 30 });
    const result = purchaser.addToCart(deal);

    assert.equal(result.added, true, 'item should be added to cart');
    assert.equal(result.cartSize, 1, 'cart should have one item');
    assert.ok(result.remainingBudget < 500, 'remaining budget should decrease');
    assert.equal(result.remainingBudget, 470, 'remaining budget should be 500 - 30 = 470');
    restoreLogs();
  });

  it('rejects duplicate ASIN in cart', () => {
    const deal = makeDeal({ asin: 'B000DUP01', price: 25 });
    purchaser.addToCart(deal);
    const second = purchaser.addToCart(deal);

    assert.equal(second.added, false, 'duplicate ASIN should be rejected');
    assert.ok(/duplicate|already/i.test(second.reason), 'reason should mention duplicate');
    restoreLogs();
  });

  it('enforces budget limits', () => {
    const tightPurchaser = createPurchaser({ budgetPerCycle: 100, maxItemPrice: 200, dryRun: true });
    const expensiveDeal = makeDeal({ asin: 'B000EXP01', price: 150 });
    const result = tightPurchaser.addToCart(expensiveDeal);

    assert.equal(result.added, false, 'item exceeding budget should be rejected');
    assert.ok(/budget/i.test(result.reason), 'reason should mention budget');
    restoreLogs();
  });

  it('enforces max item price', () => {
    const deal = makeDeal({ asin: 'B000MAX01', price: 250 });
    const result = purchaser.addToCart(deal);

    assert.equal(result.added, false, 'item above maxItemPrice should be rejected');
    assert.ok(/price|max/i.test(result.reason), 'reason should mention price limit');
    restoreLogs();
  });

  it('executePurchases in dry-run mode', async () => {
    purchaser.addToCart(makeDeal({ asin: 'B000DRY01', price: 20 }));
    purchaser.addToCart(makeDeal({ asin: 'B000DRY02', price: 35 }));
    const result = await purchaser.executePurchases();

    assert.equal(result.dryRun, true, 'dryRun flag should be true');
    assert.ok(Array.isArray(result.orders), 'orders should be an array');
    for (const order of result.orders) {
      assert.equal(order.dryRun, true, 'each order should have dryRun: true');
      assert.equal(order.status, 'simulated', 'dry-run order status should be simulated');
    }
    restoreLogs();
  });

  it('resets cycle counters', () => {
    purchaser.addToCart(makeDeal({ asin: 'B000RST01', price: 50 }));
    const resetResult = purchaser.resetCycle();

    assert.ok(typeof resetResult.previousSpend === 'number', 'previousSpend should be a number');
    assert.ok(typeof resetResult.previousItemCount === 'number', 'previousItemCount should be a number');

    const budget = purchaser.checkBudget();
    // After reset the remaining should equal full budget
    if (budget instanceof Promise) {
      budget.then((b) => {
        assert.equal(b.remaining, 500, 'remaining budget should be full after reset');
      });
    }
    restoreLogs();
  });
});

// ===========================================================================
// Lister
// ===========================================================================
describe('Lister', () => {
  let lister;

  beforeEach(() => {
    silenceLogs();
    lister = createLister({ markupPct: 0.40, dryRun: true, llmApiKey: '' });
  });

  it('calculates target price with markup', () => {
    const deal = makeDeal({ price: 25, sourcePrice: 25 });
    const pricing = lister.calculateTargetPrice(deal);

    assert.ok(typeof pricing.targetPrice === 'number', 'targetPrice should be a number');
    assert.ok(pricing.targetPrice > deal.price, 'target price should exceed source price');
    assert.ok(pricing.markup > 0, 'markup should be positive');
    // 25 * 1.40 = 35 before platform fees adjustment
    assert.ok(pricing.targetPrice >= 35, 'target should be at least sourcePrice * (1 + markupPct)');
    restoreLogs();
  });

  it('creates listing in draft status', async () => {
    const draftLister = createLister({ markupPct: 0.40, dryRun: false, llmApiKey: '' });
    const deal = makeDeal({ asin: 'B000LST01', price: 20 });
    const listing = await draftLister.createListing(deal);

    assert.ok(listing.listingId, 'listing should have an id');
    assert.equal(listing.status, 'draft', 'new listing should be in draft status');
    assert.ok(listing.title, 'listing should have a title');
    assert.ok(listing.price > 0, 'listing price should be positive');
    restoreLogs();
  });

  it('generates template content without LLM key', async () => {
    const deal = makeDeal({ asin: 'B000TPL01', name: 'Cool Gadget', price: 30 });
    const content = await lister.generateListingContent(deal);

    assert.ok(content.title, 'should generate a title');
    assert.ok(content.description, 'should generate a description');
    assert.ok(content.title.length > 0, 'title should not be empty');
    assert.ok(content.description.length > 0, 'description should not be empty');
    restoreLogs();
  });
});

// ===========================================================================
// Tracker
// ===========================================================================
describe('Tracker', () => {
  let tracker;

  beforeEach(() => {
    silenceLogs();
    tracker = createTracker();
  });

  it('adds item to inventory', () => {
    const item = { asin: 'B000TRK01', sourceCost: 25, name: 'Tracked Widget' };
    const record = tracker.addItem(item);

    assert.equal(record.asin, 'B000TRK01', 'record asin should match');
    assert.equal(record.status, 'purchased', 'initial status should be purchased');
    assert.equal(record.sourceCost, 25, 'sourceCost should match');

    const inv = tracker.getInventory();
    assert.equal(inv.length, 1, 'inventory should have one item');
    restoreLogs();
  });

  it('validates status transitions', () => {
    tracker.addItem({ asin: 'B000TRS01', sourceCost: 30 });
    // purchased → listed is valid
    tracker.updateStatus('B000TRS01', 'listed');

    // listed → sold is valid
    tracker.updateStatus('B000TRS01', 'sold');

    // sold → purchased is NOT valid
    assert.throws(
      () => tracker.updateStatus('B000TRS01', 'purchased'),
      /invalid|transition|cannot/i,
      'sold → purchased should throw an invalid transition error',
    );
    restoreLogs();
  });

  it('records sale and calculates P&L', () => {
    tracker.addItem({ asin: 'B000SAL01', sourceCost: 20 });
    tracker.updateStatus('B000SAL01', 'listed');

    const sale = tracker.recordSale('B000SAL01', { salePrice: 55, fees: 8 });

    assert.ok(sale, 'recordSale should return a sale record');
    const pnl = tracker.getItemPnL('B000SAL01');
    assert.ok(typeof pnl.netProfit === 'number', 'P&L should have netProfit');
    // netProfit = 55 - 20 - 8 - shipping = positive
    assert.ok(pnl.netProfit > 0, 'net profit should be positive for this deal');
    restoreLogs();
  });

  it('calculates aggregate P&L', () => {
    // Item A: buy 20, sell 55, fees 8
    tracker.addItem({ asin: 'B000AGG01', sourceCost: 20 });
    tracker.updateStatus('B000AGG01', 'listed');
    tracker.recordSale('B000AGG01', { salePrice: 55, fees: 8 });

    // Item B: buy 15, sell 40, fees 6
    tracker.addItem({ asin: 'B000AGG02', sourceCost: 15 });
    tracker.updateStatus('B000AGG02', 'listed');
    tracker.recordSale('B000AGG02', { salePrice: 40, fees: 6 });

    const agg = tracker.getAggregatePnL();

    assert.ok(typeof agg.totalInvested === 'number', 'aggregate should have totalInvested');
    assert.ok(typeof agg.totalRevenue === 'number', 'aggregate should have totalRevenue');
    assert.ok(typeof agg.netProfit === 'number', 'aggregate should have netProfit');
    assert.equal(agg.totalInvested, 35, 'totalInvested should be 20 + 15');
    assert.equal(agg.totalRevenue, 95, 'totalRevenue should be 55 + 40');
    assert.equal(agg.soldCount, 2, 'soldCount should be 2');
    assert.ok(agg.netProfit > 0, 'aggregate net profit should be positive');
    restoreLogs();
  });

  it('tracks returns with P&L adjustment', () => {
    tracker.addItem({ asin: 'B000RET01', sourceCost: 25 });
    tracker.updateStatus('B000RET01', 'listed');
    tracker.recordSale('B000RET01', { salePrice: 60, fees: 9 });

    const pnlBefore = tracker.getItemPnL('B000RET01');
    const profitBefore = pnlBefore.netProfit;

    tracker.recordReturn('B000RET01', { refundAmount: 60, restockFee: 5, reason: 'defective' });

    const pnlAfter = tracker.getItemPnL('B000RET01');
    assert.ok(pnlAfter.netProfit < profitBefore, 'P&L should decrease after return');

    const returns = tracker.getReturns();
    assert.ok(returns.length >= 1, 'returns should have at least one entry');
    restoreLogs();
  });
});

// ===========================================================================
// Scheduler
// ===========================================================================
describe('Scheduler', () => {
  let scheduler;
  let mockScanner, mockAnalyzer, mockPurchaser, mockLister, mockTracker;

  beforeEach(() => {
    silenceLogs();
    mockScanner = createMockScanner();
    mockAnalyzer = createMockAnalyzer();
    mockPurchaser = createMockPurchaser();
    mockLister = createMockLister();
    mockTracker = createMockTracker();

    scheduler = createScheduler({
      scanner: mockScanner,
      analyzer: mockAnalyzer,
      purchaser: mockPurchaser,
      lister: mockLister,
      tracker: mockTracker,
      scanIntervalHours: 1,
      enabled: true,
    });
  });

  it('starts and stops cleanly', () => {
    const startResult = scheduler.start();
    assert.ok(startResult.started === true || scheduler.isRunning(), 'scheduler should be running after start');
    assert.ok(scheduler.isRunning(), 'isRunning should return true');

    const stopResult = scheduler.stop();
    assert.ok(stopResult.stopped === true || !scheduler.isRunning(), 'scheduler should stop');
    assert.equal(scheduler.isRunning(), false, 'isRunning should return false after stop');
    restoreLogs();
  });
});

// ===========================================================================
// RetailArbitrageSystem (integration)
// ===========================================================================
describe('RetailArbitrageSystem (integration)', () => {
  let system;

  beforeEach(() => {
    silenceLogs();
    system = createRetailArbitrageSystem({
      dryRun: true,
      budgetPerCycle: 500,
      minMargin: 0.30,
      maxRank: 100000,
      markupPct: 0.40,
    });
  });

  it('creates system with all modules wired', () => {
    assert.ok(system.scanner, 'system should have scanner');
    assert.ok(system.analyzer, 'system should have analyzer');
    assert.ok(system.purchaser, 'system should have purchaser');
    assert.ok(system.lister, 'system should have lister');
    assert.ok(system.tracker, 'system should have tracker');
    assert.ok(system.scheduler, 'system should have scheduler');
    assert.ok(typeof system.getStatus === 'function', 'system should have getStatus method');
    assert.ok(typeof system.init === 'function', 'system should have init method');
    restoreLogs();
  });

  it('getStatus returns combined status', () => {
    const status = system.getStatus();

    assert.ok(status.scanner, 'status should include scanner config');
    assert.ok(status.analyzer, 'status should include analyzer config');
    assert.ok(status.purchaser, 'status should include purchaser config');
    assert.ok(status.lister, 'status should include lister config');
    assert.ok(status.tracker, 'status should include tracker summary');
    assert.ok(status.scheduler, 'status should include scheduler status');
    restoreLogs();
  });
});
