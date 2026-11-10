const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let cached = null;

// The bridge checks the actual execution checkout. A web deployment must never
// substitute its own source files for the files used by the paper workers.
function getFocusRuleStatus(rootDir, manifest) {
  const root = path.resolve(rootDir);
  const checkedAt = new Date().toISOString();
  const files = manifest.rulesFiles;
  const missingFiles = [];
  const signatures = [];
  if (!Array.isArray(files) || !files.length) {
    return { id: manifest.id, actualHash: null, checkedAt, matches: false, missingFiles: ['Frozen file list unavailable'] };
  }
  for (const file of files) {
    const target = path.resolve(root, file);
    if (!target.startsWith(root + path.sep)) {
      missingFiles.push(file);
      continue;
    }
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error('Not a file');
      signatures.push([file, stat.size, stat.mtimeMs, stat.ctimeMs]);
    } catch {
      missingFiles.push(file);
    }
  }
  const key = JSON.stringify([root, files, signatures]);
  let actualHash = null;
  if (!missingFiles.length) {
    if (cached?.key === key) actualHash = cached.hash;
    else {
      try {
        const hash = crypto.createHash('sha256');
        for (const file of files) {
          hash.update(file + '\0');
          hash.update(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'));
          hash.update('\0');
        }
        actualHash = hash.digest('hex');
        cached = { key, hash: actualHash };
      } catch {
        missingFiles.push('Execution files changed while being read; retry required');
      }
    }
  }
  let invalidatedAt = null;
  let reason = null;
  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const recordPath = path.join(root, 'runtime', 'profit-focus-v1-integrity.json');
  if (!process.env.VERCEL) {
    try {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      let record;
      try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        record = { id: manifest.id, manifestHash, registeredAt: checkedAt };
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      }
      if (record.id !== manifest.id || record.manifestHash !== manifestHash || missingFiles.length || (actualHash && actualHash !== manifest.expectedRulesHash)) {
        if (!record.invalidatedAt) {
          record.invalidatedAt = checkedAt;
          record.reason = record.id !== manifest.id || record.manifestHash !== manifestHash
            ? 'The frozen cohort or validation policy changed after registration.'
            : missingFiles.length ? 'A frozen execution file became unavailable.'
              : 'Execution files or configuration changed after selection.';
          const temporary = recordPath + '.' + process.pid + '.tmp';
          fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n');
          fs.renameSync(temporary, recordPath);
        }
      }
      invalidatedAt = record.invalidatedAt || null;
      reason = record.reason || null;
    } catch {
      missingFiles.push('Durable trial registration unavailable');
      reason = 'Trial integrity could not be saved; validation is blocked.';
    }
  }
  return {
    id: manifest.id,
    expectedHash: manifest.expectedRulesHash,
    actualHash,
    checkedAt,
    matches: actualHash !== null && actualHash === manifest.expectedRulesHash && !invalidatedAt && !missingFiles.length,
    missingFiles,
    manifestHash,
    invalidatedAt,
    reason
  };
}

module.exports = { getFocusRuleStatus };
