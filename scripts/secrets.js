#!/usr/bin/env node
/**
 * secrets.js — CLI for encrypting/decrypting sensitive environment variables.
 *
 * Usage:
 *   node scripts/secrets.js encrypt              # .env → config/secrets.encrypted
 *   node scripts/secrets.js decrypt              # config/secrets.encrypted → stdout
 *   node scripts/secrets.js decrypt --output .env # decrypt to file
 *   node scripts/secrets.js rotate               # re-encrypt with new passphrase
 *
 * Passphrase source: OPENPROPHET_MASTER_KEY env var, or interactive stdin prompt.
 * Encryption: AES-256-GCM with PBKDF2-derived key (100k iterations, SHA-512).
 *
 * @module scripts/secrets
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DEFAULT_ENV_PATH = resolve(PROJECT_ROOT, '.env');
const ENCRYPTED_PATH = resolve(PROJECT_ROOT, 'config', 'secrets.encrypted');

const SENSITIVE_PATTERNS = ['KEY', 'SECRET', 'TOKEN', 'PASSPHRASE', 'WEBHOOK'];
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha512';
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const FILE_VERSION = 1;

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * Derive a 256-bit AES key from a passphrase and salt.
 * @param {string} passphrase
 * @param {Buffer} salt
 * @returns {Buffer}
 */
function deriveKey(passphrase, salt) {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * @param {string} plaintext
 * @param {string} passphrase
 * @returns {{ version: number, salt: string, iv: string, tag: string, data: string }}
 */
function encrypt(plaintext, passphrase) {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: FILE_VERSION,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

/**
 * Decrypt an encrypted payload with AES-256-GCM.
 * @param {{ version: number, salt: string, iv: string, tag: string, data: string }} payload
 * @param {string} passphrase
 * @returns {string}
 */
function decrypt(payload, passphrase) {
  if (payload.version !== FILE_VERSION) {
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

// ---------------------------------------------------------------------------
// .env parsing
// ---------------------------------------------------------------------------

/**
 * Parse a .env file into key-value pairs, preserving order.
 * Returns all entries; comments and blank lines are skipped.
 * @param {string} envPath
 * @returns {Array<{ key: string, value: string }>}
 */
function parseEnvFile(envPath) {
  const content = readFileSync(envPath, 'utf8');
  const entries = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    entries.push({ key, value });
  }

  return entries;
}

/**
 * Check if an env key holds a sensitive value based on naming patterns.
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  const upper = key.toUpperCase();
  return SENSITIVE_PATTERNS.some(pattern => upper.includes(pattern));
}

/**
 * Serialize key-value pairs back to .env format.
 * @param {Array<{ key: string, value: string }>} entries
 * @returns {string}
 */
function serializeEntries(entries) {
  return entries.map(({ key, value }) => `${key}=${value}`).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Passphrase prompt
// ---------------------------------------------------------------------------

/**
 * Get the master passphrase from env var or interactive prompt.
 * @param {string} [promptMsg]
 * @returns {Promise<string>}
 */
async function getPassphrase(promptMsg = 'Enter master passphrase: ') {
  const envKey = process.env.OPENPROPHET_MASTER_KEY;
  if (envKey) return envKey;

  // Interactive prompt — read from TTY so piped stdin doesn't interfere
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(
        'No OPENPROPHET_MASTER_KEY env var set and stdin is not a TTY.\n' +
        'Set OPENPROPHET_MASTER_KEY or run interactively.'
      ));
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(promptMsg, (answer) => {
      rl.close();
      if (!answer || !answer.trim()) {
        reject(new Error('Passphrase cannot be empty'));
        return;
      }
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdEncrypt() {
  if (!existsSync(DEFAULT_ENV_PATH)) {
    console.error(`Error: .env file not found at ${DEFAULT_ENV_PATH}`);
    process.exit(1);
  }

  const entries = parseEnvFile(DEFAULT_ENV_PATH);
  const sensitive = entries.filter(e => isSensitiveKey(e.key) && e.value);
  const nonSensitive = entries.filter(e => !isSensitiveKey(e.key) || !e.value);

  if (sensitive.length === 0) {
    console.error('No sensitive keys with values found in .env — nothing to encrypt.');
    process.exit(0);
  }

  console.error(`Found ${sensitive.length} sensitive key(s) to encrypt:`);
  for (const { key } of sensitive) {
    console.error(`  • ${key}`);
  }
  console.error(`Leaving ${nonSensitive.length} non-sensitive key(s) in .env.`);

  const passphrase = await getPassphrase();
  const plaintext = serializeEntries(sensitive);
  const payload = encrypt(plaintext, passphrase);

  // Ensure config/ directory exists
  const configDir = dirname(ENCRYPTED_PATH);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  writeFileSync(ENCRYPTED_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.error(`\n✓ Encrypted ${sensitive.length} secret(s) → ${ENCRYPTED_PATH}`);
}

async function cmdDecrypt(outputPath) {
  if (!existsSync(ENCRYPTED_PATH)) {
    console.error(`Error: Encrypted file not found at ${ENCRYPTED_PATH}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(ENCRYPTED_PATH, 'utf8'));
  const passphrase = await getPassphrase();

  let plaintext;
  try {
    plaintext = decrypt(payload, passphrase);
  } catch (err) {
    console.error('Decryption failed — wrong passphrase or corrupted file.');
    console.error(`  Detail: ${err.message}`);
    process.exit(1);
  }

  if (outputPath) {
    const resolved = resolve(PROJECT_ROOT, outputPath);
    writeFileSync(resolved, plaintext, 'utf8');
    console.error(`✓ Decrypted secrets written to ${resolved}`);
  } else {
    process.stdout.write(plaintext);
  }
}

async function cmdRotate() {
  if (!existsSync(ENCRYPTED_PATH)) {
    console.error(`Error: Encrypted file not found at ${ENCRYPTED_PATH}`);
    process.exit(1);
  }

  const payload = JSON.parse(readFileSync(ENCRYPTED_PATH, 'utf8'));

  console.error('Enter CURRENT passphrase to decrypt:');
  const oldPass = await getPassphrase('Current passphrase: ');

  let plaintext;
  try {
    plaintext = decrypt(payload, oldPass);
  } catch (err) {
    console.error('Decryption failed — wrong passphrase or corrupted file.');
    console.error(`  Detail: ${err.message}`);
    process.exit(1);
  }

  console.error('Enter NEW passphrase to re-encrypt:');
  const newPass = await getPassphrase('New passphrase: ');

  const newPayload = encrypt(plaintext, newPass);
  writeFileSync(ENCRYPTED_PATH, JSON.stringify(newPayload, null, 2) + '\n', 'utf8');
  console.error('✓ Secrets re-encrypted with new passphrase.');
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

if (command === 'encrypt') {
  await cmdEncrypt();
} else if (command === 'decrypt') {
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  await cmdDecrypt(outputPath);
} else if (command === 'rotate') {
  await cmdRotate();
} else if (command) {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: node scripts/secrets.js <encrypt|decrypt|rotate> [--output <path>]');
  process.exit(1);
}

// Export for programmatic use and testing
export { encrypt, decrypt, parseEnvFile, isSensitiveKey, serializeEntries };
