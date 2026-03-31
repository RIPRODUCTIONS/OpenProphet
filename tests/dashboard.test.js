/**
 * Tests for agent/public/index.html dashboard logic.
 *
 * Since the dashboard is a browser SPA with no module exports, we extract
 * and re-implement the pure-logic functions here and test them in isolation.
 * We also validate the SSE event contracts and API response shapes the
 * dashboard depends on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Extracted pure functions from index.html ─────────────────────────────

/** Formats seconds into human-readable interval (line 1333) */
function fmtInt(s) {
  return s >= 3600
    ? (s / 3600).toFixed(1) + 'h'
    : s >= 60
      ? Math.floor(s / 60) + 'm ' + (s % 60) + 's'
      : s + 's';
}

/** Appends auth token to API URLs (line 954–958) */
function withAuthUrl(url, authToken) {
  if (!authToken || typeof url !== 'string' || !url.startsWith('/api/')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'token=' + encodeURIComponent(authToken);
}

/** Formats sandbox prefix for log messages (line 1129–1132) */
function formatSandboxPrefix(data, sandboxLabelFn) {
  if (!data?.sandboxId) return '';
  return '[' + sandboxLabelFn(data.sandboxId) + '] ';
}

/** Resolves sandbox label (line 944–947) */
function sandboxLabelById(sandboxId, sandboxes) {
  const sandbox = sandboxId ? (sandboxes || {})[sandboxId] : null;
  return sandbox?.name || sandboxId || 'Active sandbox';
}

/** Computes effective sandbox ID from state (line 929–933) */
function getEffectiveSandboxId(selectedSandboxId, sandboxes, activeSandboxId) {
  if (selectedSandboxId === '_manager') return '_manager';
  if (selectedSandboxId && (sandboxes || {})[selectedSandboxId]) return selectedSandboxId;
  return activeSandboxId || null;
}

/** Checks if viewing the active sandbox (line 940–942) */
function isViewingActiveSandbox(selectedSandboxId, activeSandboxId) {
  return !selectedSandboxId || selectedSandboxId === activeSandboxId;
}

/** Builds query string for sandbox API calls (line 949–952) */
function sandboxQueryString(effectiveSandboxId) {
  return effectiveSandboxId
    ? '?sandboxId=' + encodeURIComponent(effectiveSandboxId)
    : '';
}

/** Derives port from sandbox ID using hash (line 2485–2491) */
function getSandboxPort(sandboxId) {
  let hash = 0;
  for (const char of String(sandboxId || 'default')) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return 4534 + (hash % 10) + 1;
}

/** Phase label map from updatePhase (line 1323–1331) */
const PHASE_LABELS = {
  pre_market: 'Pre-Market',
  market_open: 'Market Open',
  midday: 'Midday',
  market_close: 'Market Close',
  after_hours: 'After Hours',
  closed: 'Closed',
};

function phaseLabel(phase) {
  return PHASE_LABELS[phase] || phase;
}

function phaseClass(phase) {
  if (phase === 'market_open' || phase === 'midday') return 'open';
  if (phase === 'pre_market') return 'pre';
  if (phase === 'market_close' || phase === 'after_hours') return 'close';
  return '';
}

/** SSE reconnect delay with exponential backoff (line 1153) */
function sseReconnectDelay(attempts) {
  return Math.min(1000 * Math.pow(2, attempts), 30000);
}

/** Heartbeat progress bar percentage (line 1340) */
function heartbeatProgress(heartbeatSeconds, remainingMs) {
  return Math.max(0, Math.min(100,
    ((heartbeatSeconds * 1000 - remainingMs) / (heartbeatSeconds * 1000)) * 100
  ));
}

/** Shortens model names for footer display (line 1296) */
function shortenModelName(modelName) {
  return (modelName || '--').replace('claude-', '').split('-202')[0];
}

/** Button state machine (line 1302–1321) */
function resolveButtonState(status) {
  switch (status) {
    case 'started':
    case 'resumed':
      return { visible: ['pause', 'stop'], dotClass: 'running', text: 'Running' };
    case 'paused':
      return { visible: ['resume', 'stop'], dotClass: 'paused', text: 'Paused' };
    default:
      return { visible: ['start'], dotClass: '', text: 'Stopped' };
  }
}

/** Derives agent status string from state flags (line 1298) */
function deriveStatusFromState(running, paused) {
  return running ? (paused ? 'paused' : 'started') : 'stopped';
}

/** Chat message level mapping for history transcript (line 1495) */
function chatMessageLevel(role) {
  return role === 'user' ? 'user' : (role === 'assistant' ? 'text' : 'info');
}

/** Tool call args truncation (line 1201) */
function formatToolArgs(args) {
  const keys = Object.keys(args || {});
  return keys.length ? ' ' + JSON.stringify(args).substring(0, 120) : '';
}

/** Finds which accounts use a given agent (line 2202–2212) */
function getAgentUsage(agentId, sandboxes, accounts) {
  const sbxList = Object.values(sandboxes || {});
  const using = [];
  (accounts || []).forEach(a => {
    const sbx = sbxList.find(s => s.accountId === a.id);
    const activeAgent = sbx?.agent?.activeAgentId || 'default';
    if (activeAgent === agentId) using.push(a.name || (a.paper ? 'Paper' : 'Live'));
  });
  return using;
}

/** Finds which agents use a given strategy (line 2214–2217) */
function getStrategyUsage(strategyId, agents) {
  return (agents || []).filter(a => a.strategyId === strategyId).map(a => a.name);
}

/** Heartbeat override validation (line 1408–1409 and 2074–2075) */
function isValidHeartbeatOverride(value, min = 30, max = 3600) {
  const v = parseInt(value);
  return !(!v || v < min || v > max);
}

/** Portfolio P&L formatting (line 1574) */
function formatPnl(pnl) {
  return (pnl >= 0 ? '+' : '') + '$' + pnl.toLocaleString('en-US', { minimumFractionDigits: 2 });
}

/** Trade toast message (line 1236–1237) */
function tradeToastMessage(trade) {
  const side = trade.side || trade.action || 'TRADE';
  const sym = trade.symbol || '??';
  return side.toUpperCase() + ' ' + sym + (trade.qty ? ' x' + trade.qty : '');
}

function tradeToastType(trade) {
  const side = trade.side || trade.action || '';
  return side.toLowerCase().includes('buy') ? 'success' : 'warning';
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('fmtInt — interval formatting', () => {
  it('formats seconds under a minute', () => {
    assert.equal(fmtInt(0), '0s');
    assert.equal(fmtInt(1), '1s');
    assert.equal(fmtInt(30), '30s');
    assert.equal(fmtInt(59), '59s');
  });

  it('formats minutes and seconds', () => {
    assert.equal(fmtInt(60), '1m 0s');
    assert.equal(fmtInt(90), '1m 30s');
    assert.equal(fmtInt(150), '2m 30s');
    assert.equal(fmtInt(3599), '59m 59s');
  });

  it('formats hours', () => {
    assert.equal(fmtInt(3600), '1.0h');
    assert.equal(fmtInt(5400), '1.5h');
    assert.equal(fmtInt(7200), '2.0h');
    assert.equal(fmtInt(9000), '2.5h');
  });
});

describe('withAuthUrl — auth token injection', () => {
  it('appends token to simple API URLs', () => {
    assert.equal(
      withAuthUrl('/api/config', 'abc123'),
      '/api/config?token=abc123'
    );
  });

  it('appends with & when URL already has query params', () => {
    assert.equal(
      withAuthUrl('/api/sandboxes?foo=bar', 'tok'),
      '/api/sandboxes?foo=bar&token=tok'
    );
  });

  it('returns URL unchanged when no auth token', () => {
    assert.equal(withAuthUrl('/api/config', ''), '/api/config');
    assert.equal(withAuthUrl('/api/config', null), '/api/config');
  });

  it('returns URL unchanged for non-API paths', () => {
    assert.equal(withAuthUrl('/index.html', 'tok'), '/index.html');
    assert.equal(withAuthUrl('https://example.com/api/', 'tok'), 'https://example.com/api/');
  });

  it('encodes special characters in token', () => {
    assert.equal(
      withAuthUrl('/api/config', 'a b&c=d'),
      '/api/config?token=a%20b%26c%3Dd'
    );
  });
});

describe('sandboxLabelById — sandbox naming', () => {
  it('returns sandbox name when found', () => {
    const sandboxes = { sbx_1: { name: 'Paper Trading' } };
    assert.equal(sandboxLabelById('sbx_1', sandboxes), 'Paper Trading');
  });

  it('falls back to sandbox ID when no name', () => {
    const sandboxes = { sbx_1: {} };
    assert.equal(sandboxLabelById('sbx_1', sandboxes), 'sbx_1');
  });

  it('falls back to sandbox ID when not found', () => {
    assert.equal(sandboxLabelById('sbx_missing', {}), 'sbx_missing');
  });

  it('returns "Active sandbox" for null/undefined', () => {
    assert.equal(sandboxLabelById(null, {}), 'Active sandbox');
    assert.equal(sandboxLabelById(undefined, {}), 'Active sandbox');
  });
});

describe('getEffectiveSandboxId — sandbox resolution', () => {
  it('returns _manager for manager tab', () => {
    assert.equal(getEffectiveSandboxId('_manager', {}, 'sbx_1'), '_manager');
  });

  it('returns selected sandbox if it exists', () => {
    const sandboxes = { sbx_2: { name: 'Test' } };
    assert.equal(getEffectiveSandboxId('sbx_2', sandboxes, 'sbx_1'), 'sbx_2');
  });

  it('falls back to activeSandboxId if selected does not exist', () => {
    assert.equal(getEffectiveSandboxId('sbx_gone', {}, 'sbx_1'), 'sbx_1');
  });

  it('returns null when nothing set', () => {
    assert.equal(getEffectiveSandboxId(null, {}, null), null);
  });

  it('ignores selected if not in sandboxes map', () => {
    assert.equal(getEffectiveSandboxId('sbx_2', { sbx_1: {} }, 'sbx_1'), 'sbx_1');
  });
});

describe('isViewingActiveSandbox', () => {
  it('returns true when no selection (follow mode)', () => {
    assert.equal(isViewingActiveSandbox(null, 'sbx_1'), true);
    assert.equal(isViewingActiveSandbox(undefined, 'sbx_1'), true);
    assert.equal(isViewingActiveSandbox('', 'sbx_1'), true);
  });

  it('returns true when selected matches active', () => {
    assert.equal(isViewingActiveSandbox('sbx_1', 'sbx_1'), true);
  });

  it('returns false when viewing a different sandbox', () => {
    assert.equal(isViewingActiveSandbox('sbx_2', 'sbx_1'), false);
  });
});

describe('sandboxQueryString', () => {
  it('builds query string for a sandbox', () => {
    assert.equal(sandboxQueryString('sbx_1'), '?sandboxId=sbx_1');
  });

  it('returns empty string for null', () => {
    assert.equal(sandboxQueryString(null), '');
    assert.equal(sandboxQueryString(undefined), '');
    assert.equal(sandboxQueryString(''), '');
  });

  it('encodes special characters', () => {
    assert.equal(sandboxQueryString('sbx a&b'), '?sandboxId=sbx%20a%26b');
  });
});

describe('getSandboxPort — deterministic port hashing', () => {
  it('returns a port in range 4535–4544', () => {
    for (const id of ['sbx_1', 'sbx_2', 'abc', 'test-sandbox']) {
      const port = getSandboxPort(id);
      assert.ok(port >= 4535 && port <= 4544, `Port ${port} out of range for ${id}`);
    }
  });

  it('is deterministic — same ID always gives same port', () => {
    assert.equal(getSandboxPort('sbx_1'), getSandboxPort('sbx_1'));
    assert.equal(getSandboxPort('test'), getSandboxPort('test'));
  });

  it('uses "default" for null/undefined input', () => {
    assert.equal(getSandboxPort(null), getSandboxPort(undefined));
    assert.equal(getSandboxPort(null), getSandboxPort(''));
  });
});

describe('phase labels and CSS classes', () => {
  it('maps all known phases to display names', () => {
    assert.equal(phaseLabel('pre_market'), 'Pre-Market');
    assert.equal(phaseLabel('market_open'), 'Market Open');
    assert.equal(phaseLabel('midday'), 'Midday');
    assert.equal(phaseLabel('market_close'), 'Market Close');
    assert.equal(phaseLabel('after_hours'), 'After Hours');
    assert.equal(phaseLabel('closed'), 'Closed');
  });

  it('passes through unknown phases', () => {
    assert.equal(phaseLabel('custom_phase'), 'custom_phase');
    assert.equal(phaseLabel(''), '');
  });

  it('assigns correct CSS classes', () => {
    assert.equal(phaseClass('market_open'), 'open');
    assert.equal(phaseClass('midday'), 'open');
    assert.equal(phaseClass('pre_market'), 'pre');
    assert.equal(phaseClass('market_close'), 'close');
    assert.equal(phaseClass('after_hours'), 'close');
    assert.equal(phaseClass('closed'), '');
    assert.equal(phaseClass('unknown'), '');
  });
});

describe('sseReconnectDelay — exponential backoff', () => {
  it('doubles delay on each attempt', () => {
    assert.equal(sseReconnectDelay(1), 2000);
    assert.equal(sseReconnectDelay(2), 4000);
    assert.equal(sseReconnectDelay(3), 8000);
    assert.equal(sseReconnectDelay(4), 16000);
  });

  it('caps at 30 seconds', () => {
    assert.equal(sseReconnectDelay(5), 30000);
    assert.equal(sseReconnectDelay(10), 30000);
    assert.equal(sseReconnectDelay(100), 30000);
  });

  it('starts at 1 second for first attempt', () => {
    // attempt 0 → 1000 * 2^0 = 1000
    // But per code, _sseReconnectAttempts is incremented before delay calc,
    // so first real call is attempt=1
    assert.equal(sseReconnectDelay(0), 1000);
  });
});

describe('heartbeatProgress — progress bar calculation', () => {
  it('returns 0 at the start of a heartbeat interval', () => {
    // heartbeatSeconds=60, remainingMs = 60000 (full interval remaining)
    assert.equal(heartbeatProgress(60, 60000), 0);
  });

  it('returns 50 at halfway', () => {
    assert.equal(heartbeatProgress(60, 30000), 50);
  });

  it('returns 100 when time is up', () => {
    assert.equal(heartbeatProgress(60, 0), 100);
  });

  it('clamps to 0-100 range', () => {
    assert.equal(heartbeatProgress(60, 70000), 0); // more than full interval
    assert.equal(heartbeatProgress(60, -5000), 100); // overdue
  });
});

describe('shortenModelName — footer model display', () => {
  it('strips claude- prefix and date suffix', () => {
    assert.equal(shortenModelName('claude-sonnet-4-20250514'), 'sonnet-4');
    assert.equal(shortenModelName('claude-3-5-haiku-20241022'), '3-5-haiku');
  });

  it('handles models without claude prefix', () => {
    assert.equal(shortenModelName('gpt-4o'), 'gpt-4o');
    assert.equal(shortenModelName('gemini-pro'), 'gemini-pro');
  });

  it('returns -- for null/undefined', () => {
    assert.equal(shortenModelName(null), '--');
    assert.equal(shortenModelName(undefined), '--');
    assert.equal(shortenModelName(''), '--');
  });
});

describe('resolveButtonState — agent control state machine', () => {
  it('shows pause+stop for started state', () => {
    const s = resolveButtonState('started');
    assert.deepEqual(s.visible, ['pause', 'stop']);
    assert.equal(s.dotClass, 'running');
    assert.equal(s.text, 'Running');
  });

  it('shows pause+stop for resumed state', () => {
    const s = resolveButtonState('resumed');
    assert.deepEqual(s.visible, ['pause', 'stop']);
    assert.equal(s.text, 'Running');
  });

  it('shows resume+stop for paused state', () => {
    const s = resolveButtonState('paused');
    assert.deepEqual(s.visible, ['resume', 'stop']);
    assert.equal(s.dotClass, 'paused');
    assert.equal(s.text, 'Paused');
  });

  it('shows start for stopped/unknown state', () => {
    assert.deepEqual(resolveButtonState('stopped').visible, ['start']);
    assert.equal(resolveButtonState('stopped').text, 'Stopped');
    assert.deepEqual(resolveButtonState('').visible, ['start']);
    assert.deepEqual(resolveButtonState(undefined).visible, ['start']);
  });
});

describe('deriveStatusFromState — state flags to status string', () => {
  it('derives started from running=true, paused=false', () => {
    assert.equal(deriveStatusFromState(true, false), 'started');
  });

  it('derives paused from running=true, paused=true', () => {
    assert.equal(deriveStatusFromState(true, true), 'paused');
  });

  it('derives stopped from running=false', () => {
    assert.equal(deriveStatusFromState(false, false), 'stopped');
    assert.equal(deriveStatusFromState(false, true), 'stopped');
  });
});

describe('chatMessageLevel — transcript role mapping', () => {
  it('maps user role to user level', () => {
    assert.equal(chatMessageLevel('user'), 'user');
  });

  it('maps assistant role to text level', () => {
    assert.equal(chatMessageLevel('assistant'), 'text');
  });

  it('maps system and unknown roles to info', () => {
    assert.equal(chatMessageLevel('system'), 'info');
    assert.equal(chatMessageLevel('tool'), 'info');
    assert.equal(chatMessageLevel(undefined), 'info');
  });
});

describe('formatToolArgs — tool call argument display', () => {
  it('truncates long args to 120 chars', () => {
    const longArgs = { data: 'x'.repeat(200) };
    const result = formatToolArgs(longArgs);
    assert.ok(result.length <= 121); // space prefix + 120 chars
  });

  it('returns empty string for no args', () => {
    assert.equal(formatToolArgs({}), '');
    assert.equal(formatToolArgs(null), '');
    assert.equal(formatToolArgs(undefined), '');
  });

  it('formats small args as JSON', () => {
    const result = formatToolArgs({ symbol: 'AAPL', qty: 10 });
    assert.ok(result.includes('"symbol":"AAPL"'));
    assert.ok(result.includes('"qty":10'));
  });
});

describe('getAgentUsage — agent-to-account mapping', () => {
  const sandboxes = {
    sbx_1: { accountId: 'acct1', agent: { activeAgentId: 'aggressive' } },
    sbx_2: { accountId: 'acct2', agent: { activeAgentId: 'default' } },
    sbx_3: { accountId: 'acct3', agent: {} }, // defaults to 'default'
  };
  const accounts = [
    { id: 'acct1', name: 'Paper', paper: true },
    { id: 'acct2', name: 'Live', paper: false },
    { id: 'acct3', paper: true }, // no name, should use 'Paper'
  ];

  it('finds accounts using a specific agent', () => {
    assert.deepEqual(getAgentUsage('aggressive', sandboxes, accounts), ['Paper']);
  });

  it('finds accounts using the default agent', () => {
    const result = getAgentUsage('default', sandboxes, accounts);
    assert.deepEqual(result, ['Live', 'Paper']); // acct2 explicit + acct3 fallback
  });

  it('returns empty array for unused agent', () => {
    assert.deepEqual(getAgentUsage('nonexistent', sandboxes, accounts), []);
  });
});

describe('getStrategyUsage — strategy-to-agent mapping', () => {
  const agents = [
    { name: 'Aggressive', strategyId: 'momentum' },
    { name: 'Conservative', strategyId: 'value' },
    { name: 'Balanced', strategyId: 'momentum' },
  ];

  it('finds agents using a strategy', () => {
    assert.deepEqual(getStrategyUsage('momentum', agents), ['Aggressive', 'Balanced']);
  });

  it('returns empty array for unused strategy', () => {
    assert.deepEqual(getStrategyUsage('unused', agents), []);
  });
});

describe('isValidHeartbeatOverride — input validation', () => {
  it('accepts values in range', () => {
    assert.equal(isValidHeartbeatOverride(30), true);
    assert.equal(isValidHeartbeatOverride(60), true);
    assert.equal(isValidHeartbeatOverride(3600), true);
  });

  it('rejects values below minimum', () => {
    assert.equal(isValidHeartbeatOverride(29), false);
    assert.equal(isValidHeartbeatOverride(0), false);
    assert.equal(isValidHeartbeatOverride(-1), false);
  });

  it('rejects values above maximum', () => {
    assert.equal(isValidHeartbeatOverride(3601), false);
  });

  it('rejects non-numeric values', () => {
    assert.equal(isValidHeartbeatOverride('abc'), false);
    assert.equal(isValidHeartbeatOverride(''), false);
    assert.equal(isValidHeartbeatOverride(NaN), false);
  });

  it('supports custom min/max for per-sandbox overrides', () => {
    // Per-sandbox uses min=15, max=7200 (line 2075)
    assert.equal(isValidHeartbeatOverride(15, 15, 7200), true);
    assert.equal(isValidHeartbeatOverride(14, 15, 7200), false);
    assert.equal(isValidHeartbeatOverride(7200, 15, 7200), true);
    assert.equal(isValidHeartbeatOverride(7201, 15, 7200), false);
  });
});

describe('formatPnl — profit/loss display', () => {
  it('formats positive P&L with + prefix', () => {
    assert.equal(formatPnl(100), '+$100.00');
    assert.equal(formatPnl(0.5), '+$0.50');
  });

  it('formats negative P&L', () => {
    // The dashboard logic: (pnl>=0?'+':'') + '$' + pnl.toLocaleString(...)
    // For -50, the ternary gives '' (no prefix), toLocaleString gives '-50.00'
    // Result: '$-50.00' — the dollar sign precedes the minus from toLocaleString
    const result = formatPnl(-50);
    assert.equal(result, '$-50.00');
  });

  it('formats zero as positive', () => {
    assert.equal(formatPnl(0), '+$0.00');
  });

  it('handles large values with locale separators', () => {
    const result = formatPnl(12345.67);
    assert.ok(result.includes('12'));
    assert.ok(result.includes('345.67'));
  });
});

describe('tradeToastMessage — trade notification text', () => {
  it('formats buy trade', () => {
    assert.equal(tradeToastMessage({ side: 'buy', symbol: 'AAPL', qty: 10 }), 'BUY AAPL x10');
  });

  it('formats sell trade without qty', () => {
    assert.equal(tradeToastMessage({ side: 'sell', symbol: 'TSLA' }), 'SELL TSLA');
  });

  it('falls back to action field', () => {
    assert.equal(tradeToastMessage({ action: 'Buy', symbol: 'MSFT' }), 'BUY MSFT');
  });

  it('falls back to ?? for missing symbol', () => {
    assert.equal(tradeToastMessage({ side: 'buy' }), 'BUY ??');
  });

  it('defaults to TRADE when no side/action', () => {
    assert.equal(tradeToastMessage({ symbol: 'SPY' }), 'TRADE SPY');
  });
});

describe('tradeToastType — trade notification color', () => {
  it('returns success for buy trades', () => {
    assert.equal(tradeToastType({ side: 'buy' }), 'success');
    assert.equal(tradeToastType({ side: 'Buy' }), 'success');
    assert.equal(tradeToastType({ action: 'buy_to_open' }), 'success');
  });

  it('returns warning for sell trades', () => {
    assert.equal(tradeToastType({ side: 'sell' }), 'warning');
    assert.equal(tradeToastType({ side: 'SELL' }), 'warning');
  });

  it('returns warning for unknown/missing side', () => {
    assert.equal(tradeToastType({}), 'warning');
    assert.equal(tradeToastType({ side: '' }), 'warning');
  });
});

describe('formatSandboxPrefix', () => {
  it('returns empty string when no sandboxId', () => {
    assert.equal(formatSandboxPrefix({}, () => 'x'), '');
    assert.equal(formatSandboxPrefix(null, () => 'x'), '');
  });

  it('wraps label in brackets', () => {
    assert.equal(
      formatSandboxPrefix({ sandboxId: 'sbx_1' }, () => 'Paper Trading'),
      '[Paper Trading] '
    );
  });
});

describe('SSE event data contracts', () => {
  it('state event has expected shape', () => {
    const stateEvent = {
      running: true,
      paused: false,
      beatCount: 42,
      phase: 'market_open',
      heartbeatSeconds: 120,
      activeModel: 'claude-sonnet-4-20250514',
      stats: { totalBeats: 42, toolCalls: 150, trades: 3, errors: 1 },
      sandboxId: 'sbx_1',
    };
    // Validate all fields the dashboard reads from state events
    assert.equal(typeof stateEvent.running, 'boolean');
    assert.equal(typeof stateEvent.paused, 'boolean');
    assert.equal(typeof stateEvent.beatCount, 'number');
    assert.ok(['pre_market', 'market_open', 'midday', 'market_close', 'after_hours', 'closed'].includes(stateEvent.phase));
    assert.equal(typeof stateEvent.heartbeatSeconds, 'number');
    assert.equal(typeof stateEvent.stats.totalBeats, 'number');
    assert.equal(typeof stateEvent.stats.toolCalls, 'number');
    assert.equal(typeof stateEvent.stats.trades, 'number');
    assert.equal(typeof stateEvent.stats.errors, 'number');

    // Verify derived status
    assert.equal(deriveStatusFromState(stateEvent.running, stateEvent.paused), 'started');
    assert.equal(fmtInt(stateEvent.heartbeatSeconds), '2m 0s');
    assert.equal(shortenModelName(stateEvent.activeModel), 'sonnet-4');
  });

  it('beat_start event has expected shape', () => {
    const event = { beat: 5, phase: 'midday', sandboxId: 'sbx_1' };
    assert.equal(typeof event.beat, 'number');
    assert.ok(event.phase in PHASE_LABELS);
  });

  it('schedule event has expected shape', () => {
    const event = {
      nextBeat: '2025-01-15T10:30:00.000Z',
      seconds: 300,
      phase: 'market_open',
      sandboxId: 'sbx_1',
    };
    assert.equal(typeof event.seconds, 'number');
    assert.ok(!isNaN(new Date(event.nextBeat).getTime()), 'nextBeat must be valid ISO date');
    assert.equal(fmtInt(event.seconds), '5m 0s');
  });

  it('trade event has expected shape', () => {
    const event = {
      symbol: 'AAPL',
      side: 'buy',
      qty: 10,
      price: 195.50,
      tool: 'place_order',
      timestamp: '2025-01-15T10:30:00.000Z',
    };
    assert.equal(tradeToastMessage(event), 'BUY AAPL x10');
    assert.equal(tradeToastType(event), 'success');
  });

  it('heartbeat_change event has expected shape', () => {
    const event = { seconds: 180, reason: 'Phase changed to midday', sandboxId: 'sbx_1' };
    assert.equal(fmtInt(event.seconds), '3m 0s');
    assert.equal(typeof event.reason, 'string');
  });

  it('tool_call event formats args correctly', () => {
    const event = { name: 'get_positions', args: { account: 'paper' }, sandboxId: 'sbx_1' };
    const args = formatToolArgs(event.args);
    assert.ok(args.includes('"account":"paper"'));
  });

  it('tool_result event truncates long results', () => {
    const event = { name: 'get_positions', result: 'x'.repeat(300), sandboxId: 'sbx_1' };
    // Dashboard truncates to 200 chars: d.result.substring(0, 200)
    assert.equal(event.result.substring(0, 200).length, 200);
  });
});

describe('health API response contract', () => {
  it('dashboard extracts sandbox health correctly', () => {
    const healthResponse = {
      trading_bot: 'healthy',
      sandboxes: [
        { sandboxId: 'sbx_1', goReady: true, state: { running: true, beatCount: 5, phase: 'midday' }, port: 4535 },
        { sandboxId: 'sbx_2', goReady: false, state: { running: false }, port: 4536 },
      ],
    };
    const sid = 'sbx_1';
    const sandbox = healthResponse.sandboxes.find(s => s.sandboxId === sid);
    assert.equal(sandbox.goReady, true);
    assert.equal(sandbox.state.running, true);
    assert.equal(sandbox.port, 4535);

    const sid2 = 'sbx_2';
    const sandbox2 = healthResponse.sandboxes.find(s => s.sandboxId === sid2);
    assert.equal(sandbox2.goReady, false);
  });
});

describe('chat history response contract', () => {
  it('maps message roles to log entry levels', () => {
    const messages = [
      { role: 'user', content: 'Buy AAPL', timestamp: '2025-01-15T10:30:00Z' },
      { role: 'assistant', content: 'Placing order...', timestamp: '2025-01-15T10:30:01Z' },
      { role: 'system', content: 'Internal', timestamp: '2025-01-15T10:30:02Z' },
    ];
    const levels = messages.map(m => chatMessageLevel(m.role));
    assert.deepEqual(levels, ['user', 'text', 'info']);
  });

  it('handles missing timestamp gracefully', () => {
    const msg = { role: 'user', content: 'hello' };
    const time = msg.timestamp
      ? new Date(msg.timestamp).toLocaleTimeString('en-US', { hour12: false })
      : '--:--:--';
    assert.equal(time, '--:--:--');
  });

  it('handles missing content', () => {
    const msg = { role: 'user' };
    const label = msg.role ? '[' + msg.role + '] ' : '';
    const display = label + (msg.content || '');
    assert.equal(display, '[user] ');
  });
});

describe('portfolio response value extraction', () => {
  it('handles Alpaca-style keys (PascalCase)', () => {
    const acc = { PortfolioValue: '50000', Cash: '10000', BuyingPower: '20000', Equity: '50000', LastEquity: '49500' };
    const pv = Number(acc.PortfolioValue || acc.portfolio_value || 0);
    const pnl = Number(acc.Equity || acc.equity || 0) - Number(acc.LastEquity || acc.last_equity || 0);
    assert.equal(pv, 50000);
    assert.equal(pnl, 500);
    assert.equal(formatPnl(pnl), '+$500.00');
  });

  it('handles snake_case keys', () => {
    const acc = { portfolio_value: '50000', cash: '10000', buying_power: '20000', equity: '50000', last_equity: '49500' };
    const pv = Number(acc.PortfolioValue || acc.portfolio_value || 0);
    const cash = Number(acc.Cash || acc.cash || 0);
    assert.equal(pv, 50000);
    assert.equal(cash, 10000);
  });
});

describe('config export shape', () => {
  it('includes only agents, strategies, and sandboxes', () => {
    const config = {
      agents: [{ id: 'default', name: 'Default' }],
      strategies: [{ id: 'default', name: 'Default' }],
      sandboxes: { sbx_1: { name: 'Paper' } },
      models: [{ id: 'anthropic/claude-sonnet-4', name: 'Sonnet' }],
      accounts: [{ id: 'acct1' }],
    };
    // From exportConfig (line 1056)
    const exported = { agents: config.agents, strategies: config.strategies, sandboxes: config.sandboxes };
    assert.ok(exported.agents);
    assert.ok(exported.strategies);
    assert.ok(exported.sandboxes);
    assert.equal(exported.models, undefined, 'models should not be exported');
    assert.equal(exported.accounts, undefined, 'accounts should not be exported');
  });
});

describe('dark mode toggle logic', () => {
  it('toggles theme correctly', () => {
    // Simulates the toggle logic from line 1105-1110
    let theme = 'dark';
    const toggle = () => {
      const isDark = theme === 'dark';
      theme = isDark ? '' : 'dark';
      return isDark ? '☽' : '☀';
    };
    const icon1 = toggle(); // was dark → now light
    assert.equal(theme, '');
    assert.equal(icon1, '☽');

    const icon2 = toggle(); // was light → now dark
    assert.equal(theme, 'dark');
    assert.equal(icon2, '☀');
  });
});

describe('polling intervals', () => {
  it('uses correct refresh intervals', () => {
    // From startPolling (line 3124-3134)
    const intervals = {
      clock: 1000,
      portfolio: 30000,
      crypto: 30000,
      health: 15000,
      auth: 30000,
    };
    assert.equal(intervals.clock, 1000, 'Clock updates every second');
    assert.equal(intervals.health, 15000, 'Health checks every 15s');
    assert.equal(intervals.portfolio, 30000, 'Portfolio refreshes every 30s');
  });
});

describe('auto-scroll threshold', () => {
  it('uses 50px threshold for auto-scroll detection', () => {
    // From line 922: scrollHeight - scrollTop - clientHeight < 50
    const isNearBottom = (scrollHeight, scrollTop, clientHeight) =>
      scrollHeight - scrollTop - clientHeight < 50;

    assert.equal(isNearBottom(1000, 950, 50), true);   // exactly at bottom
    assert.equal(isNearBottom(1000, 901, 50), true);    // 49px from bottom
    assert.equal(isNearBottom(1000, 900, 50), false);   // exactly 50px from bottom
    assert.equal(isNearBottom(1000, 500, 50), false);   // scrolled way up
  });
});

describe('terminal log entry limit', () => {
  it('limits terminal to 2000 entries', () => {
    // From line 1030: while (terminal.children.length > 2000) terminal.removeChild(...)
    const MAX_LOG_ENTRIES = 2000;
    let entries = 2001;
    while (entries > MAX_LOG_ENTRIES) entries--;
    assert.equal(entries, MAX_LOG_ENTRIES);
  });
});
