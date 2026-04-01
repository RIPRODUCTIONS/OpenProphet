/**
 * Strategy preset loader for OpenProphet.
 *
 * Reads all JSON files from the strategies/ directory and exposes them
 * as a keyed map. Used by the agent harness to resolve strategyId references
 * and by the risk guard to apply strategy-specific config overrides.
 *
 * @module strategies/index
 * @example
 * ```js
 * import { getStrategy, listStrategies, loadStrategies } from './strategies/index.js';
 *
 * const all = listStrategies();          // [{ id, name, description, version, assetClasses }, ...]
 * const s   = getStrategy('crypto-dca'); // full strategy object or null
 * ```
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, object>} */
let cache = null;

/**
 * Load all strategy JSON files from the strategies/ directory.
 * Results are cached after first call. Pass `force: true` to reload.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<Map<string, object>>} Map of strategy id → full config
 */
export async function loadStrategies({ force = false } = {}) {
  if (cache && !force) return cache;

  const map = new Map();
  let files;

  try {
    files = await readdir(__dirname);
  } catch (err) {
    console.error(`[strategies] Failed to read directory ${__dirname}:`, err.message);
    cache = map;
    return map;
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const results = await Promise.allSettled(
    jsonFiles.map(async (file) => {
      const raw = await readFile(join(__dirname, file), 'utf-8');
      const strategy = JSON.parse(raw);

      if (!strategy.id) {
        console.warn(`[strategies] Skipping ${file}: missing "id" field`);
        return null;
      }

      return strategy;
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      map.set(result.value.id, result.value);
    } else if (result.status === 'rejected') {
      console.error(`[strategies] Failed to load preset:`, result.reason.message);
    }
  }

  cache = map;
  console.log(`[strategies] Loaded ${map.size} strategy preset(s): ${[...map.keys()].join(', ')}`);
  return map;
}

/**
 * Get a strategy by its id. Loads from cache if available.
 *
 * @param {string} id - Strategy identifier (e.g. "crypto-scalper")
 * @returns {Promise<object|null>} Full strategy config or null if not found
 */
export async function getStrategy(id) {
  const map = await loadStrategies();
  return map.get(id) ?? null;
}

/**
 * List all available strategies with summary info.
 *
 * @returns {Promise<Array<{ id: string, name: string, description: string, version: string, assetClasses: string[] }>>}
 */
export async function listStrategies() {
  const map = await loadStrategies();
  return [...map.values()].map(({ id, name, description, version, assetClasses }) => ({
    id,
    name,
    description,
    version,
    assetClasses,
  }));
}

/**
 * Resolve a strategy's riskGuard overrides for use with the RiskGuard constructor.
 * Returns an empty object if the strategy doesn't exist or has no overrides.
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getRiskGuardOverrides(id) {
  const strategy = await getStrategy(id);
  return strategy?.riskGuard ?? {};
}

/**
 * Resolve a strategy's heartbeat config for use with the agent harness.
 * Returns null if the strategy doesn't exist or has no heartbeat config.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getHeartbeatConfig(id) {
  const strategy = await getStrategy(id);
  return strategy?.heartbeat ?? null;
}

/**
 * Invalidate the cache. Next call to any getter will re-read from disk.
 */
export function clearCache() {
  cache = null;
}
