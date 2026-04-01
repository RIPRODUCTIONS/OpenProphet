/**
 * Tests for crypto-tools.js — MCP crypto tool definitions.
 * Uses Node.js built-in test runner (node:test + node:assert).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getCryptoToolDefinitions, isCryptoTool } from '../crypto-tools.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getCryptoToolDefinitions', () => {
  const tools = getCryptoToolDefinitions();

  it('returns an array of tool objects', () => {
    assert.ok(Array.isArray(tools), 'Should return an array');
    assert.ok(tools.length > 0, 'Should define at least one tool');
  });

  it('every tool has name, description, and inputSchema', () => {
    for (const tool of tools) {
      assert.ok(tool.name, `Tool missing name: ${JSON.stringify(tool)}`);
      assert.equal(typeof tool.description, 'string', `Tool ${tool.name} missing description`);
      assert.ok(tool.inputSchema, `Tool ${tool.name} missing inputSchema`);
      assert.equal(tool.inputSchema.type, 'object', `Tool ${tool.name} inputSchema should be type "object"`);
    }
  });

  it('tool names start with expected prefixes', () => {
    const validPrefixes = ['get_crypto_', 'place_crypto_', 'cancel_crypto_'];
    for (const tool of tools) {
      const hasPrefix = validPrefixes.some(p => tool.name.startsWith(p));
      assert.ok(hasPrefix,
        `Tool "${tool.name}" does not start with any of: ${validPrefixes.join(', ')}`);
    }
  });

  it('no duplicate tool names', () => {
    const names = tools.map(t => t.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, 'Tool names must be unique');
  });
});

describe('isCryptoTool', () => {
  it('returns true for crypto tool names', () => {
    assert.equal(isCryptoTool('place_crypto_order'), true);
    assert.equal(isCryptoTool('get_crypto_ticker'), true);
    assert.equal(isCryptoTool('get_crypto_balance'), true);
    assert.equal(isCryptoTool('cancel_crypto_order'), true);
  });

  it('returns false for non-crypto tool names', () => {
    assert.equal(isCryptoTool('place_order'), false);
    assert.equal(isCryptoTool('get_account'), false);
    assert.equal(isCryptoTool(''), false);
    assert.equal(isCryptoTool('crypto'), false);
  });
});
