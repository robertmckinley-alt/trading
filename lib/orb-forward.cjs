const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { BACKTEST_STRATEGIES } = require('./strategy-registry.cjs');
const { detectSignalFromCandles, prepareOrbResearchContext } = require('./live-trader.cjs');
const { buildOneContractResearchPlan } = require('./backtest-engine.cjs');
const { trackTradeLifecycle, toJournalTrade } = require('./trader-core.cjs');

const DEFINITIONS = BACKTEST_STRATEGIES.filter(s => s.slug.startsWith('nq-15m-orb-'));
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function parts(at) {
  const p = Object.fromEntries(formatter.formatToParts(new Date(at)).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function version(config) {
  const hash = createHash('sha256').update(JSON.stringify(config));
  for (const file of ['orb-forward.cjs', 'live-trader.cjs', 'trader-core.cjs', 'strategy-registry.cjs', 'backtest-engine.cjs']) hash.update(fs.readFileSync(path.join(__dirname, file)));
  return hash.digest('hex').slice(0, 16);
}
function createState(config, now = Date.now()) {
  return { version: version(config), startedAt: new Date(now).toISOString(), cursor: null,
    heartbeat: null, status: 'waiting-for-feed', accounts: DEFINITIONS.map(s => ({
      slug: s.slug, name: s.name, trades: [], attempts: [], active: null, consumedDay: null,
      netPnlUsd: 0, equityPeakUsd: 0, maxDrawdownUsd: 0, markPeakUsd: 0, markDrawdownUsd: 0
    })) };
}
function mergeCandles(...arrays) {
  return [...new Map(arrays.flat().map(c => { const timestamp = new Date(c.timestamp).toISOString(); return [timestamp, { ...c, timestamp }]; })).values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
// Read only the matching, checksummed cache. No historical API requests and no orders from warmup.
function readWarmup(root, config, now = Date.now()) {
  const identity = JSON.stringify({ version: 1, dataset: config.live.dataset || 'GLBX.MDP3', symbol: config.live.ticker || 'NQ.v.0', schema: 'ohlcv-1m', stype: 'continuous' });
  const dir = path.join(process.env.HISTORICAL_CACHE_DIR || path.join(root, 'runtime', 'historical-candles'), createHash('sha256').update(identity).digest('hex'));
  const candles = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const day = Date.parse(name.replace('.json', ''));
    if (!Number.isFinite(day) || day < now - 75 * 86400000 || day >= now) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, name)));
      if (saved.identity === identity && saved.checksum === createHash('sha256').update(JSON.stringify(saved.candles)).digest('hex')) candles.push(...saved.candles);
    } catch { /* Unusable warmup stays unavailable; never invent features. */ }
  }
  return mergeCandles(candles).filter(c => Date.parse(c.timestamp) + 60000 <= now);
}
function advance(state, incoming, history, config, now = Date.now(), deps = {}) {
  const candles = mergeCandles(incoming).filter(c => Date.parse(c.timestamp) + 60000 <= now);
  state.heartbeat = new Date(now).toISOString();
  if (!candles.length || now - Date.parse(candles.at(-1).timestamp) > 180000) {
    state.status = 'waiting-for-fresh-feed';
    return state;
  }
  state.status = 'running';
  state.latestCandleAt = candles.at(-1).timestamp;
  if (!state.cursor) { state.cursor = candles.at(-1).timestamp; return state; }
  const detect = deps.detect || detectSignalFromCandles;
  const build = deps.build || buildOneContractResearchPlan;
  const replay = deps.replay || trackTradeLifecycle;
  const pending = candles.filter(c => Date.parse(c.timestamp) > Date.parse(state.cursor));
  for (const candle of pending) {
    const at = Date.parse(candle.timestamp);
    const p = parts(at);
    for (const account of state.accounts) {
      if (!account.active) continue;
      const active = account.active;
      const previous = active.candles.at(-1)?.timestamp || active.plan.setup.signalAvailableAt;
      if (at >= Date.parse(active.plan.setup.signalAvailableAt) && at - Date.parse(previous) > 60000) active.dataGap = true;
      active.candles.push(candle);
      const result = replay(active.plan, active.candles, config, { researchFixedContracts: 1, closeOpenAtEnd: p.minute >= 960 || p.date !== active.day });
      active.result = result;
      if (result.filledAt) account.consumedDay = active.day;
      if (result.status === 'closed') {
        const trade = { ...toJournalTrade(active.plan, result), id: `${account.slug}-${active.observedAt}`, evidenceType: 'forward-paper', rulesVersion: state.version, observedAt: active.observedAt, dataQuality: active.dataGap ? 'gap-review-required' : 'complete' };
        account.trades.push(trade);
        account.netPnlUsd += result.realizedPnlUsd;
        account.equityPeakUsd = Math.max(account.equityPeakUsd, account.netPnlUsd);
        account.maxDrawdownUsd = Math.max(account.maxDrawdownUsd, account.equityPeakUsd - account.netPnlUsd);
        account.active = null;
      } else if (result.status === 'not-filled' && result.exitReason !== 'entry never traded') {
        account.attempts.at(-1).outcome = result.exitReason;
        account.active = null;
      }
      const equity = account.netPnlUsd + (account.active?.result?.unrealizedPnlUsd || 0);
      account.markPeakUsd = Math.max(account.markPeakUsd, equity);
      account.markDrawdownUsd = Math.max(account.markDrawdownUsd, account.markPeakUsd - equity);
    }
    // Only a newly observed, fresh confirmation can place an order. Recovery never backdates orders.
    if (p.minute % 15 === 14 && p.minute >= 599 && p.minute <= 689 && now - (at + 60000) < 60000) {
      const available = mergeCandles(history, candles).filter(c => Date.parse(c.timestamp) <= at);
      const context = (deps.context || prepareOrbResearchContext)(available);
      state.warmupCandles = available.length;
      for (const account of state.accounts) {
        if (account.active || account.consumedDay === p.date || account.attempts.some(a => a.candleAt === candle.timestamp)) continue;
        const signal = detect(available.slice(-2500), { ...config, strategySlug: account.slug, orbResearchContext: context }, { trades: [] });
        account.lastDecision = { at: state.heartbeat, reason: signal.reason || (signal.found ? 'Signal accepted' : 'No qualifying signal') };
        if (!signal.found) continue;
        const plan = build(signal, config);
        const observedAt = new Date(now).toISOString();
        // A completed bar arrives after its close: enter at the NEXT still-unseen minute open.
        plan.setup.signalAvailableAt = new Date(Math.ceil(now / 60000) * 60000).toISOString();
        plan.setup.orderExpiresAt = new Date(Math.ceil(now / 60000) * 60000 + 120000).toISOString();
        account.attempts.push({ candleAt: candle.timestamp, observedAt, outcome: 'submitted' });
        account.active = { plan, day: p.date, observedAt, candles: [], dataGap: false, result: null };
      }
    }
    state.cursor = candle.timestamp;
  }
  return state;
}
function snapshot(root) {
  const file = path.join(root, 'runtime', 'orb-forward', 'state.json');
  if (!fs.existsSync(file)) return { status: 'not-started', accounts: DEFINITIONS.map(s => ({ slug: s.slug, name: s.name })) };
  try {
    const state = JSON.parse(fs.readFileSync(file));
    return { version: state.version, startedAt: state.startedAt, heartbeat: state.heartbeat, latestCandleAt: state.latestCandleAt,
      status: Date.now() - Date.parse(state.heartbeat || state.startedAt) > 90000 ? 'runner-offline' : state.status,
      accounts: state.accounts.map(a => ({ slug: a.slug, name: a.name, netPnlUsd: a.netPnlUsd,
        maxDrawdownUsd: a.maxDrawdownUsd, markDrawdownUsd: a.markDrawdownUsd,
        closedTrades: a.trades.length, verifiedTrades: a.trades.filter(t => t.dataQuality === 'complete').length,
        trades: a.trades, lastDecision: a.lastDecision, active: a.active ? { side: a.active.plan.setup.side, stop: a.active.plan.setup.stop, status: a.active.result?.status || 'pending', unrealizedPnlUsd: a.active.result?.unrealizedPnlUsd || 0 } : null })) };
  } catch { return { status: 'state-unavailable', accounts: [] }; }
}
module.exports = { DEFINITIONS, atomic, version, createState, mergeCandles, readWarmup, advance, snapshot };
