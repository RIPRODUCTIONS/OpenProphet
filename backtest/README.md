# OpenProphet Backtest Framework

Simulates trading strategies against historical price data. Loads any strategy
preset from `strategies/`, walks through bars chronologically, applies
entry/exit rules, and outputs performance metrics as JSON.

## Quick Start

```bash
# Using npm script (delegates to scripts/backtest.sh)
npm run backtest -- --strategy options-conservative --symbol AAPL --start 2025-01-01 --end 2025-06-01

# Direct CLI invocation
node backtest/cli.js --strategy options-conservative --symbol AAPL --start 2025-01-01 --end 2025-06-01

# Offline mode — no Go backend needed
node backtest/cli.js --strategy options-momentum --data-file backtest/sample-data/AAPL-2025.json
```

## CLI Options

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--strategy` | `-s` | Strategy preset ID (required) | — |
| `--symbol` | | Ticker symbol (e.g. AAPL, SPY) | — |
| `--start` | | Start date, ISO format | — |
| `--end` | | End date, ISO format | — |
| `--capital` | `-c` | Starting capital in USD | 10000 |
| `--data-file` | `-f` | Local JSON bars file (skips API) | — |
| `--timeframe` | | Bar timeframe | 1Day |
| `--port` | | Go backend port | 4534 |
| `--pretty` | | Pretty-print JSON output | false |
| `--help` | `-h` | Show help | — |

Either `--data-file` OR all three of `--symbol`, `--start`, `--end` are required.

## Available Strategies

| ID | Asset Class | Style |
|----|-------------|-------|
| `options-conservative` | Options | Vertical debit spreads, defined risk |
| `options-momentum` | Options | Aggressive directional single-leg |
| `crypto-scalper` | Crypto | High-frequency 1m–15m scalping |
| `crypto-dca` | Crypto | Dollar-cost averaging |
| `crypto-grid` | Crypto | Range-bound grid trading |
| `hybrid-balanced` | Options+Crypto | Multi-asset 40/30/30 split |

## Output Metrics

The engine outputs JSON with these fields:

```json
{
  "symbol": "AAPL",
  "strategy": "options-conservative",
  "startDate": "2025-01-02T05:00:00Z",
  "endDate": "2025-06-30T05:00:00Z",
  "barsProcessed": 125,
  "initialCapital": 10000,
  "finalCapital": 11240.50,
  "totalReturn": 12.41,
  "totalPnL": 1240.50,
  "sharpeRatio": 1.83,
  "maxDrawdown": 4.21,
  "winRate": 66.67,
  "avgWin": 820.30,
  "avgLoss": -340.10,
  "totalTrades": 6,
  "trades": [...]
}
```

Each trade in the `trades` array includes:
- `entryDate`, `exitDate` — timestamps
- `entryPrice`, `exitPrice` — prices
- `shares` — position size
- `pnl` — profit/loss in USD
- `returnPct` — percentage return
- `reason` — exit trigger (`stop-loss`, `take-profit`, `rsi-overbought`, `end-of-data`)
- `holdBars` — number of bars the position was held

## How It Works

1. **Loads strategy** from `strategies/<id>.json`
2. **Fetches bars** from the Go backend (`/api/v1/market/bars/`) or a local file
3. **Computes indicators** — SMA(20), RSI(14), MACD(12,26) over the full bar series
4. **Walks through bars** starting after the 26-bar warmup:
   - **Entry**: checks technical confirmations (RSI oversold, MACD crossover, price above SMA) against the strategy's required threshold
   - **Position sizing**: uses `riskGuard.maxPositionPct` to limit capital per trade
   - **Exit**: checks stop-loss, take-profit, and RSI overbought conditions each bar
5. **Closes open positions** at the last bar if still held
6. **Computes metrics** — Sharpe ratio (annualised, 252 days), max drawdown from equity curve, win rate, avg win/loss

## Data File Format

The `--data-file` flag accepts a JSON array of bars. Supported field formats:

```json
// Alpaca short keys
[{ "t": "2025-01-02T05:00:00Z", "o": 220.5, "h": 223.8, "l": 219.3, "c": 222.4, "v": 45200000 }]

// Go-style keys
[{ "Timestamp": "...", "Open": 220.5, "High": 223.8, "Low": 219.3, "Close": 222.4, "Volume": 45200000 }]

// Lowercase keys
[{ "timestamp": "...", "open": 220.5, "high": 223.8, "low": 219.3, "close": 222.4, "volume": 45200000 }]
```

Wrapped responses like `{ "bars": [...] }` or `{ "data": [...] }` are also accepted.

## Running Tests

```bash
node --test backtest/engine.test.js
```

Tests cover: P&L calculation, stop-loss triggers, take-profit triggers, empty/insufficient data, position sizing, metrics computation, bar normalisation, indicator correctness, and sample data integration.

## Architecture

```
backtest/
├── engine.js          # Core backtest engine (exported functions)
├── cli.js             # CLI wrapper (parseArgs → engine → JSON stdout)
├── engine.test.js     # Tests (node:test)
├── README.md          # This file
└── sample-data/
    └── AAPL-2025.json # 20 bars for offline testing
```

The engine exports all functions for use in tests or other tooling:
- `runBacktest({ strategy, bars, capital })` — main entry point
- `loadStrategy(id)` / `loadBarsFromFile(path)` / `fetchBarsFromAPI(...)` — data loading
- `normaliseBars(raw)` — bar format normalisation
- `extractRules(strategy)` — strategy rule extraction
- `sma()`, `rsi()`, `macd()` — technical indicators
- `countBuySignals()`, `shouldExit()` — signal generation
