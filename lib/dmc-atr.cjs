// Only reviewed regular NQ closures can bridge an ATR gap. No synthetic bars.
const { parts } = require('./session-quality.cjs');
const { session } = require('./orb-session.cjs');
const VERSION = 'dmc-session-atr-v1';
function minutePolicy(at) {
  const p = parts(at), day = new Date(p.date + 'T12:00Z').getUTCDay();
  const cash = session(p.date);
  if (!cash.known) return 'unknown';
  if (day === 6 || (day === 0 && p.minute < 1080) || (day === 5 && p.minute >= 1020)) return 'closed';
  if (day > 0 && day < 6 && (!cash.open || cash.closeMinute !== 960)) return 'unknown';
  if (p.minute >= 1020 && p.minute < 1080) return 'closed';
  // The 16:00 H1 bucket can be partial because of the equity-index halt.
  if (day > 0 && day < 6 && p.minute >= 975 && p.minute < 990) return 'closed';
  return 'open';
}
function atrEvidence(bars, period, raw = []) {
  const fail = (reason, gaps = []) => ({ version: VERSION, valid: false, value: null, reason, gaps });
  if (!Number.isInteger(period) || period < 1 || bars.length < period + 1) return fail('Insufficient complete bars for ATR');
  const rows = bars.slice(-period - 1), counts = new Map(), valid = new Set();
  for (const c of raw) {
    const at = Date.parse(c.timestamp);
    counts.set(at, (counts.get(at) || 0) + 1);
    if ([c.open,c.high,c.low,c.close].every(Number.isFinite) && c.high >= Math.max(c.open,c.close,c.low) && c.low <= Math.min(c.open,c.close,c.high)) valid.add(at);
  }
  let total = 0; const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const prior = rows[i-1], bar = rows[i], step = Number(bar.samples || 60) * 60000;
    const from = Date.parse(prior.timestamp) + step, to = Date.parse(bar.timestamp);
    if (![from,to,step,prior.close,bar.open,bar.high,bar.low,bar.close].every(Number.isFinite) || step <= 0 || step !== Number(prior.samples || 60) * 60000 || bar.high < Math.max(bar.open,bar.close,bar.low) || bar.low > Math.min(bar.open,bar.close,bar.high) || to < from || to-from > 4*86400000) return fail('Invalid ATR bars', gaps);
    if (to > from) {
      let closed = 0, observed = 0;
      for (let at = from; at < to; at += 60000) {
        const policy = minutePolicy(at);
        if (policy === 'unknown') return fail(`Unreviewed session gap at ${new Date(at).toISOString()}`, gaps);
        if (policy === 'closed') { closed++; continue; }
        if (counts.get(at) !== 1 || !valid.has(at)) return fail(`Missing or invalid trading minute at ${new Date(at).toISOString()}`, gaps);
        observed++;
      }
      if (!closed) return fail(`Unexplained missing aggregate at ${new Date(from).toISOString()}`, gaps);
      gaps.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), scheduledClosedMinutes: closed, observedOpenMinutes: observed });
    }
    total += Math.max(bar.high-bar.low, Math.abs(bar.high-prior.close), Math.abs(bar.low-prior.close));
  }
  const value = total / period;
  return value > 0 ? { version: VERSION, valid: true, value, reason: 'Complete bars with reviewed session continuity', gaps } : fail('ATR is not positive', gaps);
}
module.exports = { VERSION, atrEvidence, minutePolicy };
