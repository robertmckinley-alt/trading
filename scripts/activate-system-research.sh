#!/usr/bin/env bash
# Run inside the existing project container after pulling main.
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep a reviewable copy of experiment opt-ins before adding forward research.
node - <<'JS'
const fs=require('node:fs'),path=require('node:path');
const dir='runtime/execution-audit';fs.mkdirSync(dir,{recursive:true});
const file='runtime/profit-experiment/settings.json';
if(fs.existsSync(file)){
 const settings=JSON.parse(fs.readFileSync(file,'utf8'));
 if(settings.enabled!==true)throw Error('Existing profit experiment disabled; no settings changed');
 fs.copyFileSync(file,path.join(dir,`profit-settings-${Date.now()}.json`));
}
JS
node scripts/profit-paper.cjs --research-enable
node scripts/activate-audit-fixes.cjs
printf '%s\n' 'Source repairs loaded and entry research enabled. Existing journals and active plans retained. Verify advancing worker heartbeats and runtime/profit-experiment/entry-research-report.json; startup alone is not verification.'
