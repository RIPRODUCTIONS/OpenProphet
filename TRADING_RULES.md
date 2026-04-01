# Trading Rules

**Updated:** March 28, 2026
**Style:** Conservative micro-account options trading — defined risk only
**Account Size:** $100 (paper: $100K for testing, live: $100)

---

## Core Philosophy

- **Options-only trading** — No stock positions
- **Defined risk ONLY** — Every trade has a known max loss before entry
- **Debit spreads are the primary weapon** — $1-wide verticals on liquid underlyings
- **Survival first** — Preserve capital. One bad trade can wipe 30%+ of a $100 account
- **Paper until proven** — Run 30+ paper trades with >1.0 profit factor before going live
- **One position at a time** — No portfolio to manage, just one focused bet

---

## Position Sizing

**Rule:** Maximum 30% of account per trade ($30 on $100 account)
- On paper ($100K): Scale proportionally — max $30K per position to simulate real constraints
- On live ($100): One $1-wide debit spread = $30-$80 max risk
- NEVER risk more than 1 contract at a time on live

**Rule:** Maximum 1 open position at a time
- Simplifies management for autonomous agent
- Forces selectivity — only take the best setup
- Exception: Can open a second position if first is >+30% and trailing stop is set

**Rule:** Maintain 50%+ cash at all times
- On a $100 account, never have more than $50 deployed
- Allows averaging into a position if thesis holds but entry was early

---

## Allowed Strategies (Ranked by Priority)

### 1. Vertical Debit Spreads (Primary Strategy)
- **Bull call spread:** Buy ATM call, sell $1 OTM call — max risk = debit paid
- **Bear put spread:** Buy ATM put, sell $1 OTM put — max risk = debit paid
- **Why:** Defined risk, cheap entry ($30-80), profits from directional move
- **Target tickers:** SPY, QQQ, AAPL, AMD, NVDA (liquid options, tight spreads)

### 2. Single Long Options (Secondary — High Conviction Only)
- Buy cheap OTM calls/puts on low-priced stocks
- Max cost: $50 per contract
- **Warning:** Most expire worthless. Only use when technical + catalyst alignment is strong
- Acceptable tickers: SOFI, PLTR, F, BAC, AMD (stocks with options under $1)

### 3. NOT ALLOWED
- ❌ Naked calls or puts
- ❌ Credit spreads (require margin/collateral beyond $100)
- ❌ Iron condors (too complex for micro-account)
- ❌ Covered calls (can't afford 100 shares of anything)
- ❌ 0DTE options (pure gambling at this account size)
- ❌ Scalping (transaction costs eat micro-accounts alive)

---

## Options Selection

**Rule:** 14-45 DTE for all positions
- Under 14 DTE: Theta decay accelerates, time pressure too high
- Over 45 DTE: Too expensive for micro-account, capital tied up too long
- Sweet spot: 21-30 DTE (weeklies or front-month monthlies)

**Rule:** Delta 0.35-0.55 for long leg
- ATM to slightly OTM — best risk/reward ratio
- Avoid deep OTM (delta <0.20) — low probability lottery tickets
- Avoid deep ITM (delta >0.70) — too expensive, no leverage

**Rule:** Bid-ask spread <15% of mid-price
- Check: `(ask - bid) / mid < 0.15`
- Wider spreads are acceptable on micro-accounts due to limited choices
- Still use LIMIT ORDERS ONLY — never market orders on options

**Rule:** Minimum open interest of 100 on both legs
- Ensures fills are realistic
- Low open interest = bad fills = guaranteed loss

---

## Entry Rules

**Rule:** Require 2 of 3 technical confirmations before entry
1. **RSI signal:** Oversold (<30) for calls, overbought (>70) for puts
2. **MACD cross:** Bullish crossover for calls, bearish for puts
3. **Price action:** Bounce off support for calls, rejection at resistance for puts

**Rule:** Check news before every entry
- No entering before known catalysts (earnings, Fed, CPI) unless that IS the thesis
- Catalyst trades require extra conviction and tighter stops

**Rule:** Only enter during regular market hours (9:30 AM - 4:00 PM ET)
- Best liquidity and tightest spreads
- Avoid first 15 minutes (9:30-9:45) — too volatile for micro-accounts
- Avoid last 15 minutes (3:45-4:00) — spreads widen

---

## Exit Rules

**Rule:** Take profit at +40-60%
- +40%: Begin looking to close
- +50%: Strong close signal — lock it in
- +60%: Hard exit — don't get greedy on a $30 bet
- Partial exits not practical with 1 contract — it's all or nothing

**Rule:** Stop loss at -35%
- Hard stop: If position is down 35% of debit paid, close immediately
- On a $30 spread, that's a $10.50 loss — painful but survivable
- NEVER hold to expiration hoping for recovery

**Rule:** Time stop at 50% of DTE elapsed
- If a 30 DTE trade hasn't moved by day 15, close it
- Theta is accelerating and thesis may be wrong
- Take whatever is left rather than watching it decay to zero

**Rule:** Close before weekends if position is down
- Don't hold losing positions over weekends — gap risk destroys micro-accounts
- Exception: Winners can hold over weekends if thesis is intact

---

## Risk Management

**Rule:** Maximum -10% account loss per day
- On $100 live: If account drops to $90, stop trading for the day
- On paper: Same discipline — treat it like real money
- Reset: Come back next session with clear analysis of what went wrong

**Rule:** Maximum -20% account drawdown before full stop
- If account drops from $100 to $80, cease ALL trading
- Review every trade in the log
- Identify pattern: Was it strategy failure or execution failure?
- Only resume after documenting what changed

**Rule:** No revenge trading
- After a loss, wait minimum 24 hours before next entry
- Autonomous agent should enforce this via cooldown timer
- Emotional re-entry after stops is the #1 micro-account killer

**Rule:** Track every trade in the activity log
- Entry price, exit price, P/L, thesis, what went right/wrong
- After 30 trades, calculate: win rate, avg win, avg loss, profit factor
- Only go live if profit factor > 1.2 and win rate > 40%

---

## Agent Behavior

**Rule:** Heartbeat schedule
- Pre-market (8:00-9:30 AM ET): 15 min intervals — scan news, identify setups
- Market open (9:30-9:45 AM): NO TRADES — observe only
- Active trading (9:45 AM - 3:45 PM): 10 min intervals — check signals, manage position
- Market close (3:45-4:00 PM): 5 min intervals — decide hold vs. close
- After hours: 60 min intervals — review only, no trades
- Weekends: 4 hour intervals — research and strategy review only

**Rule:** Maximum 2 trades per day (1 entry + 1 exit, or 2 exits)
- Micro-accounts cannot afford frequent trading
- Quality over quantity — wait for the A+ setup

**Rule:** Agent must state thesis before every trade
- Log to `decisive_actions/` before placing any order
- Format: "Buying [spread] because [technical signal] + [catalyst/news]"
- If agent cannot articulate clear thesis, DO NOT TRADE

**Rule:** Paper trading mode by default
- Agent starts in paper mode always
- Live trading requires explicit manual override
- Agent should never switch itself to live mode

---

## Weekly Review (Sunday)

**Rule:** Review all trades from the week
- What worked: Which setups delivered
- What didn't: Losses, missed exits, bad entries
- Strategy adjustment: Update rules based on actual results

**Rule:** Track these metrics weekly

| Metric | Target |
|--------|--------|
| Win rate | >40% |
| Avg win | >$15 |
| Avg loss | <$12 |
| Profit factor | >1.2 |
| Max drawdown | <20% |
| Trades/week | 2-5 |

---

## Graduation Criteria (Paper → Live)

- [ ] 30+ paper trades completed
- [ ] Profit factor > 1.2
- [ ] Win rate > 40%
- [ ] Max drawdown < 20%
- [ ] No revenge trades in last 10 trades
- [ ] Agent thesis accuracy > 50% (did the market move in predicted direction?)
- [ ] All trades logged with complete entry/exit rationale

**When all boxes are checked, fund Alpaca live account with $100 and switch endpoint.**

---

## Pre-Trade Checklist (Agent Must Verify)

- [ ] Only 0 or 1 open positions?
- [ ] Position cost < 30% of account?
- [ ] DTE between 14-45?
- [ ] Bid-ask spread < 15% of mid?
- [ ] Open interest > 100 on both legs?
- [ ] 2 of 3 technical signals confirmed?
- [ ] No major catalyst in next 24h (unless thesis)?
- [ ] Clear thesis documented?
- [ ] Within trading hours (9:45 AM - 3:45 PM ET)?
- [ ] Not in 24h cooldown from last loss?

**If any answer is NO, do not trade.**

---

**The goal is not to get rich on $100. The goal is to build a proven, autonomous system that survives and compounds. Scale comes after the system proves itself.**
