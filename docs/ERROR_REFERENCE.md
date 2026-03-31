# OpenClaw Trader — Error Reference

> Every known error message, where it comes from, what causes it, and how to fix it.
>
> Last updated: 2025-07-17

---

## Common Issues (Start Here)

These are the errors you'll hit most often. Check these first before diving into the component-specific tables.

| Symptom | Error Message | Likely Cause | Fix |
|---------|---------------|-------------|-----|
| Orders silently blocked | `[RiskGuard] BLOCKED: …` | Risk guard rule violation (daily loss, max trades, equity) | Check `risk-guard.js` state; review rule thresholds via dashboard permissions |
| Agent can't trade | `Cannot verify permissions — agent server unreachable. Order blocked for safety.` | Agent server is down or not responding to permission checks | Restart agent server (`node agent/server.js`); check port/firewall |
| Agent can't trade | `Live trading is DISABLED (read-only mode). Cannot place orders.` | Permissions have `liveTrading: false` | Enable live trading in dashboard sandbox permissions |
| Backend 502 errors | `Trading bot unavailable` / `Sandbox trading backend unavailable` | Go trading backend process crashed or never started | Check Go process logs; restart via orchestrator or `go run .` |
| Stale data warnings | `Account equity is 0 or missing — backend may be returning stale data` | Alpaca API returning empty account data | Verify Alpaca API keys; check market hours; restart Go backend |
| Auth failures | `Unauthorized. Set Authorization: Bearer <token> header.` | Missing or invalid API token in request | Set `AGENT_API_TOKEN` env var; include `Authorization: Bearer <token>` header |
| Config errors | `Config not loaded. Call loadConfig() first.` | Config store accessed before initialization | Ensure `loadConfig()` is called during startup |
| Agent won't start | `OpenCode not authenticated. Run "opencode auth login" or set ANTHROPIC_API_KEY in .env` | Claude API credentials missing | Run `opencode auth login` or add `ANTHROPIC_API_KEY` to `.env` |
| Circuit breaker tripped | `[CircuitBreaker] TRIPPED after N consecutive errors` | Too many consecutive tool failures | Wait for cooldown period; investigate underlying tool failures |

---

## Table of Contents

1. [Go Backend — Alpaca Trading](#go-backend--alpaca-trading)
2. [Go Backend — Alpaca Market Data](#go-backend--alpaca-market-data)
3. [Go Backend — Options Data](#go-backend--options-data)
4. [Go Backend — Economic Feeds](#go-backend--economic-feeds)
5. [Go Backend — Gemini AI](#go-backend--gemini-ai)
6. [Go Backend — News Service](#go-backend--news-service)
7. [Go Backend — Technical Analysis](#go-backend--technical-analysis)
8. [Go Backend — Position Manager](#go-backend--position-manager)
9. [Go Backend — Activity Logger](#go-backend--activity-logger)
10. [Go Backend — Database/Storage](#go-backend--databasestorage)
11. [MCP Server — Permission & Risk Enforcement](#mcp-server--permission--risk-enforcement)
12. [MCP Server — Risk Guard](#mcp-server--risk-guard)
13. [MCP Server — Tool Dispatch](#mcp-server--tool-dispatch)
14. [MCP Server — Circuit Breaker](#mcp-server--circuit-breaker)
15. [MCP Server — Shutdown](#mcp-server--shutdown)
16. [Agent — Harness (Trading Agent)](#agent--harness-trading-agent)
17. [Agent — Orchestrator](#agent--orchestrator)
18. [Agent — Config Store](#agent--config-store)
19. [Agent API — Account Routes](#agent-api--account-routes)
20. [Agent API — Agent Routes](#agent-api--agent-routes)
21. [Agent API — Chat Routes](#agent-api--chat-routes)
22. [Agent API — Heartbeat Routes](#agent-api--heartbeat-routes)
23. [Agent API — Permission Routes](#agent-api--permission-routes)
24. [Agent API — Portfolio Routes](#agent-api--portfolio-routes)
25. [Agent API — Sandbox Routes](#agent-api--sandbox-routes)
26. [Agent API — Strategy Routes](#agent-api--strategy-routes)
27. [Agent — Auth Middleware](#agent--auth-middleware)
28. [Alerts System](#alerts-system)
29. [Utilities — Perf Analytics](#utilities--perf-analytics)
30. [Utilities — Regime Detector](#utilities--regime-detector)

---

## Go Backend — Alpaca Trading

**Source:** `services/alpaca_trading.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `failed to place order: %w` | `PlaceOrder()` | Alpaca API rejected the order or network failure | Check Alpaca API status; verify order parameters (symbol, qty, side); check API key permissions |
| `failed to cancel order: %w` | `CancelOrder()` | Order ID invalid, already filled, or API unreachable | Verify order ID exists and is cancellable; check Alpaca status |
| `failed to get order: %w` | `GetOrder()` | Order ID not found or API error | Confirm order ID; check API connectivity |
| `failed to list orders: %w` | `ListOrders()` | API call failed | Check Alpaca credentials and connectivity |
| `failed to get positions: %w` | `GetPositions()` | Positions endpoint failed | Verify API key has trading permissions |
| `failed to get account: %w` | `GetAccount()` | Account data unavailable | Check `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` env vars |
| `failed to place options order: %w` | `PlaceOptionsOrder()` | Options order rejected | Verify options are enabled on Alpaca account; check contract symbol format |
| `failed to create request: %w` | `FetchOptionsChain()` | HTTP request construction failed | Internal error — check Go HTTP client configuration |
| `failed to fetch options chain: %w` | `FetchOptionsChain()` | Chain fetch API call failed | Check Alpaca options data subscription |
| `options chain API error (HTTP %d): %s` | `FetchOptionsChain()` | Alpaca returned non-2xx with error body | Read the error body for details; common: 403 (no subscription), 429 (rate limit) |
| `failed to read response: %w` | `FetchOptionsChain()` | Response body unreadable | Possible network interruption mid-response |
| `failed to parse response: %w` | `FetchOptionsChain()` | JSON unmarshal failed | API response format changed or corrupted |
| `options quote not implemented yet` | `GetOptionsQuote()` | Feature stub — not yet implemented | Use `FetchOptionsChain()` or `GetSnapshot()` instead |
| `options position not found: %s` | `FindOptionsPosition()` | Contract symbol not in current positions | Verify the exact OCC symbol format; position may have been closed |

---

## Go Backend — Alpaca Market Data

**Source:** `services/alpaca_data.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `failed to get historical bars: %w` | `GetHistoricalBars()` | Bars API call failed | Check symbol validity; verify data subscription tier |
| `failed to get latest bar: %w` | `GetLatestBar()` | Latest bar endpoint failed | May happen outside market hours for some symbols |
| `no bar data found for symbol: %s` | `GetLatestBar()` | Symbol exists but has no recent bar data | Check if symbol is actively traded; try a different timeframe |
| `failed to get latest quote: %w` | `GetLatestQuote()` | Quote endpoint failed | Check API connectivity and subscription |
| `no quote data found for symbol: %s` | `GetLatestQuote()` | Symbol not in quote response | Verify symbol is valid and currently listed |
| `failed to get latest trade: %w` | `GetLatestTrade()` | Trade endpoint failed | Check API status |
| `no trade data found for symbol: %s` | `GetLatestTrade()` | No recent trades for symbol | Low-volume symbol or market closed |
| `no symbols provided for streaming` | `StreamBars()` | Empty symbols array passed | Provide at least one symbol to stream |
| `failed to connect to bar stream: %w` | `StreamBars()` | WebSocket connection to Alpaca failed | Check network, firewall (WebSocket on port 443), and API credentials |

---

## Go Backend — Options Data

**Source:** `services/alpaca_options_data.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `failed to fetch snapshot: %w` | `GetSnapshot()` | Snapshot API call failed | Check options data subscription on Alpaca |
| `API error %d: %s` | `GetSnapshot()` | Non-200 HTTP status from Alpaca | Read status code: 403 = no subscription, 404 = invalid symbol, 429 = rate limited |
| `failed to decode snapshot: %w` | `GetSnapshot()` | JSON unmarshal error on snapshot | API response format may have changed |
| `no snapshot data for %s` | `GetSnapshot()` | Symbol not in snapshot response | Verify OCC symbol format (e.g., `AAPL240119C00150000`) |
| `failed to fetch option chain: %w` | `GetOptionChain()` | Chain endpoint failed | Check API connectivity |
| `API error %d: %s` | `GetOptionChain()` | Non-200 response | Check status code and error body |
| `failed to decode chain: %w` | `GetOptionChain()` | JSON parse error | Possible API change |
| `failed to fetch options: %w` | `FetchOptions()` | Options list fetch failed | Check Alpaca options API availability |
| `API error %d: %s` | `FetchOptions()` | Non-200 response | Check credentials and subscription |
| `failed to decode response: %w` | `FetchOptions()` | Response body unmarshal error | Possible corrupted response |

---

## Go Backend — Economic Feeds

**Source:** `services/economic_feeds.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `treasury debt: %w` | `GetTreasuryDebt()` | Treasury API call failed | Check FiscalData.treasury.gov availability |
| `treasury rates: %w` | `GetTreasuryRates()` | Rates endpoint failed | External API may be down |
| `gdelt: %w` | `GetGDELT()` | GDELT feed error | Check GDELT API availability |
| `bls: %w` | `GetBLS()` | Bureau of Labor Statistics API error | Check BLS API key and rate limits |
| `no chart data for %s` | `GetChartData()` | Symbol not found in chart data source | Verify symbol format for the specific data provider |
| `no results for %s` | `GetChartData()` | API returned empty result set | Symbol may not exist or data unavailable for timeframe |
| `invalid result for %s` | `GetChartData()` | Result structure doesn't match expected format | Possible API response format change |
| `no meta for %s` | `GetChartData()` | Metadata missing from chart response | Incomplete API response |
| `usaspending: %w` | `GetUSASpending()` | USASpending.gov API error | External API may be down or rate limited |
| `HTTP %d from %s` | Various | Non-2xx HTTP response from any feed | Check specific feed URL and API status |

---

## Go Backend — Gemini AI

**Source:** `services/gemini_service.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `no news items provided` | `GenerateContent()` | Empty input array | Ensure at least one news item is passed |
| `failed to generate content: %w` | `GenerateContent()` | Gemini API call failed | Check `GEMINI_API_KEY` env var; verify API quota |
| `failed to marshal request: %w` | `callGeminiAPI()` | Request JSON serialization error | Internal error — check request struct |
| `failed to create request: %w` | `callGeminiAPI()` | HTTP request construction failed | Internal error |
| `failed to make request: %w` | `callGeminiAPI()` | HTTP call execution failed | Check network connectivity to Google APIs |
| `API error (status %d): %s` | `callGeminiAPI()` | Gemini returned non-200 | 400 = bad request, 403 = invalid key, 429 = quota exceeded, 500 = Gemini outage |
| `failed to read response: %w` | `callGeminiAPI()` | Response body read failed | Network interruption |
| `failed to unmarshal response: %w` | `callGeminiAPI()` | JSON parse error on response | API response format change |
| `no content in response` | `callGeminiAPI()` | Response had no content candidates | Gemini safety filter may have blocked content; try different prompt |

---

## Go Backend — News Service

**Source:** `services/news_service.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `failed to fetch RSS feed: %w` | `FetchRSSFeed()` | HTTP request to RSS URL failed | Check feed URL accessibility |
| `unexpected status code: %d` | `FetchRSSFeed()` | Non-200 HTTP response | Feed URL may have moved (301/302) or is down |
| `failed to read response body: %w` | `FetchRSSFeed()` | Body read error | Network interruption |
| `failed to parse RSS feed: %w` | `FetchRSSFeed()` | XML parsing error | Feed may be malformed or not valid RSS/Atom |

---

## Go Backend — Technical Analysis

**Source:** `services/technical_analysis.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `no bars data available` | `CalculateMACD()`, `CalculateRSI()`, etc. | Insufficient bar data for calculation | Fetch more historical bars; verify symbol has enough trading history |

---

## Go Backend — Position Manager

**Source:** `services/position_manager.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `invalid request: %w` | `CreatePosition()` | Request validation failed | Check required fields: symbol, side, quantity |
| `failed to get current price: %w` | `CreatePosition()` | Price lookup failed before position entry | Verify symbol exists and market data is available |
| `failed to place entry order: %w` | `CreatePosition()` | Order placement failed | Check Alpaca account status and buying power |
| `position not found: %s` | `GetManagedPosition()` / `UpdatePosition()` | Position ID doesn't exist in managed positions | Position may have been closed or ID is incorrect |
| `side must be 'buy' or 'sell'` | `CreatePosition()` / `UpdatePosition()` | Invalid side parameter | Use exactly `"buy"` or `"sell"` (lowercase) |
| `entry_price required for limit orders` | `CreatePosition()` | Missing entry price with limit order type | Provide `entry_price` field when `order_type` is `"limit"` |
| `either stop_loss_price or stop_loss_percent required` | `CreatePosition()` | No stop loss specified | Provide `stop_loss_price` (absolute) or `stop_loss_percent` (relative) |
| `either take_profit_price or take_profit_percent required` | `CreatePosition()` | No take profit specified | Provide `take_profit_price` or `take_profit_percent` |

---

## Go Backend — Activity Logger

**Source:** `services/activity_logger.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `no active session` | `EndSession()` / `LogActivity()` / `SaveLog()` | Session not started before logging | Call `StartSession()` first |
| `no active session - call StartSession first` | `LogActivity()` | Pre-condition: session must be active | Initialize session before logging activities |
| `log not found for date %s: %w` | `GetLogForDate()` | Log file for requested date doesn't exist | Check date format; log may not have been created for that date |
| `failed to parse log: %w` | `GetLogForDate()` | JSON unmarshal error on log file | Log file may be corrupted; check JSON validity |
| `no active log to save` | `SaveLog()` | Session log is nil | Start a session before saving |
| `failed to marshal log: %w` | `SaveLog()` | JSON serialization error | Internal error — check log data structure |
| `failed to write log file: %w` | `SaveLog()` | File system write error | Check disk space and directory permissions |

---

## Go Backend — Database/Storage

**Source:** `database/storage.go`

| Error Message | Function | Cause | Resolution |
|---------------|----------|-------|------------|
| `failed to create database directory: %w` | `NewStorage()` | mkdir failed | Check parent directory permissions |
| `failed to open database: %w` | `NewStorage()` | SQLite connection failed | Check db file path and disk space |
| `failed to migrate database: %w` | `NewStorage()` | Schema migration error | Database may be corrupted; check GORM migration logs |
| `failed to save bars: %w` | `SaveBars()` | INSERT/UPDATE error | Check data types match schema |
| `failed to get bars: %w` | `GetBars()` | SELECT query failed | Database may be locked or corrupted |
| `failed to save order: %w` | `SaveOrder()` | INSERT error | Check order data integrity |
| `failed to get order: %w` | `GetOrder()` | SELECT error | Order ID may not exist |
| `failed to get orders: %w` | `ListOrders()` | SELECT error | Database connectivity issue |
| `failed to delete old bars: %w` | `CleanupOldData()` | DELETE query error | Database may be locked |
| `failed to delete old snapshots: %w` | `CleanupOldData()` | DELETE error | Same as above |
| `failed to delete old signals: %w` | `CleanupOldData()` | DELETE error | Same as above |
| `failed to save position: %w` | `SavePosition()` | INSERT error | Check position data fields |
| `failed to save account snapshot: %w` | `SaveAccountSnapshot()` | INSERT error | Check snapshot data fields |
| `failed to save signal: %w` | `SaveSignal()` | INSERT error | Check signal data structure |
| `failed to save managed position: %w` | `SaveManagedPosition()` | INSERT error | Check managed position fields |
| `failed to get managed position: %w` | `GetManagedPosition()` | SELECT error | Position ID may not exist |
| `failed to get managed positions: %w` | `GetManagedPositions()` | SELECT error | Database connectivity |
| `failed to delete managed position: %w` | `DeleteManagedPosition()` | DELETE error | Position ID may not exist |

---

## MCP Server — Permission & Risk Enforcement

**Source:** `mcp-server.js`

These errors are thrown when the MCP tool server blocks an order due to permission or risk violations. They are the most common errors operators will see.

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `Cannot verify permissions — agent server unreachable. Order blocked for safety.` | Agent server not responding to permission check | Restart agent server; check port binding |
| `Tool "${toolName}" is blocked by permissions. Blocked tools: ${list}` | Tool name is in the sandbox's `blockedTools` array | Remove tool from blockedTools in sandbox permissions |
| `Live trading is DISABLED (read-only mode). Cannot place orders. Change permissions to enable.` | `liveTrading: false` in sandbox permissions | Enable live trading via dashboard |
| `Options trading is DISABLED by permissions.` | `optionsEnabled: false` in sandbox permissions | Enable options in sandbox permissions |
| `Stock trading is DISABLED by permissions.` | `stockEnabled: false` in sandbox permissions | Enable stocks in sandbox permissions |
| `0DTE options are NOT allowed by permissions.` | Option expires today and `allow0DTE: false` | Enable 0DTE in permissions or use longer-dated contracts |
| `Order requires operator confirmation (requireConfirmation is enabled). Tell the operator what you want to do and wait for them to disable this setting or approve via the dashboard.` | `requireConfirmation: true` | Approve via dashboard or disable confirmation requirement |
| `Order value $${value} exceeds max allowed $${max}. Reduce size or change permissions.` | Order dollar value exceeds `maxOrderValue` | Reduce order size or increase `maxOrderValue` in permissions |
| `Account equity is 0 or missing — backend may be returning stale data` | Backend returned zero equity | Verify Alpaca connection; restart Go backend |
| `[RiskGuard] BLOCKED: ${message}` | Risk guard detected equity or stale data issue | Investigate specific message; restart backend if data is stale |
| `[RiskGuard] BLOCKED: Cannot place orders — trading backend unreachable: ${message}` | Go backend not responding | Restart Go trading backend; check process health |
| `[RiskGuard] ${rule}: ${reason}` | Specific risk guard rule violation | See [Risk Guard Rules](#mcp-server--risk-guard) for per-rule details |
| `Trading bot error: ${error.message}` | Go backend returned an error | Inspect wrapped error message for root cause |

---

## MCP Server — Risk Guard

**Source:** `risk-guard.js`

The risk guard enforces configurable trading safety rules. When a rule is violated, the order is blocked with the rule name and reason.

| Rule | Trigger | Resolution |
|------|---------|------------|
| `max_daily_trades` | Daily trade count exceeds configured limit | Wait for next trading day or increase limit |
| `max_daily_loss` | Daily P&L loss exceeds threshold | Stop trading for the day or increase loss limit |
| `max_position_size` | Position size (shares or contracts) too large | Reduce order quantity |
| `max_portfolio_allocation` | Single position would exceed portfolio % limit | Reduce position size or close other positions |
| `max_open_positions` | Too many open positions | Close existing positions first |
| `consecutive_loss_lockout` | Too many consecutive losing trades | Wait for lockout period to expire |
| `equity_floor` | Account equity below minimum threshold | Add funds or reduce positions |
| `volatility_filter` | Market volatility (VIX) exceeds threshold | Wait for volatility to subside |

**Logged warnings (not blocking):**

| Message | Cause |
|---------|-------|
| `[RiskGuard] WARNING: daily_profit_loss not available from backend, using 0` | Backend didn't return P&L data |
| `RiskGuard recordTrade error: …` | Failed to record trade for tracking |
| `[RiskGuard] Failed to persist state: …` | State file write error — rules still work but won't survive restart |
| `RiskGuard: failed to load strategy "${id}": …` | Strategy rules file missing or malformed |

---

## MCP Server — Tool Dispatch

**Source:** `mcp-server.js`

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `Unknown tool: ${name}` | Tool name not recognized by MCP server | Check tool name spelling; verify tool is registered |
| `Error fetching topic ${topic}: …` | Topic research API failed | Check news/data source availability |
| `Error fetching symbol ${symbol}: …` | Symbol lookup API failed | Verify symbol exists |

---

## MCP Server — Circuit Breaker

**Source:** `mcp-server.js`

| Message | Cause | Resolution |
|---------|-------|------------|
| `[CircuitBreaker] TRIPPED after ${N} consecutive errors. Last: ${tool} → ${error}. Cooldown ${ms}s.` | Too many consecutive tool call failures | Investigate underlying failures; wait for cooldown or restart |
| `[CircuitBreaker] Cooldown expired, resetting. Allowing calls.` | Circuit breaker recovered after cooldown | No action needed — normal recovery |

---

## MCP Server — Shutdown

**Source:** `mcp-server.js`

| Message | Cause | Resolution |
|---------|-------|------------|
| `[shutdown] Received ${signal}, cleaning up...` | Process received SIGTERM/SIGINT | Normal shutdown — no action needed |
| `[shutdown] Risk guard state saved.` | State persisted successfully | Informational |
| `[shutdown] Failed to save risk guard state: …` | State file write failed during shutdown | Check disk space and file permissions |
| `[shutdown] Alert queue flushed.` | Pending alerts sent | Informational |
| `[shutdown] Failed to flush alerts: …` | Alert delivery failed during shutdown | Check Telegram/Slack connectivity |

---

## Agent — Harness (Trading Agent)

**Source:** `agent/harness.js`

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `OpenCode not authenticated. Run "opencode auth login" or set ANTHROPIC_API_KEY in .env` | Claude API credentials missing | Run `opencode auth login` or add `ANTHROPIC_API_KEY=sk-ant-...` to `.env` |
| `Sandbox not found: ${sandboxId}` | Sandbox ID doesn't exist in config | Check sandbox ID; run config-store list |
| `Agent not found for sandbox ${sandboxConfig.id}` | Agent missing from sandbox configuration | Add agent to sandbox config via dashboard |
| `Agent is not running. Start the agent first.` | Attempted operation on stopped agent | Call `agent.start()` before sending messages |
| `${result.error}` (heartbeat) | Heartbeat execution returned an error | Check heartbeat phase configuration and MCP server health |
| `${result.error}` (phase) | Phase execution failed | Check phase time ranges and strategy rules |
| `Warning: Failed to load strategy rules file "${path}": …` | Strategy rules file not found or JSON parse error | Verify rules file path in strategy config; check JSON syntax |
| `Beat #${num} error: …` | Individual heartbeat iteration failed | Inspect wrapped error; may be transient |

---

## Agent — Orchestrator

**Source:** `agent/orchestrator.js`

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `Sandbox not found: ${sandboxId}` | Sandbox ID doesn't exist | Verify sandbox ID in config |
| `Account not found for sandbox ${sandboxId}` | No account linked to sandbox | Link an Alpaca account to the sandbox in config |
| `Trading backend failed to start for sandbox ${sandboxId}` | Go process failed to launch | Check Go build; verify port availability; check logs |

---

## Agent — Config Store

**Source:** `agent/config-store.js`

| Error Message | Context | Resolution |
|---------------|---------|------------|
| `Config not loaded. Call loadConfig() first.` | Config accessed before init | Ensure `loadConfig()` runs at startup |
| `Sandbox not found` | Sandbox lookup/retrieval/deletion | Verify sandbox ID exists in config file |
| `Account ${accountId} not found` | Account validation | Check account ID in config |
| `Sandbox ${sandboxId} already exists` | Creating duplicate sandbox | Use a different sandbox ID |
| `Sandbox ${sandboxId} not found` | Sandbox deletion | Sandbox was already deleted or never existed |
| `Account not found` | Account removal | Account ID not in config |
| `Agent not found` | Agent lookup/verification | Check agent ID in config |
| `Cannot remove default agent` | Deleting the 'default' agent | Cannot delete default; create a new agent instead |
| `Strategy not found` | Strategy removal | Strategy ID doesn't exist |
| `Cannot remove default strategy` | Deleting 'default' strategy | Cannot delete default; create a new strategy instead |
| `Unknown heartbeat profile: ${profileKey}` | Setting heartbeat profile | Use a valid profile key from `HEARTBEAT_PROFILES` |
| `Unknown phase: ${phase}` | Setting phase time range | Use a valid phase name from `PHASE_TIME_RANGES` |

---

## Agent API — Account Routes

**Source:** `agent/routes/account.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `${err.message}` | 400 | Account CRUD operation failed | Check request body parameters |
| `Timed out waiting for auth URL` | 500 | OpenCode login took >15 seconds | Retry; check OpenCode CLI availability |
| `Logout failed: ${output}` | 500 | OpenCode logout command failed | Check OpenCode CLI; may need manual cleanup |

---

## Agent API — Agent Routes

**Source:** `agent/routes/agent.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `${err.message}` | 500 | Agent initialization failed | Check agent config and dependencies |
| `Message is required` | 400 | Empty or missing message body | Include `message` field in POST body |
| `Agent not found` | 404 | Agent ID doesn't exist | List agents to find valid IDs |
| `Sandbox not found` | 404 | Sandbox ID doesn't exist | List sandboxes to find valid IDs |
| `${err.message}` | 400/500 | Various agent operations failed | Inspect specific error message |

---

## Agent API — Chat Routes

**Source:** `agent/routes/chat.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `Message is required` | 400 | Empty message field | Include non-empty `message` in request body |
| `No active account` | 400 | No `activeAccountId` set | Activate an account first via account routes |
| `${err.message}` | 400/500 | Chat operation failed | Check error details in response |

---

## Agent API — Heartbeat Routes

**Source:** `agent/routes/heartbeat.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `seconds must be 30-3600` | 400 | Interval value out of valid range | Use a value between 30 and 3600 seconds |
| `Sandbox harness not found` | 404 | Harness not initialized for sandbox | Start the sandbox first |
| `No active sandbox` | 400 | No sandbox currently active | Activate a sandbox before heartbeat operations |
| `Phase is required` | 400 | Missing `phase` parameter | Include `phase` field (e.g., `"premarket"`, `"market"`, `"afterhours"`) |
| `${err.message}` | 400 | Heartbeat operation failed | Check wrapped error details |

---

## Agent API — Permission Routes

**Source:** `agent/routes/permissions.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `${err.message}` | 400 | Permission or plugin update failed | Check request body format |
| `No Slack webhook URL configured` | 400 | Slack `webhookUrl` missing from config | Add `webhookUrl` to Slack plugin configuration |
| `Failed to send test message: ${err.message}` | 500 | Slack API rejected the webhook call | Verify webhook URL is valid and Slack workspace is accessible |

---

## Agent API — Portfolio Routes

**Source:** `agent/routes/portfolio.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `Sandbox trading backend unavailable` | 404 | Trading bot client not initialized | Start the Go backend for this sandbox |
| `Trading bot unavailable` | 502 | Go backend API call failed | Restart Go backend; check process health |
| `Crypto exchange unavailable: ${message}` | 502 | Crypto exchange API error | Check exchange connectivity and API keys |
| `Crypto not configured` | 503 | `cryptoService` is null | Configure crypto exchange credentials |
| `Ticker unavailable: ${message}` | 502 | Ticker API failed | Check data provider connectivity |
| `${message}` | 502 | Generic portfolio fetch error | Inspect specific error message |

---

## Agent API — Sandbox Routes

**Source:** `agent/routes/sandbox.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `${err.message}` | 404 | Sandbox deletion failed | Sandbox may not exist |
| `Message is required` | 400 | Empty message body | Include `message` in POST body |
| `Agent not found` | 404 | Agent ID doesn't exist for sandbox | Check agent configuration |
| `rules is required` | 400 | Missing `rules` field in request | Include `rules` JSON in request body |
| `${err.message}` | 400 | Various sandbox operations failed | Check specific error details |

---

## Agent API — Strategy Routes

**Source:** `agent/routes/strategy.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `${err.message}` | 400 | Strategy CRUD operation failed | Check request body format and strategy ID |

---

## Agent — Auth Middleware

**Source:** `agent/middleware/auth.js`

| Error Message | HTTP Status | Cause | Resolution |
|---------------|-------------|-------|------------|
| `Unauthorized. Set Authorization: Bearer <token> header.` | 401 | Missing or invalid auth token | Set `AGENT_API_TOKEN` env var and include `Authorization: Bearer <token>` in requests |

---

## Alerts System

**Source:** `alerts.js`

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `Telegram API returned ok=false` / `${resp.data?.description}` | Telegram API rejected the message | Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; verify bot has send permissions |
| `Rate limited on ${channel}` | Too many messages sent to a channel | Wait before sending more; consider batching alerts |
| `Unknown channel: ${channel}` | Channel type not recognized | Use a supported channel: `telegram`, `slack`, `console` |

---

## Utilities — Perf Analytics

**Source:** `perf-analytics.js`

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `Invalid date: ${s}` | Date string couldn't be parsed | Use ISO 8601 format (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ssZ`) |

---

## Utilities — Regime Detector

**Source:** `regime-detector.js`

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `spyBars is required and must be an array of OHLCV bars` | Missing or invalid `spyBars` input | Pass an array of bar objects with `open`, `high`, `low`, `close`, `volume` fields |
| `Insufficient bars for analysis` | Not enough bars to compute regime | Provide at least 50+ bars for meaningful regime detection |

---

## HTTP Status Code Summary

| Status Code | Meaning | Where Used |
|-------------|---------|------------|
| **400** | Bad Request — invalid input, missing fields, validation failure | All agent routes |
| **401** | Unauthorized — missing or invalid auth token | Auth middleware |
| **404** | Not Found — resource doesn't exist (sandbox, agent, account) | Agent, sandbox, heartbeat routes |
| **500** | Internal Server Error — operation failure, timeouts | Account routes (auth timeout), generic errors |
| **502** | Bad Gateway — upstream backend unavailable | Portfolio routes (trading bot, crypto, ticker) |
| **503** | Service Unavailable — service not configured | Portfolio routes (crypto not configured) |

---

## Error Pattern Guide

### Go Backend Error Pattern
All Go errors follow the `fmt.Errorf("description: %w", err)` pattern, wrapping the underlying error. Unwrap the chain to find the root cause:
```
"failed to place order: failed to create request: dial tcp: connection refused"
                        ↑ first wrapper          ↑ root cause
```

### MCP Server Error Flow
```
Tool call → Permission check → Risk guard check → Backend call → Response
         ↓ blocked            ↓ blocked          ↓ error
     Permission error     Risk guard error    Trading bot error
```

### Agent API Error Flow
```
HTTP request → Auth middleware → Route handler → Config/Orchestrator → Response
            ↓ 401             ↓ 400/404/500
       Unauthorized       Business logic error
```
