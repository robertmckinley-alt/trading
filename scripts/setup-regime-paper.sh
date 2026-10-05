#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p runtime/regime-experiment
# Training is explicit and cache-only. No data purchases and no original-account edits.
if [ ! -f runtime/regime-experiment/model.json ]; then
  python3 -m venv runtime/regime-experiment/venv
  runtime/regime-experiment/venv/bin/python -m pip install -r requirements-regime.txt
  node scripts/prepare-regime-training.cjs
  OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 runtime/regime-experiment/venv/bin/python scripts/train-regime-model.py runtime/regime-experiment/training.json runtime/regime-experiment/model.json
fi
node -e 'require("./lib/regime-model.cjs").validate(require("./runtime/regime-experiment/model.json"))'
node scripts/regime-paper.cjs --enable
node scripts/restart-status-server.cjs
