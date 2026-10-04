// Observational controller. This module never writes account state or places orders.
const { trackTradeLifecycle } = require('./trader-core.cjs');
const VERSION = 'coordination-shadow-v1';
const WINDOW = 30 * 60000;
const ms = value => Date.parse(value || '');
const iso = value => new Date(value).toISOString();
const key = (slug, observedAt) => `${slug}:${observedAt}`;
const levels = context => ['hourlyHigh', 'hourlyLow', 'sessionHigh', 'sessionLow', 'openingHigh', 'openingLow', 'poc', 'vwap'].flatMap(name => Number.isFinite(context?.[name]) ? [{ name, price: context[name] }] : []);
function initial(now) { return { version: VERSION, mode: 'observation-only', startedAt: iso(now), events: [], pauses: [] }; }
function advance(previous, accounts, now) {
  const state = structuredClone(previous || initial(now));
  const losses = accounts.flatMap(a => (a.trades || []).filter(t => t.realizedPnlUsd < 0 && /stop/i.test(t.exitReason || '') && ms(t.exitedAt) <= now && ms(t.exitedAt) >= now - WINDOW && ms(t.createdAt) <= now).map(t => ({ ...t, slug: a.slug, knownAt: Math.max(ms(t.exitedAt) + 60000, ms(t.createdAt)) }))).filter(t => t.knownAt <= now);
  for (const a of losses) for (const b of losses) {
    if (a.slug === b.slug || a.symbol !== b.symbol || a.side === b.side || a.knownAt > b.knownAt || Math.abs(ms(a.exitedAt) - ms(b.exitedAt)) > WINDOW) continue;
    const id = [a.id, b.id].sort().join(':');
    if (!state.pauses.some(p => p.id === id)) state.pauses.push({ id, symbol: a.symbol, detectedAt: iso(now), until: iso(now + WINDOW), sources: [a.id, b.id], reason: 'Opposite-direction stop losses within 30 minutes; proposed 30-minute entry pause.' });
  }
  for (const a of accounts) {
    const p = a.plan, life = a.lifecycle;
    if (!p || !life || !Number.isFinite(ms(p.signalContext?.observedAt))) continue;
    const id = key(a.slug, p.signalContext.observedAt);
    if (state.events.some(e => e.id === id)) continue;
    const fresh = a.heartbeat?.ok === true && now - ms(a.heartbeat.at) >= 0 && now - ms(a.heartbeat.at) <= 120000;
    if (!fresh) continue;
    const pause = state.pauses.find(r => r.symbol === p.setup.symbol && ms(r.until) > now && ms(p.signalContext.observedAt) >= ms(r.detectedAt));
    if (pause && life.status === 'not-filled') {
      state.events.push({ id, kind: 'entry-pause', strategy: a.slug, symbol: p.setup.symbol, observedAt: p.signalContext.observedAt, proposedAt: iso(now), sources: pause.sources, status: 'awaiting-baseline', reason: pause.reason });
      continue;
    }
    if (life.status !== 'open') continue;
    const c = a.candles?.at(-1);
    if (!c || ms(c.timestamp) + 60000 > now || now - ms(c.timestamp) > 180000) continue;
    const source = losses.find(t => t.slug !== a.slug && t.symbol === p.setup.symbol && t.side === p.setup.side && levels(p.signalContext).some(l => Math.abs(l.price - t.stop) <= a.config.tickSize && (t.side === 'long' ? c.close < l.price - a.config.tickSize : c.close > l.price + a.config.tickSize)));
    if (!source) continue;
    state.events.push({ id, kind: 'shared-level-exit', strategy: a.slug, symbol: p.setup.symbol, observedAt: p.signalContext.observedAt, proposedAt: iso(now), executeAfter: iso(Math.floor(now / 60000) * 60000 + 60000), sources: [source.id], confirmedCandleAt: c.timestamp, sharedLevel: source.stop, status: 'awaiting-price', reason: 'Same-market, same-direction stop loss; completed close beyond a matching thesis level (within one tick).', plan: structuredClone(p), config: structuredClone(a.config), filledAt: life.filledAt, baselineEntry: life.filledEntryPrice, baselineContracts: life.contracts });
  }
  for (const e of state.events) {
    if (['resolved', 'unfilled', 'insufficient-data'].includes(e.status)) continue;
    const a = accounts.find(a => a.slug === e.strategy);
    if (!a) continue;
    const trade = a.trades?.find(t => t.signalContext?.observedAt === e.observedAt);
    if (e.kind === 'shared-level-exit' && e.shadowPnlUsd == null) {
      const candles = (a.candles || []).filter(c => ms(c.timestamp) + 60000 <= now);
      const last = candles.at(-1);
      if (last && ms(last.timestamp) >= ms(e.executeAfter)) {
        // Require the complete minute path. Never award a fill across a feed gap or roll.
        const path = candles.filter(c => ms(c.timestamp) >= ms(e.filledAt) && ms(c.timestamp) <= ms(e.executeAfter));
        const complete = path.length && ms(path[0].timestamp) === ms(e.filledAt) && ms(path.at(-1).timestamp) === ms(e.executeAfter) && path.every((c, i) => (!i || ms(c.timestamp) - ms(path[i - 1].timestamp) === 60000) && (c.instrumentId ?? c.instrument_id) === (path[0].instrumentId ?? path[0].instrument_id));
        if (!complete) { e.status = 'insufficient-data'; e.reason += ' Complete minute path unavailable.'; continue; }
        const result = trackTradeLifecycle(e.plan, path, e.config, { closeOpenAtEnd: false, flattenAt: e.executeAfter, now });
        if (result.status !== 'closed' || result.filledAt !== e.filledAt || (Number.isFinite(e.baselineEntry) && result.filledEntryPrice !== e.baselineEntry) || (Number.isFinite(e.baselineContracts) && result.contracts !== e.baselineContracts)) { e.status = 'insufficient-data'; continue; }
        e.shadowPnlUsd = result.realizedPnlUsd;
        e.shadowExitAt = result.exitedAt;
        e.shadowExitPrice = result.finalExitPrice;
        e.shadowExitReason = result.exitReason;
        e.status = 'awaiting-baseline';
      }
    }
    if (trade && (e.kind === 'entry-pause' || e.shadowPnlUsd != null)) {
      e.baselinePnlUsd = trade.realizedPnlUsd;
      e.baselineExitAt = trade.exitedAt || null;
      e.shadowPnlUsd ??= 0;
      e.deltaUsd = Math.round((e.shadowPnlUsd - e.baselinePnlUsd) * 100) / 100;
      e.status = 'resolved';
      delete e.plan; delete e.config;
    } else if (e.kind === 'entry-pause' && (!a.plan || a.plan.signalContext?.observedAt !== e.observedAt)) {
      e.status = 'unfilled'; e.reason += ' Baseline order ended without a recorded fill; no savings counted.';
    }
  }
  state.updatedAt = iso(now);
  state.accountsObserved = accounts.length;
  return state;
}
function report(state) {
  if (!state) return { mode: 'observation-only', status: 'not-started', events: [] };
  const resolved = state.events.filter(e => e.status === 'resolved');
  return { version: VERSION, mode: 'observation-only', status: 'observing', startedAt: state.startedAt, updatedAt: state.updatedAt, accountsObserved: state.accountsObserved,
    proposals: state.events.length, resolved: resolved.length,
    benefitUsd: resolved.reduce((n, e) => n + Math.max(0, e.deltaUsd), 0),
    costUsd: resolved.reduce((n, e) => n + Math.max(0, -e.deltaUsd), 0),
    netDeltaUsd: resolved.reduce((n, e) => n + e.deltaUsd, 0),
    activePauses: state.pauses.filter(p => ms(p.until) > ms(state.updatedAt)),
    events: state.events.slice(-100).reverse().map(({ plan, config, ...event }) => event) };
}
module.exports = { VERSION, initial, advance, report };
