const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validate, implementationHash } = require('./orb-discovery.cjs');
const { SLUGS, RULES } = require('./price-action-patterns.cjs');
const { atomic } = require('./orb-forward.cjs');
function qualify(report, config, root) {
  const file = path.join(root, 'runtime/price-action/paper-candidates.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const code = implementationHash();
  const baseline = report.strategies.find(s => s.slug === 'nq-15m-orb-close-confirmation')?.research?.trades || [];
  const reviews = report.strategies.filter(s => SLUGS.includes(s.slug)).map(s => {
    const verdict = validate(s.research.trades, baseline, report.provenance, config);
    const existing = saved.find(c => c.baseSlug === s.slug);
    if (!existing && verdict.status === 'paper-candidate') {
      const id = createHash('sha256').update(JSON.stringify({ code, config, rules: RULES, slug: s.slug })).digest('hex').slice(0, 16);
      const candidate = { id, slug: `paper-${s.slug}`, baseSlug: s.slug, name: s.name,
        status: 'paper-candidate', implementationHash: code, frozenConfig: config,
        qualifiedAt: report.generatedAt, dataFingerprint: report.provenance.dataFingerprint };
      atomic(path.join(root, `runtime/price-action/evidence/${id}.json`), { candidate, verdict, window: report.window, provenance: report.provenance, result: s });
      saved.push(candidate);
    }
    return { slug: s.slug, ...verdict, paperSelected: saved.some(c => c.baseSlug === s.slug && c.implementationHash === code),
      frozenCodeChanged: Boolean(existing && existing.implementationHash !== code) };
  });
  atomic(file, saved);
  return { label: 'Retrospective screening only. Qualifying patterns receive independent $50k forward-paper accounts; no live deployment.', reviews };
}
module.exports = { qualify };
