# Consolidation / expansion paper entry revision

Status: implemented for validation, **disabled by default**, not activated on the VPS. Version: `consolidation-expansion-entry-v1`. These are independently specified mechanical hypotheses. They do not reproduce an unavailable video indicator and do not establish profitability or daily trade frequency.

## Entry contract

All four accounts retain separate state and journals, $50,000 initial paper balances, existing realized balances, account floors, daily loss limits and risk admission. Nothing resets a balance, inserts historical fills, or changes captured open-position stops and exits. RUNNER and its launch schedule are unchanged.

The shared test uses 37 consecutive completed bars: 20 baseline, 16 compression, one expansion. Mean compression range must be at most 0.85 times baseline; expansion range at least 1.15 times compression; body at least 55% of expansion range. A long expansion must close at least one tick above the compression high with a positive body; shorts mirror this. Missing, duplicate, reversed, invalid, misaligned or mixed-contract bars cannot qualify. Expansion evidence is frozen at the breakout, before its retest.

| Strategy | Actual additional entry route | Controls retained |
| --- | --- | --- |
| DMC Gain + Retest | Completed M5 collection / M15 baseline expansion from a compression box containing an eligible H1 pivot. Allows a candle opening beyond that pivot, which the old crossing rule excludes. | Hourly direction, fresh level, 2-22 point structural stop, nearest structural target offering at least 1.5R after costs, future limit retest, 15-minute expiry, one filled trade per day. |
| 15M Opening Range Retest | M1 expansion continuation across the opening-range edge without a new prior-close crossing. | Exact 09:30-09:44 opening data, aligned completed M5 order flow, first contiguous level-holding retest within ten elapsed minutes, no intervening invalidation. Explicit future limit execution; reject structural stops exceeding 20 points. |
| EMA 20/60 Momentum | Completed M15 expansion with aligned EMA20/60 and rising/falling EMA20 over five bars, even without a fresh crossover. | 62 completed M15 bars, cash window, hard risk admission, bounded future execution. Existing valid crossovers remain available. |
| Fresh Level Retest | First CE-qualified M5 breakout can wait 45 minutes for its first M1 retest, instead of 30. | Ordinary breakouts retain 30 minutes; no second break rearming, prior touch, intervening invalidation or data gap; confirmed fresh target at least 1.5R after costs and existing daily stopping rules. |

Completed-bar and retest chronology repairs apply to the targeted detectors even while additional CE entries are disabled. DMC level freshness begins when the right-hand H1 confirmation completes, rather than consuming a level while it is still unknown. The failed-level variant receives this freshness correction; it receives no CE continuation entry. DMC Market Open has no new entry rule in this revision.

## Why DMC may remain inactive

The October 22, 2026 11:57 a.m. Pacific remote-bridge snapshot showed running, flat watchers: Market Open 0 lifetime trades, Gain + Retest 2, Failed-Level Reversal 4. Gain/reversal rejection histories were dominated by missing eligible hourly pivot reactions. Market Open's cumulative histogram included pre-open ATR gating; current source already bypasses that particular gate under the collection profile. A cumulative histogram cannot prove which rule is blocking today's latest prefix or which source is currently loaded. Check source hashes, configuration and current replay on the VPS.

The EMA audit also records minimum-contract risk rejections. This revision does not increase the risk budget to force an NQ contract through. A daily scan is expected; a daily fill is not guaranteed.

## Validation on the VPS

Stage this revision separately from the running checkout first. Do not overwrite a running checkout or restart accounts with open or pending plans. Use the existing checkout path verified by `pwd` and `git remote -v`; the older OpenClaw path is not a current deployment attestation.

From the staged revision:

```bash
# Supply the actual existing runtime checkout, not the staging folder.
LIVE_ROOT=/absolute/path/to/existing/trading
bash scripts/activate-entry-rules.sh --runtime-root="$LIVE_ROOT"
```

Despite its name, this shell command **only runs tests and validation**. It neither changes configuration nor starts/stops watchers. It returns nonzero when the validation gate fails and explicitly reports that activation was not performed on success. No dependency installation is needed for these Node tests.

For diagnostics without a strict activation gate:

```bash
node scripts/validate-entry-rollout.cjs --runtime-root="$LIVE_ROOT"
```

The CLI reads actual cache and six existing account states. It compares identical completed prefixes with additional CE entries off versus on. It reports signal opportunities and rejection reasons, not submitted orders, fills or P&L. It independently evaluates each prefix with empty hypothetical trade history; repeated signals are not distinct trades. Source hashes bind the inspected entry/configuration files. An optional `--baseline-root=/absolute/prior/checkout` compares prior source with current configuration instead. Prior commit `3fe191f` contains three malformed newline string literals in `lib/live-trader.cjs`; that unmodified source cannot load. Any baseline-only syntax normalization must be explicitly disclosed.

Strict validation requires current actual Databento cache metadata, sufficient session context, valid isolated $50k account initializations, flat account states, recognized Linux process identity, stable state-file hashes during inspection, and at least one newly enabled CE opportunity for **each** of the four targets. A short cache may fail that last requirement even when unit tests pass. Collect a suitable actual sample; do not substitute synthetic candles or bypass the gate. `--as-of=...` permits historical diagnostics but cannot approve present activation. `--require-running` additionally requires exactly one healthy, fresh watcher per inspected account; omit it during a coordinated stopped maintenance window.

## Operator-controlled activation after validation

The automated scripts deliberately do not assume how this VPS supervises watchers. Before loading the revision, inhibit the actual watchdog and the affected watcher supervisors in a coordinated flat window, gracefully stop the affected watchers, and confirm no supervisor can recreate them. Keep the shared market-data feed and unrelated strategies running. Repeat strict validation against the stable account files, then back up configuration and the six state files outside the repository. If any account has an open or pending plan, let the old watcher finish; do not force-close it for this release.

Only after the strict gate passes, install the reviewed source and enable additional entries in that stopped checkout:

```bash
node -e 'const fs=require("node:fs");const p="config.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));c.live.consolidationExpansion={enabled:true};fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");'
```

Restart only the previously active affected watcher services using their existing service definitions. Restore the watchdog after confirming one process per account. Verify advancing heartbeats, scan-audit version `consolidation-expansion-entry-v1` for the four target accounts, unchanged balances/trade histories at restart, new diagnostics, and no duplicate feed/watchers. Then restore ordinary supervision. The two diagnostic DMC accounts retain their own rules versions. Keep the state/configuration backups and validation report. Do not use a reset option.

If any gate fails, retain the currently running revision or restore the backed-up source/configuration before resuming watchers. Account history must never be rolled backward as a source-code rollback mechanism.

Actual VPS cache replay, supervisor control, deployment, activation and post-restart observation have not been performed by this change's author. Local synthetic tests verify implementation mechanics; they do not establish an edge or promise trades tomorrow.

## Local release evidence

- Original `3fe191f` failed to load because three string literals in `lib/live-trader.cjs` contained literal line breaks. Repairing only those strings established a loadable baseline: 32 focused tests plus two OR/EMA legacy tests passed before the entry revision.
- Final 12-file targeted run: 84 passed, one failed locally because Windows denied a symlink operation in the Linux `/proc` lock-ownership fixture (`EPERM`). The failing test is retained unchanged and must pass on the VPS. One additional mirrored DMC baseline M15 case and two named OR/EMA legacy tests passed after the changes: 87 passes in total, one platform failure. No full build, dependency installation or whole-repository test suite was run.
- Eight fixed synthetic cases, one long and one short for each strategy: original source with only the documented syntax repairs produced 0 signals; revised source produced 8. These are deliberately constructed acceptance cases, not market trade counts. Feature-off comparisons also pass for all four routes.
- New rule suite: 14 passing tests, including numeric boundaries, mirrored signals, direct/dispatcher equality, non-repainting as-of prefixes, first-touch/invalidation, structural risk rejection, stale M15 and no historical fill. Six release-safety tests cover account isolation, captured exits, state persistence and validation refusals. Independent review found no remaining blocking source defect and separately checked 26 assertions.
- Shell syntax and changed-source syntax passed. The actual-cache CLI refused this workstation's absent live cache instead of generating market evidence. No watcher, feed or server was started locally.
