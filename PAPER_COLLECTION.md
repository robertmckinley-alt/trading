# Forward paper collection v2

Rules version: `paper-collection-v2-2026-10-02`. Enabled by the user's explicit request to adjust accounts with zero or one total trade. These are independent, unvalidated adaptations, not original creator bots or verified profitable methods. They remain paper-only.

## Rule changes

All times are New York. Only completed candles qualify. Cash holidays and early closes apply.

| Account | Change from baseline | What remains required |
| --- | --- | --- |
| H: DMC Market Open | Completed cash-opening M5 reaction at a confirmed H1 body pivot; checks through 11:24 instead of 10:24. Wick-heavy pre-open context is neutral, not a directional veto. M5 body ≥35%, adverse wick ≤45%. Entry on a future observable market bar; stop beyond the last three completed execution minutes rather than the whole pre-open hour. | Correctly completed pre-open H1 context, 0.35–2 ATR pre-open range, no conflicting reactions/range lock, 2–22 point structural stop, ≥1.5R after modeled costs to an observed structural target. Entire position exits at that target. |
| I: HTF Session Sweep | Entry window extends from 08:00–11:30 to 08:00–15:30. Stop beyond the completed M5 rejection rather than the entire London extreme. | One-sided London raid of Asia, aligned completed hourly direction, completed M5 rejection, fresh M1 structure break, 2–24 point stop. No new entries near scheduled close; intraday flatten. |
| J: VWAP Stretch | Market-order deadline allows six minutes from the trigger rather than two, bounded by scheduled flatten. | Long-only fresh 2 ATR VWAP stretch, complete cash-session history, two net losses pause the session, 5% starting-balance floor. |
| K: DMC Failed-Level Reversal | M5 confirmations instead of M15; checks 09:44–15:29, retest orders expire within 15 minutes and no later than 15:45. At most one prior completed M15 touch episode after pivot confirmation. Last completed H1 determines direction. | Completed H1 body pivot, directional failure/rejection, 0.35–2 M5 ATR, 2–22 point structural stop, future exact-level retest, ≥1.5R after costs, one filled trade/day. |
| L: DMC Gain + Retest | Same cadence, window and pivot-test changes as K. | Confirmed gain/loss of a body pivot, last completed H1 aligned, body ≥50% of range, structural stop/target, future exact-level retest, ≥1.5R after costs, one filled trade/day. |

H/K/L may use an already observed hourly swing when no eligible opposing body-pivot target exists. No target is invented. H1 context is capped at 48 completed hours. Baseline detector tests remain. Setting `live.paperCollection.enabled` false restores baseline entry rules; operational execution fixes remain.

## Fleet reliability and evidence

- One writer lock per live feed cache. Exact process matching prevents a watchdog/systemd duplicate writer.
- Retain up to 4,800 valid minute bars from the exact existing LIVE stream across reconnects. Never warm the live cache from historical research files or a different instrument.
- Watchers receive up to 2,880 bars instead of 1,200. This also addresses EMA 20/60 warmup shortfalls.
- All 13 watchers poll every 60 seconds around the clock. Entry windows still govern when an individual setup can trade.
- Evaluate unseen, completed, still-fresh bars between polls. Discard bars older than the three-minute freshness limit instead of backfilling missed trades.
- Every new plan's fill availability starts on a complete future minute after actual observation. Market gaps are resized or rejected by the existing risk engine; no retroactive fills.
- The dashboard exposes observed candle counts, eligible sessions/checks, qualified setups, paper orders, unfilled orders, order blocks and feed/run errors. Tracking starts at deployment, not an inferred past activation date. Each journaled trade carries the rule version and observation time.

## Risk and evaluation

Existing per-account dollar limits, loss floors, adaptive risk vetoes, correlation limits and the $2,500 shared simultaneous-risk cap remain. No account-size increase, averaging down, broker connection, journal reset, or forced daily trade is authorized.

The saved September 4–October 1 development replay was used to assess feasibility and frequency, not profitability. It evaluates the first signal per recorded date and does not reproduce actual live latency, adaptive account state or shared-risk competition. It is not an untouched holdout. Hypothetical fills never enter the forward journal.

Forward evidence starts with this version. Interpret zero trades using eligible checks, signal counts and exact block reasons, not calendar age alone. Reject stale/incomplete data, invalid structural risk or unavailable account risk even if that reduces trade frequency. An automatic economic-calendar blackout is not connected; manual DMC blackout dates remain supported.
