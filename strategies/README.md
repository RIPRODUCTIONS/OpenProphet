# Strategy Presets

Pre-configured trading strategy profiles for the OpenProphet agent system. Each preset defines risk parameters, heartbeat schedules, agent prompts, and trading rules that can be loaded and applied to any sandbox.

## Available Presets

| ID | Name | Asset Classes | Risk Level | Use Case |
|----|------|---------------|------------|----------|
| `options-conservative` | Conservative Options | Options | Low | Micro-account debit spreads, capital preservation |
| `options-momentum` | Options Momentum | Options | High | Aggressive directional plays, shorter DTE |
| `crypto-scalper` | Crypto Scalper | Crypto | High | 1-15m timeframe, rapid entries/exits, 24/7 |
| `crypto-dca` | Crypto DCA | Crypto | Low | Scheduled buys, long-term accumulation |
| `crypto-grid` | Crypto Grid | Crypto | Medium | Range-bound grid trading, automated levels |
| `hybrid-balanced` | Hybrid Balanced | Options + Crypto | Medium | Multi-asset allocation with weekly rebalancing |

## File Structure

```
strategies/
├── index.js                    # Loader module (getStrategy, listStrategies)
├── README.md                   # This file
├── options-conservative.json   # Default options strategy
├── options-momentum.json       # Aggressive options momentum
├── crypto-scalper.json         # High-frequency crypto scalping
├── crypto-dca.json             # Dollar-cost averaging bot
├── crypto-grid.json            # Grid trading strategy
└── hybrid-balanced.json        # Mixed options + crypto + cash
```

## How to Use a Strategy

### 1. In agent-config.json

Reference a strategy by its `id` in an agent or sandbox config:

```json
{
  "agents": [
    {
      "id": "my-agent",
      "name": "Conservative Bot",
      "strategyId": "options-conservative",
      "model": "anthropic/claude-sonnet-4-6"
    }
  ]
}
```

The harness resolves `strategyId` via the loader and injects the strategy's `agentPrompt` into the system prompt.

### 2. Programmatically

```js
import { getStrategy, listStrategies, getRiskGuardOverrides } from './strategies/index.js';

// List all available presets
const all = await listStrategies();
console.log(all);

// Load a specific strategy
const strategy = await getStrategy('crypto-scalper');
console.log(strategy.agentPrompt);

// Get risk guard overrides for a strategy
const overrides = await getRiskGuardOverrides('crypto-grid');
const guard = new RiskGuard(overrides);
```

### 3. Applying to a Sandbox

When creating or updating a sandbox, apply a strategy's configs:

```js
import { getStrategy, getRiskGuardOverrides, getHeartbeatConfig } from './strategies/index.js';

const strategy = await getStrategy('hybrid-balanced');

// Apply to sandbox config
sandbox.agent.overrides.customStrategyRules = strategy.agentPrompt;
sandbox.heartbeat = Object.fromEntries(
  Object.entries(strategy.heartbeat).map(([k, v]) => [k, v.seconds])
);

// Apply risk guard overrides
const riskConfig = await getRiskGuardOverrides('hybrid-balanced');
const guard = new RiskGuard(riskConfig);
```

## How to Switch Strategies

1. **Stop the agent** — never hot-swap strategies on a running agent
2. **Update the sandbox** `strategyId` or apply new overrides
3. **Verify** the risk guard config matches the new strategy
4. **Restart the agent** — it picks up the new strategy on boot

```js
// Example: switch sandbox from conservative to momentum
sandbox.agent.overrides.customStrategyRules = null;
sandbox.agent.strategyId = 'options-momentum';
// Then restart the agent harness
```

## How to Create a Custom Strategy

1. Copy any existing preset JSON and rename it
2. Change the `id` field to a unique identifier (kebab-case)
3. Modify the sections you need:

| Section | Purpose |
|---------|---------|
| `riskGuard` | Overrides for risk-guard.js parameters |
| `heartbeat` | Phase-specific heartbeat intervals |
| `agentPrompt` | Instructions injected into the AI agent's system prompt |
| `rules` | Strategy-specific trading logic and thresholds |
| `exchanges` | Which broker/exchange to use |
| `symbols` | Preferred trading symbols |

4. Place the file in `strategies/` — the loader picks it up automatically
5. Reference the new `id` in your agent or sandbox config

### Schema Reference

Every strategy preset follows this structure:

```json
{
  "id": "my-strategy",
  "name": "Human Readable Name",
  "description": "What this strategy does",
  "version": "1.0.0",
  "assetClasses": ["options", "crypto"],
  "riskGuard": { },
  "heartbeat": { },
  "agentPrompt": "Instructions for the AI agent...",
  "rules": { },
  "exchanges": { },
  "symbols": { }
}
```

### Risk Guard Parameters

These map directly to the `RiskGuard` constructor in `risk-guard.js`:

| Parameter | Type | Description |
|-----------|------|-------------|
| `maxPositionPct` | number | Max % of account per trade |
| `maxCashDeployedPct` | number | Max % of account deployed |
| `maxOpenPositions` | number | Max simultaneous positions |
| `maxDailyTrades` | number | Trade limit per day |
| `maxDailyLossPct` | number | Daily loss % that triggers pause |
| `maxDrawdownPct` | number | Drawdown % that triggers halt |
| `revengeCooldownMs` | number | Cooldown after loss (milliseconds) |
| `dteMin` / `dteMax` | number\|null | Options DTE range (null for crypto) |
| `deltaMin` / `deltaMax` | number\|null | Options delta range (null for crypto) |
| `cryptoMode` | boolean | Enables 24/7 operation, disables market hours checks |

### Heartbeat Configuration

Each phase defines:
- `seconds` — interval between heartbeats
- `label` — human-readable phase name
- `range` — `[startMinutes, endMinutes]` in ET, or `null` for always-active

For crypto strategies, phases are typically condition-based (active, cooldown, etc.) rather than time-of-day based.

## Validation

To verify a strategy file is valid JSON with required fields:

```bash
node -e "
  const s = require('./strategies/my-strategy.json');
  const required = ['id', 'name', 'version', 'assetClasses', 'riskGuard', 'heartbeat', 'agentPrompt'];
  const missing = required.filter(k => !s[k]);
  if (missing.length) { console.error('Missing:', missing); process.exit(1); }
  console.log('Valid:', s.id);
"
```

## Notes

- **Sandbox mode by default** — all exchange configs default to `sandbox: true`. Set explicitly to `false` for live trading.
- **riskGuard `null` values** — use `null` for parameters that don't apply (e.g., `dteMin: null` for crypto strategies disables the DTE check in risk-guard.js).
- **Strategy isolation** — each strategy is self-contained. No strategy inherits from another. If you want shared rules, extract them into a base and merge at load time.
- **Cache** — the loader caches on first read. Call `clearCache()` to force reload after editing files.
