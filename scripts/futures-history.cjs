#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { parseDatabentoJson } = require('../lib/historical-data.cjs');
const { runAllBacktests } = require('../lib/backtest-engine.cjs');
const { normalizeConfig } = require('../lib/trader-core.cjs');
const { CANONICAL_FIELDS, auditCandles, canonicalFingerprint, codeFingerprint, compareCandles, fetchLseCandlePage, fetchLseDiscovery, importCsvFile, sha256 } = require('../lib/futures-history.cjs');

function args(argv) {
  const values = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { values._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) values[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) values[key] = argv[++index];
    else values[key] = true;
  }
  return values;
}

function columns(value) {
  if (!value) return {};
  return Object.fromEntries(String(value).split(',').map((entry) => {
    const at = entry.indexOf('=');
    if (at < 1) throw new Error(`Invalid column mapping: ${entry}`);
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
}

function importOptions(options, prefix = '') {
  const get = (name) => options[`${prefix}${name}`] ?? options[name];
  return { provider: get('provider'), dataset: get('dataset'), symbol: get('symbol'), timestampUnit: get('timestamp-unit'),
    intervalMinutes: Number(get('interval-minutes') || 1), columns: columns(get('columns')) };
}

function write(value, filename) {
  const json = JSON.stringify(value, null, 2) + '\n';
  if (filename) fs.writeFileSync(safeOutputPath(filename), json, { flag: 'wx' });
  else process.stdout.write(json);
}

function safeOutputPath(filename) {
  const root = path.resolve(__dirname, '..', 'runtime', 'secondary-history');
  for (const directory of [path.dirname(root), root]) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Secondary research output directories must not be symlinks.');
  }
  fs.mkdirSync(root, { recursive: true });
  const projectRelative = filename.startsWith(`runtime${path.sep}secondary-history${path.sep}`);
  const output = path.isAbsolute(filename) ? path.resolve(filename) : projectRelative
    ? path.resolve(__dirname, '..', filename) : path.resolve(root, filename);
  const relative = path.relative(root, output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output must be a file below runtime/secondary-history/.');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const realRoot = fs.realpathSync(root), realParent = fs.realpathSync(path.dirname(output));
  const realRelative = path.relative(realRoot, realParent);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('Output path escapes runtime/secondary-history through a symlink.');
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing output: ${output}`);
  return output;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function canonicalCsv(candles) {
  return `${CANONICAL_FIELDS.join(',')}\n${candles.map((candle) => CANONICAL_FIELDS.map((field) => csvCell(candle[field])).join(',')).join('\n')}\n`;
}

function requireInput(options, name = 'input') {
  const filename = options[name];
  if (!filename) throw new Error(`--${name} is required.`);
  return filename;
}

function qualityGate(imported, options) {
  if (!imported.audit.structurallyValid) throw new Error(`Input failed ${imported.audit.errors} structural integrity check(s).`);
  if (imported.audit.gapCount && !options['allow-gaps']) throw new Error(`Input contains ${imported.audit.gapCount} time gap(s); inspect the audit and rerun with --allow-gaps only for reviewed market closures.`);
}

function loadDatabento(filename, options) {
  const raw = fs.readFileSync(filename, 'utf8');
  if (/\.jsonl?$|\.ndjson$/i.test(filename)) {
    const text = raw.trim();
    const records = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const candles = records.map((record, index) => {
      const candle = parseDatabentoJson(JSON.stringify([record]))[0];
      if (!candle) throw new Error(`Databento reference record ${index + 1} is invalid.`);
      return candle;
    });
    return { candles, audit: auditCandles(candles, { intervalMinutes: Number(options['interval-minutes'] || 1) }), fingerprint: canonicalFingerprint(candles),
      source: { provider: 'Databento', path: path.resolve(filename), bytes: Buffer.byteLength(raw), sha256: sha256(raw) } };
  }
  return importCsvFile(filename, { ...importOptions(options, 'databento-'), provider: 'Databento' });
}

function auditCommand(options) {
  const imported = importCsvFile(requireInput(options), importOptions(options));
  write({ version: 1, source: imported.source, mapping: imported.mapping, canonicalFingerprint: imported.fingerprint, audit: imported.audit }, options.output);
  if (!imported.audit.ok) process.exitCode = 2;
}

function compareCommand(options) {
  const candidate = importCsvFile(requireInput(options, 'candidate'), importOptions(options, 'candidate-'));
  const databento = loadDatabento(requireInput(options, 'databento'), options);
  qualityGate(candidate, options);
  if (!databento.audit.structurallyValid) throw new Error(`Databento reference failed ${databento.audit.errors} structural integrity check(s).`);
  const comparison = compareCandles(candidate.candles, databento.candles, { priceTolerance: Number(options['price-tolerance'] || 0), volumeTolerance: Number(options['volume-tolerance'] || 0) });
  write({ version: 1, candidate: { source: candidate.source, fingerprint: candidate.fingerprint, audit: candidate.audit },
    databento: { source: databento.source, fingerprint: databento.fingerprint, audit: databento.audit }, comparison }, options.output);
  if (!comparison.comparable || !comparison.withinTolerance) process.exitCode = 3;
}

function replayCommand(options) {
  if (Number(options['interval-minutes'] || 1) !== 1) throw new Error('The frozen backtester accepts only one-minute candles.');
  const imported = importCsvFile(requireInput(options), importOptions(options));
  qualityGate(imported, options);
  if (!options.provider || !options.symbol) throw new Error('Replay provenance requires --provider and --symbol.');
  const root = path.resolve(__dirname, '..');
  const configPath = path.resolve(options.config || path.join(root, 'config.json'));
  const rawConfig = fs.readFileSync(configPath);
  const config = normalizeConfig(JSON.parse(rawConfig));
  const sourceRoot = String(options.symbol).toUpperCase().split('.')[0];
  if (sourceRoot !== config.symbol) throw new Error(`Source symbol ${options.symbol} cannot be replayed by the frozen ${config.symbol} strategy set.`);
  const derivedSeries = String(options.symbol).toUpperCase() === 'NQ.F';
  if (derivedSeries && !options['acknowledge-derived-series']) throw new Error('NQ.F roll and price basis are unverified; rerun with --acknowledge-derived-series only after reviewing the Databento comparison.');
  const results = runAllBacktests(imported.candles, config);
  const calendarLimited = imported.candles.some((candle) => !/^202[56]-/.test(candle.timestamp));
  const limitations = [
    'Secondary CSV data does not establish execution parity with Databento or an exchange feed and cannot promote a strategy or replace a primary feed.',
    'Canonical CSV has no contract IDs, so the backtester cannot identify or skip vendor rollover days.',
    ...(derivedSeries ? ['NQ.F contract identity, roll rule, adjustments and price basis remain unverified even when its use is explicitly acknowledged.'] : []),
    ...(calendarLimited ? ['Cash-session ORB strategies are frozen to the reviewed 2025-2026 calendar and skip dates outside it. Other strategies still run.'] : [])
  ];
  const report = { ...results, source: imported.source.provider, symbol: imported.source.symbol,
    window: { start: imported.source.firstTimestamp, end: imported.source.lastTimestamp },
    offlineReplay: { version: 1, execution: 'research-only', source: imported.source, mapping: imported.mapping, audit: imported.audit,
      promotionEligible: false, primaryFeedReplacementAllowed: false,
      gapOverride: Boolean(options['allow-gaps']), dataFingerprint: imported.fingerprint, config: { path: configPath, sha256: sha256(rawConfig) }, code: codeFingerprint(root),
      derivedSeries: { acknowledged: derivedSeries ? true : null, identityVerified: derivedSeries ? false : null },
      limitations } };
  write(report, options.output);
}

async function downloadLseCommand(options) {
  if (!options.output) throw new Error('--output is required so secondary data remains separate from primary caches.');
  if (String(options.timeframe || '1m') !== '1m') throw new Error('The frozen backtester accepts only 1m candle downloads.');
  const discovery = await fetchLseDiscovery({ env: process.env });
  const dataset = String(options.dataset || 'futures');
  const catalogRow = discovery.catalog.find((row) => row && row.dataset === dataset && row.symbol === options.symbol);
  if (!catalogRow) throw new Error(`London Strategic Edge catalog does not list ${dataset}/${options.symbol}.`);
  if (discovery.meta.access?.[dataset] && !discovery.meta.access[dataset].includes('candles')) throw new Error(`London Strategic Edge account metadata does not grant candle access for ${dataset}.`);
  const accountLimit = Number(discovery.usage.max_rows_per_request);
  const safeAccountLimit = Number.isInteger(accountLimit) && accountLimit > 0 ? Math.min(5000, accountLimit) : 5000;
  const limit = options.limit === undefined ? safeAccountLimit : Number(options.limit);
  if (limit > safeAccountLimit) throw new Error(`Requested limit exceeds the current account/client cap of ${safeAccountLimit}.`);
  const page = await fetchLseCandlePage({ env: process.env, symbol: options.symbol, timeframe: '1m', start: options.start, end: options.end,
    order: options.order || 'asc', limit, dataset, intervalMinutes: 1 });
  if (!page.candles.length) throw new Error('London Strategic Edge returned no candles for this request.');
  const output = safeOutputPath(options.output);
  const provenanceOutput = safeOutputPath(`${options.output}.provenance.json`);
  fs.writeFileSync(output, canonicalCsv(page.candles), { flag: 'wx' });
  write({ version: 1, provider: 'London Strategic Edge', endpoint: page.request, rawSha256: page.rawSha256,
    discovery: { retrievedAt: new Date().toISOString(), usage: discovery.usage, meta: discovery.meta, catalogRow, hashes: discovery.hashes },
    canonicalFingerprint: page.fingerprint, timestampPolicy: 'vault-utc-normalized-to-iso-z', records: page.candles.length,
    firstTimestamp: page.candles[0].timestamp, lastTimestamp: page.candles.at(-1).timestamp, audit: page.audit,
    possibleAdditionalRows: page.possibleAdditionalRows,
    pagination: 'single response page; no cursor or page parameter was assumed. A full-limit response may be incomplete and must not be treated as full-range coverage.' }, provenanceOutput);
}

function help() {
  process.stdout.write(`Usage:\n  node scripts/futures-history.cjs download-lse --symbol NQ.F --start TIME --end TIME --output FILE\n  node scripts/futures-history.cjs audit --input FILE [--provider NAME --symbol SYMBOL --output FILE]\n  node scripts/futures-history.cjs compare --candidate FILE --databento FILE [--price-tolerance N --volume-tolerance N --output FILE]\n  node scripts/futures-history.cjs replay --input FILE --provider NAME --symbol SYMBOL --output FILE [--allow-gaps]\n\nNamed outputs are created without overwrite below runtime/secondary-history/. download-lse reads LSE_API_KEY from the environment and writes one response page (client-capped at 5,000 bars) plus a provenance sidecar. A full-limit page is flagged as possibly incomplete.\nCSV timestamps must contain Z/a UTC offset. Numeric timestamps require --timestamp-unit=s|ms|us|ns.\nUse --columns=timestamp=Date,open=Open,... when headers are not canonical. Gap overrides are recorded in replay provenance.\nLondon Strategic Edge NQ.F is a vendor series: compare roll and price basis against Databento before replay. Replay requires --acknowledge-derived-series. GC.F is not MGC and this NQ replay rejects it.\n`);
}

async function main() {
  const options = args(process.argv.slice(2));
  const command = options._[0];
  if (!command || options.help) help();
  else if (command === 'download-lse') await downloadLseCommand(options);
  else if (command === 'audit') auditCommand(options);
  else if (command === 'compare') compareCommand(options);
  else if (command === 'replay') replayCommand(options);
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`futures-history: ${error.message}\n`);
  process.exitCode = 1;
});
