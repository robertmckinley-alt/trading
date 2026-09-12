const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { groupTradingDays } = require('./backtest-engine.cjs');
const { session, VERSION } = require('./orb-session.cjs');

function backtestProvenance(candles, window) {
  const code = createHash('sha256');
  for (const name of ['backtest-engine.cjs', 'backtest-service.cjs', 'backtest-provenance.cjs', 'backtest-validation.cjs', 'trader-core.cjs', 'live-trader.cjs', 'dmc-market-open.cjs', 'strategy-registry.cjs', 'orb-learning.cjs', 'orb-session.cjs', 'orb-discovery.cjs', 'historical-data.cjs']) {
    code.update(name).update(fs.readFileSync(path.join(__dirname, name)));
  }
  const data = createHash('sha256');
  for (const file of ['vwap-stretch.cjs','vwap-backtest.cjs']) code.update(fs.readFileSync(path.join(__dirname,file)));
  code.update(fs.readFileSync(path.join(__dirname, 'price-action-patterns.cjs')));
  for (const candle of candles) data.update(JSON.stringify(candle)).update('\n');
  const sessions = groupTradingDays(candles).filter(([date, records]) => session(date).open && records.some((record) => record.minute >= 570 && record.minute < session(date).closeMinute));
  const tradingDates = sessions.map(([date]) => date);
  const issues = [];
  for (const [date, records] of sessions) {
    const expected = session(date).closeMinute - 570;
    const minutes = new Set(records.filter((record) => record.minute >= 570 && record.minute < session(date).closeMinute).map((record) => record.minute));
    if (minutes.size !== expected) issues.push(`${date}: ${minutes.size}/${expected} cash-session minutes; missing data or partial session.`);
  }
  const known = new Set(tradingDates);
  // A reviewed closure is not a missing session. Unsupported years fail closed.
  for (let time = Date.parse(window.start.slice(0, 10)); time < Date.parse(window.end.slice(0, 10)); time += 86400000) {
    const day = new Date(time);
    const date = day.toISOString().slice(0, 10);
    if (!session(date).known || (session(date).open && !known.has(date))) {
      issues.push(`${date}: missing cash session or unsupported calendar date.`);
    }
  }
  return { executionVersion: 'orb-execution-v3-cash-session', calendarVersion: VERSION, codeHash: code.digest('hex'), dataFingerprint: data.digest('hex'),
    tradingDates, coverage: { complete: issues.length === 0 && sessions.length > 0, issues,
      scope: 'Reviewed 2025/2026 cash-session calendar, including early closes. Not a full CME-hours audit.' } };
}

module.exports = { backtestProvenance };
