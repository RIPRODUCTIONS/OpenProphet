/**
 * alerts.js — Multi-channel trade alert & notification system for OpenProphet.
 *
 * Sends formatted alerts to Telegram, Discord, and generic webhooks.
 * Rate-limited, queued, and retried — never blocks the trading loop.
 *
 * @module alerts
 */

import crypto from 'node:crypto';
import axios from 'axios';

// ─── Structured Logging ──────────────────────────────────────────────────────

/**
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    module: 'alerts',
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// ─── Rate Limiter (Token Bucket) ─────────────────────────────────────────────

class RateLimiter {
  /** @param {number} maxPerMinute */
  constructor(maxPerMinute) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.lastRefill = Date.now();
    this.intervalMs = 60_000;
  }

  /** @returns {boolean} true if a token was consumed */
  consume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** @returns {number} ms until next token available */
  msUntilAvailable() {
    this._refill();
    if (this.tokens >= 1) return 0;
    const elapsed = Date.now() - this.lastRefill;
    const perToken = this.intervalMs / this.maxTokens;
    return Math.max(0, perToken - elapsed);
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refill = (elapsed / this.intervalMs) * this.maxTokens;
    this.tokens = Math.min(this.maxTokens, this.tokens + refill);
    this.lastRefill = now;
  }
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

/** @param {number} n */
const usd = (n) => {
  const abs = Math.abs(n);
  const formatted = abs >= 1 ? abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : abs.toFixed(4);
  return `${n < 0 ? '-' : ''}$${formatted}`;
};

/** @param {number} pct */
const pct = (pct) => `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;

/**
 * Format milliseconds into human-readable hold time.
 * @param {number} ms
 * @returns {string}
 */
function formatHoldTime(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

/** @param {string} s */
const escMd = (s) => String(s).replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');

// ─── Channel Senders ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} ChannelResult
 * @property {string} channel
 * @property {boolean} ok
 * @property {string} [error]
 */

/**
 * Send a Telegram message via Bot API.
 * @param {{ botToken: string, chatId: string }} cfg
 * @param {string} text - MarkdownV2 formatted
 * @returns {Promise<ChannelResult>}
 */
async function sendTelegram(cfg, text) {
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const resp = await axios.post(url, {
    chat_id: cfg.chatId,
    text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  }, { timeout: 10_000 });

  if (!resp.data?.ok) {
    throw new Error(resp.data?.description || 'Telegram API returned ok=false');
  }
  return { channel: 'telegram', ok: true };
}

/**
 * Send a Discord message via webhook.
 * @param {{ webhookUrl: string }} cfg
 * @param {{ title: string, description: string, color: number, fields?: Array<{name: string, value: string, inline?: boolean}> }} embed
 * @returns {Promise<ChannelResult>}
 */
async function sendDiscord(cfg, embed) {
  await axios.post(cfg.webhookUrl, {
    embeds: [{
      title: embed.title,
      description: embed.description,
      color: embed.color,
      fields: embed.fields || [],
      timestamp: new Date().toISOString(),
      footer: { text: 'OpenProphet Alerts' },
    }],
  }, { timeout: 10_000 });
  return { channel: 'discord', ok: true };
}

/**
 * Send a signed webhook POST.
 * @param {{ url: string, secret: string }} cfg
 * @param {object} payload
 * @returns {Promise<ChannelResult>}
 */
async function sendWebhook(cfg, payload) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', cfg.secret).update(body).digest('hex');

  await axios.post(cfg.url, body, {
    timeout: 10_000,
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signature,
      'X-Timestamp': Date.now().toString(),
    },
  });
  return { channel: 'webhook', ok: true };
}

// ─── Discord Color Codes ─────────────────────────────────────────────────────

const DISCORD_COLORS = {
  profit:   0x2ecc71, // green
  loss:     0xe74c3c, // red
  warning:  0xf1c40f, // yellow
  critical: 0xe74c3c, // red
  info:     0x3498db, // blue
  neutral:  0x95a5a6, // gray
};

// ─── AlertService ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AlertConfig
 * @property {boolean} [enabled=true] - Master switch for all alerts
 * @property {{ botToken: string, chatId: string, enabled: boolean }} [telegram]
 * @property {{ webhookUrl: string, enabled: boolean }} [discord]
 * @property {{ url: string, secret: string, enabled: boolean }} [webhook]
 */

/**
 * @typedef {Object} Alert
 * @property {'info'|'warning'|'critical'} severity
 * @property {string} type - Alert type identifier
 * @property {string} title - Short title
 * @property {string} telegramText - MarkdownV2 formatted for Telegram
 * @property {{ title: string, description: string, color: number, fields?: Array }} discordEmbed
 * @property {object} webhookPayload - Raw JSON for webhook
 */

class AlertService {
  /** @param {AlertConfig} config */
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.telegram = config.telegram || null;
    this.discord = config.discord || null;
    this.webhook = config.webhook || null;

    /** @type {Map<string, RateLimiter>} */
    this.limiters = new Map();
    for (const ch of ['telegram', 'discord', 'webhook']) {
      this.limiters.set(ch, new RateLimiter(30));
    }

    /** @type {Array<{ alert: Alert, retries: number, nextAttempt: number }>} */
    this._queue = [];
    this._processing = false;
    this._drainTimer = null;

    this._stats = { sent: 0, failed: 0, dropped: 0 };
  }

  // ── Core Send ────────────────────────────────────────────────────────────

  /**
   * Enqueue an alert for delivery to all enabled channels.
   * Returns immediately — never blocks the caller.
   * @param {Alert} alert
   */
  async send(alert) {
    if (!this.enabled) return;

    this._queue.push({ alert, retries: 0, nextAttempt: Date.now() });
    this._scheduleDrain();
  }

  /** Kick the queue processor if it isn't running. */
  _scheduleDrain() {
    if (this._processing) return;
    if (this._drainTimer) return;
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      this._drain();
    }, 0);
  }

  /** Process queued alerts with rate limiting and retry. */
  async _drain() {
    if (this._processing) return;
    this._processing = true;

    try {
      while (this._queue.length > 0) {
        const now = Date.now();
        const item = this._queue[0];

        // Not ready yet — schedule for later
        if (item.nextAttempt > now) {
          const delay = item.nextAttempt - now;
          this._drainTimer = setTimeout(() => {
            this._drainTimer = null;
            this._drain();
          }, delay);
          break;
        }

        this._queue.shift();
        await this._deliver(item);
      }
    } finally {
      this._processing = false;
    }
  }

  /**
   * Attempt delivery to all enabled channels.
   * @param {{ alert: Alert, retries: number, nextAttempt: number }} item
   */
  async _deliver(item) {
    const { alert, retries } = item;
    const channels = this._enabledChannels();

    if (channels.length === 0) return;

    const results = await Promise.allSettled(
      channels.map((ch) => this._sendToChannel(ch, alert)),
    );

    const failures = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        this._stats.sent++;
        log('INFO', `Alert sent`, { channel: channels[i], type: alert.type, severity: alert.severity });
      } else {
        failures.push({ channel: channels[i], error: r.reason?.message || String(r.reason) });
      }
    }

    if (failures.length > 0 && retries < 3) {
      const backoffMs = Math.min(1000 * 2 ** retries, 30_000);
      log('WARN', `Alert delivery failed, retrying in ${backoffMs}ms`, {
        type: alert.type,
        retries: retries + 1,
        failures,
      });
      this._queue.push({
        alert,
        retries: retries + 1,
        nextAttempt: Date.now() + backoffMs,
      });
      this._scheduleDrain();
    } else if (failures.length > 0) {
      this._stats.failed++;
      log('ERROR', `Alert delivery failed permanently`, {
        type: alert.type,
        failures,
      });
    }
  }

  /**
   * @param {string} channel
   * @param {Alert} alert
   * @returns {Promise<ChannelResult>}
   */
  async _sendToChannel(channel, alert) {
    const limiter = this.limiters.get(channel);
    if (!limiter.consume()) {
      const waitMs = limiter.msUntilAvailable();
      await new Promise((r) => setTimeout(r, waitMs));
      if (!limiter.consume()) {
        this._stats.dropped++;
        throw new Error(`Rate limited on ${channel}`);
      }
    }

    switch (channel) {
      case 'telegram':
        return sendTelegram(this.telegram, alert.telegramText);
      case 'discord':
        return sendDiscord(this.discord, alert.discordEmbed);
      case 'webhook':
        return sendWebhook(this.webhook, alert.webhookPayload);
      default:
        throw new Error(`Unknown channel: ${channel}`);
    }
  }

  /** @returns {string[]} */
  _enabledChannels() {
    const channels = [];
    if (this.telegram?.enabled && this.telegram.botToken && this.telegram.chatId) channels.push('telegram');
    if (this.discord?.enabled && this.discord.webhookUrl) channels.push('discord');
    if (this.webhook?.enabled && this.webhook.url && this.webhook.secret) channels.push('webhook');
    return channels;
  }

  // ── Pre-built Alert Types ────────────────────────────────────────────────

  /**
   * Alert when a trade is executed (opened).
   * @param {{ symbol: string, side: string, qty: number, price: number, type?: string }} trade
   */
  async tradeExecuted(trade) {
    const { symbol, side, qty, price, type = 'market' } = trade;
    const sideUp = side.toUpperCase();
    const emoji = sideUp === 'BUY' ? '🟢' : '🔴';
    const total = qty * price;
    const title = `${emoji} ${sideUp} ${qty}x ${symbol} @ ${usd(price)}`;
    const subtitle = `Total: ${usd(total)} | ${type}`;

    await this.send({
      severity: 'info',
      type: 'trade_executed',
      title,
      telegramText: `${emoji} *${escMd(sideUp)}* ${escMd(String(qty))}x ${escMd(symbol)} @ ${escMd(usd(price))}\nTotal: ${escMd(usd(total))} \\| ${escMd(type)}`,
      discordEmbed: {
        title,
        description: subtitle,
        color: sideUp === 'BUY' ? DISCORD_COLORS.profit : DISCORD_COLORS.loss,
        fields: [
          { name: 'Symbol', value: symbol, inline: true },
          { name: 'Side', value: sideUp, inline: true },
          { name: 'Qty', value: String(qty), inline: true },
          { name: 'Price', value: usd(price), inline: true },
          { name: 'Total', value: usd(total), inline: true },
          { name: 'Type', value: type, inline: true },
        ],
      },
      webhookPayload: { event: 'trade_executed', ...trade, total, ts: new Date().toISOString() },
    });
  }

  /**
   * Alert when a position is closed.
   * @param {{ symbol: string, pnl: number, pnlPct: number, holdTime: number }} trade
   */
  async tradeClosed(trade) {
    const { symbol, pnl, pnlPct, holdTime } = trade;
    const won = pnl >= 0;
    const emoji = won ? '💰' : '💸';
    const title = `${emoji} CLOSED ${symbol} ${won ? '+' : ''}${usd(pnl)} (${pct(pnlPct)})`;
    const held = formatHoldTime(holdTime);

    await this.send({
      severity: 'info',
      type: 'trade_closed',
      title,
      telegramText: `${emoji} *CLOSED* ${escMd(symbol)} ${escMd(won ? '+' : '')}${escMd(usd(pnl))} \\(${escMd(pct(pnlPct))}\\)\nHeld ${escMd(held)}`,
      discordEmbed: {
        title,
        description: `Held ${held}`,
        color: won ? DISCORD_COLORS.profit : DISCORD_COLORS.loss,
        fields: [
          { name: 'Symbol', value: symbol, inline: true },
          { name: 'P&L', value: `${won ? '+' : ''}${usd(pnl)}`, inline: true },
          { name: 'Return', value: pct(pnlPct), inline: true },
          { name: 'Hold Time', value: held, inline: true },
        ],
      },
      webhookPayload: { event: 'trade_closed', ...trade, holdTimeFormatted: held, ts: new Date().toISOString() },
    });
  }

  /**
   * Alert when daily loss limit is triggered.
   * @param {{ dailyPL: number, limit: number, date?: string }} details
   */
  async dailyLossTriggered(details) {
    const { dailyPL, limit, date = new Date().toISOString().slice(0, 10) } = details;
    const limitPct = limit;
    const title = `⚠️ DAILY LOSS LIMIT ${usd(dailyPL)} (${pct(-Math.abs(limitPct))})`;

    await this.send({
      severity: 'warning',
      type: 'daily_loss_triggered',
      title,
      telegramText: `⚠️ *DAILY LOSS LIMIT*\n${escMd(usd(dailyPL))} \\(${escMd(pct(-Math.abs(limitPct)))}\\)\nTrading paused for ${escMd(date)}`,
      discordEmbed: {
        title,
        description: `Trading paused for ${date}`,
        color: DISCORD_COLORS.warning,
        fields: [
          { name: 'Daily P&L', value: usd(dailyPL), inline: true },
          { name: 'Limit', value: pct(-Math.abs(limitPct)), inline: true },
          { name: 'Date', value: date, inline: true },
        ],
      },
      webhookPayload: { event: 'daily_loss_triggered', ...details, date, ts: new Date().toISOString() },
    });
  }

  /**
   * Alert when max drawdown triggers a full halt.
   * @param {{ drawdown: number, peak: number, current: number }} details
   */
  async drawdownHalt(details) {
    const { drawdown, peak, current } = details;
    const title = `🚨 DRAWDOWN HALT ${pct(-Math.abs(drawdown))} from peak ${usd(peak)}`;

    await this.send({
      severity: 'critical',
      type: 'drawdown_halt',
      title,
      telegramText: `🚨 *DRAWDOWN HALT*\n${escMd(pct(-Math.abs(drawdown)))} from peak ${escMd(usd(peak))}\nCurrent: ${escMd(usd(current))} \\| *FULL STOP*`,
      discordEmbed: {
        title,
        description: 'FULL STOP — Manual intervention required',
        color: DISCORD_COLORS.critical,
        fields: [
          { name: 'Drawdown', value: pct(-Math.abs(drawdown)), inline: true },
          { name: 'Peak', value: usd(peak), inline: true },
          { name: 'Current', value: usd(current), inline: true },
        ],
      },
      webhookPayload: { event: 'drawdown_halt', ...details, ts: new Date().toISOString() },
    });
  }

  /**
   * Alert on system errors.
   * @param {{ component: string, message: string, stack?: string }} error
   */
  async systemError(error) {
    const { component, message, stack } = error;
    const title = `❌ ${component}: ${message}`;
    const stackSnippet = stack ? stack.split('\n').slice(0, 3).join('\n') : '';

    await this.send({
      severity: 'critical',
      type: 'system_error',
      title,
      telegramText: `❌ *System Error*\nComponent: ${escMd(component)}\n${escMd(message)}${stackSnippet ? `\n\`\`\`\n${escMd(stackSnippet)}\n\`\`\`` : ''}`,
      discordEmbed: {
        title: `❌ System Error — ${component}`,
        description: `\`\`\`\n${message}\n${stackSnippet}\n\`\`\``,
        color: DISCORD_COLORS.critical,
        fields: [
          { name: 'Component', value: component, inline: true },
        ],
      },
      webhookPayload: { event: 'system_error', ...error, ts: new Date().toISOString() },
    });
  }

  /**
   * Heartbeat status alert (periodic health ping).
   * @param {{ beatNumber: number, phase: string, positions: Array<{symbol: string, pnl?: number}> }} status
   */
  async heartbeatStatus(status) {
    const { beatNumber, phase, positions = [] } = status;
    const posText = positions.length > 0
      ? positions.map((p) => `${p.symbol}${p.pnl != null ? ` ${usd(p.pnl)}` : ''}`).join(', ')
      : 'None';
    const title = `💓 Beat #${beatNumber} | ${phase}`;

    await this.send({
      severity: 'info',
      type: 'heartbeat',
      title,
      telegramText: `💓 *Beat \\#${escMd(String(beatNumber))}* \\| ${escMd(phase)}\nPositions: ${escMd(posText)}`,
      discordEmbed: {
        title,
        description: `Positions: ${posText}`,
        color: DISCORD_COLORS.info,
      },
      webhookPayload: { event: 'heartbeat', ...status, ts: new Date().toISOString() },
    });
  }

  /**
   * End-of-day summary.
   * @param {{ trades: number, pnl: number, winRate: number, positions: Array<{symbol: string, qty: number, unrealizedPnl?: number}> }} summary
   */
  async dailySummary(summary) {
    const { trades, pnl, winRate, positions = [] } = summary;
    const posLines = positions.length > 0
      ? positions.map((p) => `  • ${p.symbol} ×${p.qty}${p.unrealizedPnl != null ? ` (${usd(p.unrealizedPnl)})` : ''}`).join('\n')
      : '  None';

    const title = `📊 Daily Summary | ${trades} trades | ${usd(pnl)}`;
    const desc = [
      `Trades: ${trades}`,
      `P&L: ${usd(pnl)}`,
      `Win Rate: ${(winRate * 100).toFixed(1)}%`,
      `Open Positions:\n${posLines}`,
    ].join('\n');

    await this.send({
      severity: 'info',
      type: 'daily_summary',
      title,
      telegramText: `📊 *Daily Summary*\nTrades: ${escMd(String(trades))}\nP&L: ${escMd(usd(pnl))}\nWin Rate: ${escMd((winRate * 100).toFixed(1))}%\n\n*Open Positions:*\n${escMd(posLines)}`,
      discordEmbed: {
        title,
        description: `\`\`\`\n${desc}\n\`\`\``,
        color: pnl >= 0 ? DISCORD_COLORS.profit : DISCORD_COLORS.loss,
        fields: [
          { name: 'Trades', value: String(trades), inline: true },
          { name: 'P&L', value: usd(pnl), inline: true },
          { name: 'Win Rate', value: `${(winRate * 100).toFixed(1)}%`, inline: true },
        ],
      },
      webhookPayload: { event: 'daily_summary', ...summary, ts: new Date().toISOString() },
    });
  }

  // ── Custom Alert (from MCP tool) ─────────────────────────────────────────

  /**
   * Send a custom alert from the AI agent.
   * @param {string} message
   * @param {'info'|'warning'|'critical'} severity
   */
  async custom(message, severity = 'info') {
    const emojiMap = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
    const colorMap = { info: DISCORD_COLORS.info, warning: DISCORD_COLORS.warning, critical: DISCORD_COLORS.critical };
    const emoji = emojiMap[severity] || 'ℹ️';
    const title = `${emoji} ${message.slice(0, 80)}`;

    await this.send({
      severity,
      type: 'custom',
      title,
      telegramText: `${emoji} *${escMd(severity.toUpperCase())}*\n${escMd(message)}`,
      discordEmbed: {
        title: `${emoji} Agent Alert`,
        description: message,
        color: colorMap[severity] || DISCORD_COLORS.neutral,
      },
      webhookPayload: { event: 'custom_alert', message, severity, ts: new Date().toISOString() },
    });
  }

  // ── Health Check ─────────────────────────────────────────────────────────

  /**
   * Test all enabled channels and report results.
   * @returns {Promise<ChannelResult[]>}
   */
  async testConnections() {
    const channels = this._enabledChannels();
    if (channels.length === 0) {
      log('WARN', 'No alert channels enabled');
      return [];
    }

    const testAlert = {
      severity: 'info',
      type: 'connection_test',
      title: '✅ OpenProphet Alerts Connected',
      telegramText: '✅ *OpenProphet Alerts Connected*\nThis channel is receiving trade alerts\\.',
      discordEmbed: {
        title: '✅ OpenProphet Alerts Connected',
        description: 'This channel is receiving trade alerts.',
        color: DISCORD_COLORS.info,
      },
      webhookPayload: { event: 'connection_test', ts: new Date().toISOString() },
    };

    const results = await Promise.allSettled(
      channels.map((ch) => this._sendToChannel(ch, testAlert)),
    );

    /** @type {ChannelResult[]} */
    const out = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        out.push(results[i].value);
        log('INFO', `Channel test passed`, { channel: channels[i] });
      } else {
        const err = results[i].reason?.message || String(results[i].reason);
        out.push({ channel: channels[i], ok: false, error: err });
        log('ERROR', `Channel test failed`, { channel: channels[i], error: err });
      }
    }
    return out;
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  /** @returns {{ sent: number, failed: number, dropped: number, queued: number }} */
  getStats() {
    return { ...this._stats, queued: this._queue.length };
  }

  /** Flush pending queue (best-effort, for graceful shutdown). */
  async flush() {
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
    // Force-drain remaining items
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      await this._deliver(item);
    }
  }
}

// ─── Factory: Create from Environment ────────────────────────────────────────

/**
 * Parse boolean from env var string. Defaults to `true` if undefined/empty.
 * @param {string|undefined} value
 * @param {boolean} [defaultVal=true]
 * @returns {boolean}
 */
function parseBool(value, defaultVal = true) {
  if (value === undefined || value === '') return defaultVal;
  return !['false', '0', 'no'].includes(value.toLowerCase());
}

/**
 * Create an AlertService from process.env variables.
 * @returns {AlertService}
 */
function createAlertService() {
  const enabled = parseBool(process.env.ALERTS_ENABLED, true);

  const telegram = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
    ? {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
        enabled: true,
      }
    : null;

  const discord = process.env.DISCORD_WEBHOOK_URL
    ? {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        enabled: true,
      }
    : null;

  const webhook = process.env.ALERT_WEBHOOK_URL && process.env.ALERT_WEBHOOK_SECRET
    ? {
        url: process.env.ALERT_WEBHOOK_URL,
        secret: process.env.ALERT_WEBHOOK_SECRET,
        enabled: true,
      }
    : null;

  const service = new AlertService({ enabled, telegram, discord, webhook });

  const channelNames = [];
  if (telegram) channelNames.push('telegram');
  if (discord) channelNames.push('discord');
  if (webhook) channelNames.push('webhook');

  log('INFO', `AlertService initialized`, {
    enabled,
    channels: channelNames,
  });

  return service;
}

// ─── MCP Tool Definition ─────────────────────────────────────────────────────

/**
 * Returns the MCP tool schema for a `send_alert` tool.
 * Register this in the tools array of mcp-server.js.
 * @returns {{ name: string, description: string, inputSchema: object }}
 */
function getAlertToolDefinition() {
  return {
    name: 'send_alert',
    description:
      'Send a custom alert/notification to all configured channels (Telegram, Discord, webhook). ' +
      'Use for trade commentary, market observations, risk warnings, or any message the operator should see immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The alert message to send. Keep it concise and actionable.',
        },
        severity: {
          type: 'string',
          enum: ['info', 'warning', 'critical'],
          description: 'Alert severity level. info=routine, warning=needs attention, critical=immediate action.',
        },
      },
      required: ['message'],
    },
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export { AlertService, createAlertService, getAlertToolDefinition };
export default AlertService;
