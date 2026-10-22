#!/usr/bin/env node
'use strict';
// Read-only signal diagnostics. No order simulation, journal writes, or account resets.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const CHANGED = ['nq-dmc-gain-retest', 'nq-15m-opening-range-retest', 'ema-20-60-momentum', 'nq-fresh-level-retest'];
const DIAGNOSTIC = ['nq-dmc-market-open', 'nq-dmc-failed-level-reversal'];
const EXPECTED_VERSION = 'consolidation-expansion-entry-v1';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function fingerprint(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function flatIssues(state) {
  if (!state || typeof state !== 'object' || !state.live || !Array.isArray(state.trades)) return ['missing or unrecognized account state'];
  const issues = [];
  for (const scope of [state, state.live]) {
    for (const field of ['openPlan', 'openLifecycle', 'position', 'openPosition', 'pendingOrder']) {
      if (scope[field] != null && scope[field] !== false) issues.push(field);
    }
    for (const field of ['positions', 'openPositions', 'pendingOrders', 'orders']) {
      if (scope[field] != null && (!Array.isArray(scope[field]) || scope[field].length)) issues.push(field);
    }
    for (const field of ['positionSize', 'openQuantity', 'positionQuantity']) {
      if (scope[field] != null && (typeof scope[field] !== 'number' || scope[field] !== 0)) issues.push(field);
    }
  }
  return [...new Set(issues)];
}
function inspectCandles(candles, asOf) {
  if (!Array.isArray(candles) || !candles.length) throw new Error('Cache must contain a nonempty candles array');
  let previous = -Infinity;
  for (const c of candles) {
    const t = Date.parse(c.timestamp);
    if (!Number.isFinite(t) || t % 60000 || t <= previous || ![c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)
      || c.volume < 0 || c.low > Math.min(c.open,c.close) || c.high < Math.max(c.open,c.close) || c.low > c.high) {
      throw new Error('Cache contains invalid, duplicate, unsorted, or non-minute OHLCV bars; refusing to repair silently');
    }
    previous = t;
  }
  const complete = candles.filter(c => Date.parse(c.timestamp) + 60000 <= asOf);
  if (!complete.length) throw new Error('Cache has no completed one-minute bars at the requested as-of time');
  return { complete, excludedIncompleteOrFuture: candles.length - complete.length };
}
function configFor(root, raw, slug) {
  const config = require(path.join(root, 'lib/trader-core.cjs')).normalizeConfig(structuredClone(raw));
  return { ...config, ...(slug === 'nq-fresh-level-retest' ? {
    ...require(path.join(root, 'lib/fresh-level-retest.cjs')).ACCOUNT,
    live: { ...config.live, lookbackBars: 6000 }
  } : {}), strategySlug: slug, detectorStrategySlug: slug };
}
function summarize(signal) {
  if (!signal?.found) return { found: false, reason: signal?.reason || 'unspecified rejection' };
  const s = signal.setup;
  if (!s || !['long','short'].includes(s.side) || ![s.entry,s.stop,...(s.targets || [])].every(Number.isFinite)) throw new Error('Detector returned malformed signal');
  return { found: true, triggerTimestamp: signal.triggerTimestamp, side: s.side, entry: s.entry, stop: s.stop,
    targets: s.targets, execution: s.execution, signalAvailableAt: s.signalAvailableAt,
    rulesVersion: signal.metadata?.rulesVersion || null, entryRoute:signal.metadata?.entryRoute||null };
}
function replay(root, raw, candles, onProgress = () => {}, enableEntryRules = true) {
  const detect = require(path.join(root, 'lib/live-trader.cjs')).detectSignalFromCandles;
  const hourly = require(path.join(root, 'lib/dmc-market-open.cjs')).completeBars(candles, 60);
  const fresh = require(path.join(root, 'lib/fresh-level-retest.cjs'));
  const clock = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' });
  const outcomes = Object.fromEntries([...CHANGED,...DIAGNOSTIC].map(slug => [slug, { checks:0, signals:[], rejections:{}, signatures:new Map() }]));
  const configs = Object.fromEntries(Object.keys(outcomes).map(slug => [slug,configFor(root,raw,slug)]));
  let eligiblePrefixes = 0;
  for (let i=0;i<candles.length;i++) {
    const available = Date.parse(candles[i].timestamp)+60000;
    const p = Object.fromEntries(clock.formatToParts(new Date(available)).map(x=>[x.type,x.value]));
    const minute = Number(p.hour)*60+Number(p.minute), date = `${p.year}-${p.month}-${p.day}`;
    if (minute<570 || minute>960) continue;
    const before = hourly.filter(h=>Date.parse(h.endTimestamp)+60000<=available);
    if (before.length<18 || Date.parse(candles[0].timestamp)>fresh.contextStartForDate(date)) continue;
    eligiblePrefixes++;
    const prefix=candles.slice(0,i+1);
    for (const [slug,out] of Object.entries(outcomes)) {
      // Independent entry opportunities only: no invented fills or daily state transitions.
      const config={...configs[slug],evaluationTime:available,live:{...configs[slug].live,
        consolidationExpansion:{...configs[slug].live?.consolidationExpansion,enabled:enableEntryRules,asOf:available}}};
      const result=summarize(detect(prefix,config,{trades:[],live:{}}));
      out.checks++;
      const key=candles[i].timestamp;
      out.signatures.set(key,JSON.stringify(result.found?result:{found:false}));
      if (result.found) {
        if (result.signalAvailableAt && Date.parse(result.signalAvailableAt)>available) throw new Error(`${slug} emitted a future-available signal`);
        out.signals.push({checkedAt:new Date(available).toISOString(),...result});
      } else out.rejections[result.reason]=(out.rejections[result.reason]||0)+1;
    }
    if (eligiblePrefixes%240===0) onProgress(eligiblePrefixes);
  }
  return { eligiblePrefixes,outcomes };
}
function main(args=process.argv.slice(2)) {
  process.chdir(ROOT);
  const get=name=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
  const strict=args.includes('--require-validation'), requireRunning=args.includes('--require-running'), failures=[];
  const raw=read(path.join(ROOT,'config.json'));
  const runtimeRoot=path.resolve(get('runtime-root')||ROOT);
  const asOf=get('as-of')?Date.parse(get('as-of')):Date.now();
  if(!Number.isFinite(asOf))throw new Error('Invalid --as-of timestamp');
  const cachePath=path.resolve(runtimeRoot,get('cache')||raw.live?.liveCachePath||'runtime/databento-live.json');
  const cache=read(cachePath),checked=inspectCandles(Array.isArray(cache)?cache:cache.candles,asOf);
  const historicalOnly=Math.abs(Date.now()-asOf)>180000;
  const latestCompleteAt=Date.parse(checked.complete.at(-1).timestamp)+60000;
  if(historicalOnly)failures.push('historical as-of: diagnostic replay cannot approve current activation');
  if(Date.now()-latestCompleteAt>Number(raw.live?.maxLiveCandleAgeMinutes||3)*60000)failures.push('actual candle cache is stale for current activation');
  if(cache.provider!=='databento-live'||cache.mode!=='live')failures.push('cache is not identified as the actual databento live feed');
  if(cache.symbol!==raw.live?.ticker)failures.push('feed cache symbol does not match configured instrument');
  const sourceFiles=['lib/consolidation-expansion.cjs','lib/live-trader.cjs','lib/dmc-level-bots.cjs','lib/fresh-level-retest.cjs','lib/runner.cjs','lib/trader-core.cjs','lib/watcher-observation.cjs','config.json'];
  for(const file of sourceFiles.filter(f=>f.endsWith('.cjs')))execFileSync(process.execPath,['--check',path.join(ROOT,file)],{stdio:'pipe'});
  const helper=require('../lib/consolidation-expansion.cjs');
  if(helper.VERSION!==EXPECTED_VERSION)failures.push('expected entry-rule helper version is not loaded');
  if(raw.startingBalanceUsd!==50000)failures.push('configured initial paper balance is not $50,000');
  const registry=require('../lib/strategy-registry.cjs'),pids=require('../lib/watcher-process.cjs').matchingPids;
  const realPaths=new Set();
  const accounts=[...CHANGED,...DIAGNOSTIC].map(slug=>{
    const files=registry.runtimeFilesForStrategy(runtimeRoot,slug),issues=[];
    let state=null,digest=null;
    try{state=read(files.statePath);digest=fingerprint(files.statePath);const stat=fs.statSync(files.statePath),real=`${stat.dev}:${stat.ino}`;if(realPaths.has(real))issues.push('shared account file');realPaths.add(real);}catch{issues.push('missing or unreadable account state');}
    issues.push(...flatIssues(state));
    if(state?.startingBalanceUsd!==50000)issues.push('initial balance is not $50,000');
    const workers=pids(slug,runtimeRoot);
    if(workers===null)issues.push('Linux watcher identity unavailable');
    else if(workers.length>1 || (requireRunning&&workers.length!==1))issues.push('unexpected watcher count');
    const heartbeat=state?.live?.heartbeat;
    const heartbeatAt=heartbeat?.at||heartbeat?.timestamp;
    if(requireRunning&&(!Number.isFinite(Date.parse(heartbeatAt))||Date.now()-Date.parse(heartbeatAt)>180000||Date.parse(heartbeatAt)>Date.now()+60000||heartbeat?.ok!==true))issues.push('watcher heartbeat missing, unhealthy, stale, or future');
    if(issues.length)failures.push(`${slug}: ${issues.join(', ')}`);
    return {slug,statePath:path.relative(runtimeRoot,files.statePath),sha256:digest,startingBalanceUsd:state?.startingBalanceUsd,tradeCount:state?.trades?.length,
      heartbeatAt:heartbeatAt||null,runtimeRulesVersion:state?.live?.scanAudit?.rulesVersion||heartbeat?.rulesVersion||state?.live?.rulesVersion||null,watcherCount:workers?.length??null,flat:flatIssues(state).length===0,issues};
  });
  const current=replay(ROOT,raw,checked.complete,n=>console.error(`Read-only current replay: ${n} completed prefixes`));
  if(!current.eligiblePrefixes)failures.push('no cash-session prefix with 24-hour session context and 18 completed H1 bars');
  let baseline=null;
  if(get('baseline-root')) {
    const baseRoot=path.resolve(get('baseline-root'));
    if(baseRoot===ROOT)throw new Error('Baseline must be a separate checkout');
    baseline=replay(baseRoot,raw,checked.complete,n=>console.error(`Read-only historical baseline replay: ${n} completed prefixes`),false);
  } else baseline=replay(ROOT,raw,checked.complete,n=>console.error(`Read-only disabled-entry baseline replay: ${n} completed prefixes`),false);
  const strategies=Object.entries(current.outcomes).map(([slug,out])=>{
    const old=baseline?.outcomes[slug];let differences=0,newlyEnabledSignals=0;
    if(old)for(const [at,signature] of out.signatures){
      if(signature!==old.signatures.get(at))differences++;
      const after=JSON.parse(signature),before=JSON.parse(old.signatures.get(at)||'{"found":false}');
      if(after.found&&!before.found&&after.entryRoute?.startsWith('ce-'))newlyEnabledSignals++;
    }
    if(CHANGED.includes(slug)&&!newlyEnabledSignals)failures.push(`${slug}: cache does not demonstrate any CE entry newly enabled versus baseline`);
    return {slug,scope:CHANGED.includes(slug)?'entry-rule change':'diagnostic only',checks:out.checks,
      beforeSignals:old?.signals.length??null,afterSignals:out.signals.length,newlyEnabledSignals,changedPrefixes:old?differences:null,
      rejections:out.rejections,sampleSignals:out.signals.slice(0,3)};
  });
  // Detect writes by other processes while inspecting; this CLI never writes these files.
  for(const a of accounts)if(a.sha256){try{if(fingerprint(path.join(runtimeRoot,a.statePath))!==a.sha256)failures.push(`${a.slug}: account changed during validation; repeat in a coordinated flat window`);}catch{failures.push(`${a.slug}: account unreadable after replay`);}}
  const report={at:new Date().toISOString(),asOf:new Date(asOf).toISOString(),historicalOnly,mode:'read-only completed-prefix signal opportunities; no fills, P&L, profitability, daily-trade guarantee, or production activation tested',
    helperVersion:helper.VERSION||null,runtimeRoot,requireRunning,configuredEntryRulesEnabled:raw.live?.consolidationExpansion?.enabled===true,
    comparison:get('baseline-root')?'historical source, current configuration, entry flag disabled versus enabled current source':'same source and configuration, entry flag disabled versus enabled',
    sourceSha256:Object.fromEntries(sourceFiles.map(f=>[f,fingerprint(path.join(ROOT,f))])),
    baselineRoot:get('baseline-root')?path.resolve(get('baseline-root')):null,baselineSourceSha256:get('baseline-root')?Object.fromEntries(sourceFiles.map(f=>[f,fingerprint(path.join(path.resolve(get('baseline-root')),f))])):null,
    cache:{path:path.relative(ROOT,cachePath),provider:cache.provider||null,completedBars:checked.complete.length,first:checked.complete[0].timestamp,last:checked.complete.at(-1).timestamp,excludedIncompleteOrFuture:checked.excludedIncompleteOrFuture},
    eligiblePrefixes:current.eligiblePrefixes,accounts,strategies,validationPassed:failures.length===0,failures};
  console.log(JSON.stringify(report,null,2));
  if(strict&&failures.length)process.exitCode=2;
  return report;
}
if(require.main===module){try{main();}catch(error){console.error(`Validation refused: ${error.message}`);process.exitCode=1;}}
module.exports={flatIssues,inspectCandles,summarize,replay,main};
