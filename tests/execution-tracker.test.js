/**
 * Tests for execution-tracker.js — Trade execution quality analyzer.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ExecutionTracker,
  createExecutionTracker,
  getExecutionToolDefinitions,
  handleExecutionToolCall,
} from '../execution-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'exec-test-'));
}

function makeOrder(overrides = {}) {
  return {
    orderId: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    symbol: 'AAPL',
    side: 'buy',
    qty: 10,
    type: 'limit',
    limitPrice: 150,
    bid: 149.90,
    ask: 150.10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExecutionTracker', () => {
  let tempDir;
  before(() => { tempDir = makeTempDir(); });
  after(() => { rmSync(tempDir, { recursive: true }); });

  it('returns a tracker with expected methods', () => {
    const tracker = new ExecutionTracker(tempDir);
    assert.equal(typeof tracker.recordOrder, 'function');
    assert.equal(typeof tracker.recordFill, 'function');
    assert.equal(typeof tracker.getExecutionStats, 'function');
    assert.equal(typeof tracker.getRecentExecutions, 'function');
  });
});

describe('recordOrder', () => {
  let tempDir, tracker;
  before(() => { tempDir = makeTempDir(); tracker = new ExecutionTracker(tempDir); });
  after(() => { rmSync(tempDir, { recursive: true }); });

  it('creates a pending record with correct fields', () => {
    const order = makeOrder({ orderId: 'test-001', symbol: 'TSLA' });
    const record = tracker.recordOrder(order);

    assert.equal(record.orderId, 'test-001');
    assert.equal(record.symbol, 'TSLA');
    assert.equal(record.side, 'buy');
    assert.equal(record.qty, 10);
    assert.equal(record.status, 'pending');
    assert.equal(record.fillPrice, null);
    assert.equal(record.slippagePct, null);
    assert.equal(typeof record.id, 'string');
    assert.equal(typeof record.placedAt, 'number');
  });
});

describe('recordFill', () => {
  let tempDir, tracker;
  before(() => { tempDir = makeTempDir(); tracker = new ExecutionTracker(tempDir); });
  after(() => { rmSync(tempDir, { recursive: true }); });

  it('updates record with fill price and calculates slippage', () => {
    tracker.recordOrder(makeOrder({ orderId: 'fill-001', limitPrice: 150 }));
    const filled = tracker.recordFill('fill-001', { price: 150.30 });

    assert.notEqual(filled, null);
    assert.equal(filled.status, 'filled');
    assert.equal(filled.fillPrice, 150.30);
    assert.equal(typeof filled.slippagePct, 'number');
    assert.ok(filled.slippagePct > 0, 'buy slippage should be positive when fill > limit');
    assert.equal(typeof filled.fillTimeMs, 'number');
  });

  it('returns null for unknown orderId', () => {
    const result = tracker.recordFill('nonexistent-id', { price: 100 });
    assert.equal(result, null);
  });
});

describe('getExecutionStats', () => {
  it('returns zero counts with no orders', () => {
    const tempDir = makeTempDir();
    try {
      const tracker = new ExecutionTracker(tempDir);
      const stats = tracker.getExecutionStats();

      assert.equal(stats.totalOrders, 0);
      assert.equal(stats.filledOrders, 0);
      assert.equal(stats.fillRate, 0);
      assert.equal(stats.avgSlippagePct, 0);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  it('computes correct fillRate and slippage after recording + filling', () => {
    const tempDir = makeTempDir();
    try {
      const tracker = new ExecutionTracker(tempDir);

      tracker.recordOrder(makeOrder({ orderId: 's-001', limitPrice: 100 }));
      tracker.recordFill('s-001', { price: 100.50 });

      tracker.recordOrder(makeOrder({ orderId: 's-002', limitPrice: 200 }));
      tracker.recordFill('s-002', { price: 201.00 });

      // Third order left unfilled
      tracker.recordOrder(makeOrder({ orderId: 's-003' }));

      const stats = tracker.getExecutionStats();
      assert.equal(stats.totalOrders, 3);
      assert.equal(stats.filledOrders, 2);
      assert.equal(stats.fillRate, 66.67);
      assert.equal(typeof stats.avgSlippagePct, 'number');
      assert.ok(stats.avgSlippagePct > 0, 'avg slippage should be positive for overpays');
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });
});

describe('getRecentExecutions', () => {
  let tempDir, tracker;
  before(() => {
    tempDir = makeTempDir();
    tracker = new ExecutionTracker(tempDir);
    for (let i = 0; i < 5; i++) {
      tracker.recordOrder(makeOrder({ orderId: `recent-${i}`, symbol: `SYM${i}` }));
    }
  });
  after(() => { rmSync(tempDir, { recursive: true }); });

  it('returns last N records in newest-first order', () => {
    const recent = tracker.getRecentExecutions(3);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].orderId, 'recent-4');
    assert.equal(recent[2].orderId, 'recent-2');
  });
});

describe('getExecutionToolDefinitions', () => {
  it('returns array of 2 tools with valid schemas', () => {
    const tools = getExecutionToolDefinitions();
    assert.ok(Array.isArray(tools));
    assert.equal(tools.length, 2);

    for (const tool of tools) {
      assert.equal(typeof tool.name, 'string');
      assert.equal(typeof tool.description, 'string');
      assert.equal(typeof tool.inputSchema, 'object');
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.inputSchema.properties, 'tool schema should have properties');
    }

    const names = tools.map(t => t.name);
    assert.ok(names.includes('get_execution_stats'));
    assert.ok(names.includes('record_execution'));
  });
});

describe('slippage calculation', () => {
  let tempDir, tracker;
  before(() => { tempDir = makeTempDir(); tracker = new ExecutionTracker(tempDir); });
  after(() => { rmSync(tempDir, { recursive: true }); });

  it('limit buy at $100 filled at $100.50 → positive slippage of 0.5%', () => {
    tracker.recordOrder(makeOrder({
      orderId: 'slip-001', side: 'buy', type: 'limit',
      limitPrice: 100, bid: 99.90, ask: 100.10,
    }));
    const filled = tracker.recordFill('slip-001', { price: 100.50 });

    assert.notEqual(filled, null);
    assert.equal(filled.slippagePct, 0.5);
    assert.equal(filled.priceImprovement, false);
  });
});
