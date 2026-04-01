/**
 * Tests for strategies/index.js — strategy preset loader.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadStrategies,
  getStrategy,
  listStrategies,
  getRiskGuardOverrides,
  clearCache,
} from '../strategies/index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadStrategies', () => {
  beforeEach(() => { clearCache(); });

  it('returns a Map of strategy objects', async () => {
    const map = await loadStrategies();
    assert.ok(map instanceof Map, 'Should return a Map');
    assert.ok(map.size > 0, 'Should load at least one strategy');
  });

  it('every strategy has an id and name', async () => {
    const map = await loadStrategies();
    for (const [id, strategy] of map) {
      assert.equal(typeof id, 'string');
      assert.equal(strategy.id, id, 'Map key should match strategy.id');
      assert.ok(strategy.name, `Strategy ${id} should have a name`);
    }
  });

  it('uses cache on second call (returns same ref)', async () => {
    const map1 = await loadStrategies();
    const map2 = await loadStrategies();
    assert.equal(map1, map2, 'Should return cached Map');
  });
});

describe('getStrategy', () => {
  beforeEach(() => { clearCache(); });

  it('returns the crypto-scalper strategy', async () => {
    const s = await getStrategy('crypto-scalper');
    assert.ok(s, 'crypto-scalper should exist');
    assert.equal(s.id, 'crypto-scalper');
    assert.ok(s.name);
    assert.ok(s.description);
  });

  it('returns null for nonexistent strategy', async () => {
    const s = await getStrategy('nonexistent-strategy-xyz');
    assert.equal(s, null);
  });
});

describe('getRiskGuardOverrides', () => {
  beforeEach(() => { clearCache(); });

  it('returns an object with risk guard config keys for crypto-scalper', async () => {
    const overrides = await getRiskGuardOverrides('crypto-scalper');
    assert.equal(typeof overrides, 'object');
    assert.ok(overrides !== null);
    // crypto-scalper has riskGuard overrides
    assert.ok('maxPositionPct' in overrides, 'Should include maxPositionPct');
    assert.ok('maxDailyTrades' in overrides, 'Should include maxDailyTrades');
  });

  it('returns empty object for nonexistent strategy', async () => {
    const overrides = await getRiskGuardOverrides('does-not-exist');
    assert.deepEqual(overrides, {});
  });
});

describe('listStrategies', () => {
  beforeEach(() => { clearCache(); });

  it('returns array of summary objects', async () => {
    const list = await listStrategies();
    assert.ok(Array.isArray(list), 'Should return an array');
    assert.ok(list.length > 0, 'Should list at least one strategy');

    for (const item of list) {
      assert.ok(item.id, 'Each item should have an id');
      assert.ok(item.name, 'Each item should have a name');
      assert.equal(typeof item.description, 'string');
    }
  });

  it('does not include full strategy details like agentPrompt', async () => {
    const list = await listStrategies();
    for (const item of list) {
      assert.equal(item.agentPrompt, undefined, 'Summary should not include agentPrompt');
      assert.equal(item.riskGuard, undefined, 'Summary should not include riskGuard block');
    }
  });
});

describe('clearCache', () => {
  it('forces reload from disk on next call', async () => {
    const map1 = await loadStrategies();
    clearCache();
    const map2 = await loadStrategies();
    assert.notEqual(map1, map2, 'After clearCache, should return a new Map');
    assert.equal(map1.size, map2.size, 'Content should be identical');
  });
});
