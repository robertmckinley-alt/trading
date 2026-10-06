# Operational audit — 2026-10-06

## Verdict

Not cleared for live-money trading. Operational health and profitable strategy evidence are separate gates. These checks do not certify broker execution or guarantee that a running process is producing correct signals.

## Verified evidence

- The DMC reversal, DMC gain/retest, and Fresh Level Retest workers recovered after the ownership-lock repair. New PIDs 6519, 6520, 6526 were healthy with current candles at the 18:00 UTC check.
- 220 Node tests passed after the order-window and lock fixes. Python feed-watchdog tests: 10 passed. Feed-cache tests: 5 passed.
- Across the 114 futures trades exposed by the dashboard at that check, trade IDs were unique, visible trade sums matched reported realized P&L, and checked fill/exit/observation timestamps were ordered correctly. This is not an independent price or broker-fill reconciliation.
- ORB forward runner was updating ten accounts with fresh candles.
- Chaintape large/meme entry and marking jobs, Polymarket, all four TAP accounts, and Crypto Flow had recent execution evidence. Meme recorded a WIF paper round trip, closed with -$9.72 after modeled costs.
- The new monitor was run against all four production endpoints without sending messages. It detected the stale gold/challenger/coordination workers and unstarted HMM experiment.

## Open defects and evidence gaps

1. Gold Open EMA12 was missing with its last heartbeat at 16:04 UTC. The balanced-regime POC challenger was stale since October 5. Verify recovery and continued supervision; do not infer they recovered from the DMC restart.
2. The coordination observer last updated October 5 at 18:17 UTC. Its zero comparisons are not evidence that the controller watched the full session.
3. HMM experiment reports not-started. The local audit environment also cannot run its Python tests because hmmlearn is absent. VPS training dependencies and model artifacts need direct verification. Do not treat HMM as protecting entries.
4. The original cause of the simultaneous watcher exits is unknown. Logs prove stale-lock restart failures, not the event that killed the original workers. Host/container restart history and OOM evidence are needed.
5. Live dashboard process counts are not proof of order correctness. Yesterday's DMC expired orders have not been independently replayed against their full saved order details and candles.
6. Futures portfolio risk snapshot silently skips unreadable state files. This should fail closed before any real-money integration. Current risk controls and tests are paper simulation controls, not verified broker protections.
7. ORB feed metadata advertises no dollar risk cap, whereas execution code has structural stop/risk checks. Metadata needs reconciliation with the account's actual frozen execution configuration. Its feed process count includes multiple instruments; two does not prove duplicate NQ feeds.
8. Chaintape dashboard catches some database failures and returns empty arrays. Provider booleans indicate configuration, not successful provider health. Empty results can conceal a data outage.
9. Chaintape large book intentionally sets consecutive-loss reduction/pause thresholds to 99, effectively disabling those brakes under its daily entry limit. This is a research setting, not live approval. Daily/book loss checks remain present.
10. Crypto paper stops use periodically observed prices. Intraminute excursions, real order acceptance, liquidity, and exchange-side stop handling are not independently verified. The position insertion transaction checks open-position count and duplicates, but the daily/loss evaluation occurs outside that transaction; concurrency review is needed before live use.
11. Backtest production endpoint verification did not complete via the connected fetch tool. Read cached result/progress and provenance on the VPS; do not initiate paid historical downloads as a diagnostic.
12. The 15-minute monitor checks operational telemetry. It cannot establish strategy profitability, detect every trading-logic error, or alert through Telegram if Telegram itself is unreachable. A complete VPS failure also stops this host monitor; external uptime supervision is still needed.

## Install alerts

Run `scripts/install-operations-monitor-host.sh` as root on the VPS host. It reads the existing Telegram configuration from the container into a root-only host file and requires successful test delivery before installing cron. Never paste credentials into chat.

The monitor checks the futures live-status endpoint, Chaintape dashboard, TAP, and Crypto Flow at minutes 00, 15, 30, and 45. It alerts on changed incident sets, reminds hourly while incidents persist, and sends an all-clear on recovery. It never places orders, edits journals, or changes strategy rules. A quiet no-signal period or risk-induced pause alone is not a system failure.

Read-only VPS evidence: `node scripts/diagnose-operations.cjs`. Inspect `/var/lib/trading-monitor/state.json` and `/var/log/trading-operations-monitor.log` on the host for monitoring results. Use a separate external uptime monitor for whole-host failure detection.

## Before any live-money trial

Resolve the open defects; replay order timing against captured candles; exercise disconnect, restart, stale data, duplicate execution, corrupt state, and kill-switch scenarios; reconcile broker orders/fills/positions against journals; and validate exchange-side stops and loss caps in the intended broker's test environment. Operational tests alone do not establish positive expected returns.

## Follow-up repair prepared

`scripts/repair-remaining-workers-host.sh` repairs existing challenger supervision, restarts the coordination observer using verified process identity, and enables HMM after validating a trained model. The ordinary strategy watchdog now includes registered challenger accounts and supervises already-enabled auxiliary workers. The repair uses an isolated Python 3.12 Docker container for training, avoiding the unavailable ensurepip package in OpenClaw. Only cached history is used; insufficient input stops training. It preserves existing models, journals, and balances. All 220 Node tests pass. Production recovery still requires the host command and subsequent heartbeat verification.
