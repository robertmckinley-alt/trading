// Independent mechanical interpretations of the supplied cheat sheet.
// All inputs are completed one-minute bars. No retrospective pivot timestamps.
const SLUGS = ['nq-15m-orb-qm-retest', 'nq-15m-orb-sr-flip', 'nq-15m-orb-compression'];
const RULES = Object.freeze({ version: 'price-action-v1', barMinutes: 5, pivotLeft: 1, pivotRight: 1,
  retestBars: 6, zoneTicks: 1, rewardRisk: 2, latestMinute: 689 });
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function parts(at) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: +p.hour * 60 + +p.minute };
}
function barsForDay(candles) {
  if (!candles.length) return [];
  const date = parts(candles.at(-1).timestamp).date;
  const records = candles.filter(c => parts(c.timestamp).date === date && parts(c.timestamp).minute >= 570);
  const groups = new Map();
  for (const c of records) {
    const slot = Math.floor(parts(c.timestamp).minute / 5) * 5;
    if (!groups.has(slot)) groups.set(slot, []);
    groups.get(slot).push(c);
  }
  const bars = [];
  for (const [minute, group] of groups) {
    if (group.length !== 5 || group.some((c, i) => parts(c.timestamp).minute !== minute + i)) continue;
    bars.push({ minute, timestamp: group[0].timestamp, endTimestamp: group[4].timestamp,
      open: group[0].open, close: group[4].close, high: Math.max(...group.map(c => c.high)), low: Math.min(...group.map(c => c.low)) });
  }
  return bars;
}
function pivots(bars) {
  const result = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const low = bars[i].low < bars[i - 1].low && bars[i].low < bars[i + 1].low;
    const high = bars[i].high > bars[i - 1].high && bars[i].high > bars[i + 1].high;
    if (low === high) continue; // Ambiguous outside bar is not an ordered pair of swings.
    result.push({ index: i, confirmedIndex: i + 1, type: low ? 'low' : 'high', price: low ? bars[i].low : bars[i].high });
  }
  return result;
}
function bullish(bars, kind, tick) {
  const last = bars.at(-1), n = bars.length - 1;
  const openHigh = Math.max(...bars.slice(0, 3).map(b => b.high));
  const openLow = Math.min(...bars.slice(0, 3).map(b => b.low));
  if (kind === 'qm-retest') {
    const swings = pivots(bars);
    for (let k = 0; k + 2 < swings.length; k++) {
      const [l, h, sweep] = swings.slice(k, k + 3);
      if (l.type !== 'low' || h.type !== 'high' || sweep.type !== 'low' || sweep.price > l.price - tick) continue;
      const breakIndex = bars.findIndex((b, i) => i >= sweep.confirmedIndex && b.close >= h.price + tick);
      if (breakIndex < 0 || breakIndex >= n || n - breakIndex > RULES.retestBars) continue;
      if (bars.slice(sweep.index + 1).some(b => b.low < sweep.price)) continue;
      if (last.low <= l.price + tick && last.close >= l.price + tick && last.close > last.open) {
        return { level: l.price, stop: sweep.price - tick, breakIndex, pivotConfirmedAt: bars[sweep.confirmedIndex].endTimestamp };
      }
    }
    return null;
  }
  for (let b = Math.max(3, n - RULES.retestBars); b < n; b++) {
    const trigger = bars[b], range = trigger.high - trigger.low;
    if (!(range > 0) || trigger.open > openHigh || trigger.close < openHigh + tick
      || (trigger.close - trigger.open) / range < .5) continue;
    if (kind === 'compression') {
      const coil = bars.slice(b - 4, b);
      if (coil.length !== 4 || b < 7 || coil.some((c, i) => i > 0 && (c.high > coil[i - 1].high || c.low <= coil[i - 1].low))
        || coil[3].high - coil[3].low > .6 * (coil[0].high - coil[0].low)
        || Math.abs(coil[3].high - openHigh) > .25 * (openHigh - openLow)) continue;
    }
    // A previous closing break back inside invalidates this breakout attempt.
    if (bars.slice(b + 1, n).some(c => c.close < openHigh - tick)) continue;
    if (last.low <= openHigh + tick && last.close >= openHigh + tick && last.close > last.open) {
      return { level: openHigh, stop: Math.min(last.low, openHigh) - tick, breakIndex: b };
    }
  }
  return null;
}
function detect(candles, slug, tick) {
  const reject = reason => ({ found: false, reason });
  if (!SLUGS.includes(slug) || !(tick > 0)) return reject('Unknown price-action experiment or invalid tick size');
  const latest = candles.at(-1);
  if (!latest) return reject('No completed candles');
  const p = parts(latest.timestamp);
  if (!require('./orb-session.cjs').session(p.date).open) return reject('No cash opening session');
  if (p.minute < 589 || p.minute > RULES.latestMinute || p.minute % 5 !== 4) return reject('Wait for a completed five-minute confirmation through 11:29 New York');
  const bars = barsForDay(candles);
  if (bars.length < 4 || bars[0].minute !== 570 || bars.at(-1).endTimestamp !== latest.timestamp
    || bars.some((b, i) => i > 0 && b.minute !== bars[i - 1].minute + 5)) return reject('Incomplete cash-session candles; pattern skipped');
  for (const direction of [1, -1]) {
    const transformed = bars.map(b => direction === 1 ? b : { ...b, open: -b.open, close: -b.close, high: -b.low, low: -b.high });
    const match = bullish(transformed, slug.replace('nq-15m-orb-', ''), tick);
    if (!match) continue;
    const entry = latest.close, stop = direction * match.stop;
    const risk = direction * (entry - stop);
    if (!(risk > 0)) continue;
    return { found: true, side: direction === 1 ? 'long' : 'short', entry, stop,
      targets: [entry + direction * RULES.rewardRisk * risk], date: p.date,
      triggerTimestamp: latest.timestamp, level: direction * match.level,
      breakAt: bars[match.breakIndex].endTimestamp, pivotConfirmedAt: match.pivotConfirmedAt || null, rules: RULES };
  }
  return reject('No confirmed pattern and timely retest under the frozen rules');
}
module.exports = { SLUGS, RULES, detect, pivots, barsForDay };
