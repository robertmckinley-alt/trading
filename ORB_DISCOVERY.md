# Daily ORB discovery

The VPS daily backtest worker now evaluates up to four of twelve preregistered,
one-factor ORB variations. It reuses the candles already loaded for the 2025-to-present
backtest. There are no additional discovery downloads, model subscriptions, or
generated executable-code inputs. Completed trials are not silently retuned.

The `/orb` page shows the daily report, every attempted variation, baseline
comparison, doubled-cost result, rejection reason, and forward monitoring.
The twelve trials cover confirmation times, candle body, relative volume / range
ATR, and whole-contract target exits. After all twelve, research generation stops;
daily reports and forward monitoring continue. A new search generation needs review.

## Evidence and paper qualification

2025 is the training period and 2026 is the chronological test period. These dates
have already informed our strategy design. They are retrospective diagnostics,
not an untouched holdout or a calibrated confidence score. The complete twelve-trial
search space is registered before evaluation, including losers and failures.

Paper candidates require complete cash-session coverage, known costs, at least
50 training trades and 20 test trades, positive training/test expectancy, positive
test expectancy at doubled costs, test profit factor >= 1.2 (or no losses with
positive profit), and higher test-period net P&L than the unchanged baseline.
These are screening thresholds, not a multiple-testing-adjusted significance claim.
No accumulated loss limit or dollar risk cap truncates the one-contract research.

At most four qualifying candidates, in preregistered order, are attached to the
existing ORB supervisor as separate $50,000 paper accounts. Matching an existing
paper variant's full historical trade sequence suppresses duplicate provisioning.
Each candidate freezes its configuration and implementation fingerprint. Repeated
polling/restarts cannot recreate it. Code changes pause new research-account entries
for review. Existing active positions remain managed. No live-money deployment.

The daily monitor excludes gap-affected trades, requires 20 complete observations,
and flags nonpositive recent expectancy for review. It does not delete accounts,
rewrite strategies, or claim 50 observations establishes profitability.

## Session repair

Cash-open ORBs skip cash holidays and flatten at the end of the final cash-session
minute, including shortened days. This is a cash-ORB policy, not a CME trading-hours
calendar. If the scheduled bar is missing, the next observed bar's open is used
with adverse slippage, before evaluating its high/low targets. The delayed exit
is explicitly flagged for review and never counted as data-complete evidence.
Old journals, including the September 7 trades, are retained unchanged.

Calendar coverage is limited to reviewed 2025/2026 dates. Unsupported years block
new cash-ORB signals until reviewed. Sources:
- https://www.nyse.com/trade/hours-calendars
- https://ir.theice.com/press/news-details/2022/NYSE-Group-Announces-2023-2024-and-2025-Holiday-and-Early-Closings-Calendar/default.aspx
- https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx

## Operations

Deploy inside the existing container, retaining state:

```sh
cd /data/.openclaw/workspace/lucid-nq-paper-trader || exit 1
git pull --ff-only origin main &&
node scripts/orb-forward-paper.cjs --restart &&
node scripts/restart-status-server.cjs
```

An already-current backtest can wait until its next daily refresh. Use the existing
authenticated backtest refresh control to request an earlier run. Do not start
duplicate workers. A status-server restart can interrupt an in-progress backtest.

Files under `runtime/orb-discovery/`: `ledger.json` (preregistration and all attempts),
`trials/` (full immutable evaluation evidence), `reports/YYYY-MM-DD.json` (latest
daily report), and `paper-candidates.json` (qualified paper-only manifests).
`run.lock` prevents concurrent discovery writes; after a crash verify the recorded
process has stopped before removing a stale lock. Interrupted attempts stay marked
`testing` for review rather than automatically consuming a second test of the same idea.
The worker exposes candidate-level progress through the existing backtest progress API.

Keep these runtime files and `runtime/orb-forward/` on the persistent VPS volume.
Do not reset the ledger or erase failed trials to get past a validation gate.
