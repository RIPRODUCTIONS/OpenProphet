/**
 * secrets-loader.js — Decrypts and injects encrypted secrets into process.env at startup.
 *
 * Import at application boot before any module reads process.env:
 *
 *   import { loadSecrets } from './config/secrets-loader.js';
 *   const result = loadSecrets();
 *
 * Behavior:
 *   1. If config/secrets.encrypted exists AND OPENPROPHET_MASTER_KEY is set:
 *      → Decrypt and merge into process.env. Returns { source: 'encrypted', count }.
 *   2. Otherwise, assume .env is already loaded via dotenv.
 *      → Returns { source: 'env', count: 0 }.
 *
 * This is fully backward-compatible — when no encrypted file exists, nothing changes.
 *
 * @module config/secrets-loader
 */

import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENCRYPTED_PATH = resolve(__dirname, 'secrets.encrypted');

// ---------------------------------------------------------------------------
// Crypto (mirrors scripts/secrets.js — kept minimal to avoid importing CLI)
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';
const KEY_LENGTH = 32;

function deriveKey(passphrase, salt) {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Decrypt an encrypted payload using AES-256-GCM.
 * @param {{ version: number, salt: string, iv: string, tag: string, data: string }} payload
 * @param {string} passphrase
 * @returns {string}
 */
function decryptPayload(payload, passphrase) {
  if (payload.version !== 1) {
    throw new Error(`Unsupported secrets file version: ${payload.version}`);
  }

  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const data = Buffer.from(payload.data, 'hex');
  const key = deriveKey(passphrase, salt);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Parse decrypted .env-format text into key-value pairs.
 * @param {string} text
 * @returns {Array<{ key: string, value: string }>}
 */
function parseEntries(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    entries.push({
      key: trimmed.slice(0, eqIdx).trim(),
      value: trimmed.slice(eqIdx + 1).trim(),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load secrets into process.env.
 *
 * If the encrypted secrets file exists and a master key is available,
 * decrypts and injects secrets. Otherwise falls back to .env (no-op).
 *
 * @returns {{ source: 'encrypted' | 'env', count: number }}
 */
export function loadSecrets() {
  const passphrase = process.env.OPENPROPHET_MASTER_KEY;

  if (!existsSync(ENCRYPTED_PATH) || !passphrase) {
    console.error('[secrets-loader] Using .env file for secrets (unencrypted)');
    return { source: 'env', count: 0 };
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(ENCRYPTED_PATH, 'utf8'));
  } catch (err) {
    console.error(`[secrets-loader] Failed to read encrypted secrets: ${err.message}`);
    console.error('[secrets-loader] Falling back to .env file for secrets (unencrypted)');
    return { source: 'env', count: 0 };
  }

  let plaintext;
  try {
    plaintext = decryptPayload(payload, passphrase);
  } catch (err) {
    console.error(`[secrets-loader] Decryption failed: ${err.message}`);
    console.error('[secrets-loader] Falling back to .env file for secrets (unencrypted)');
    return { source: 'env', count: 0 };
  }

  const entries = parseEntries(plaintext);
  let count = 0;

  for (const { key, value } of entries) {
    if (value) {
      process.env[key] = value;
      count++;
    }
  }

  console.error(`[secrets-loader] Loaded encrypted secrets (${count} keys)`);
  return { source: 'encrypted', count };
}

export default loadSecrets;
