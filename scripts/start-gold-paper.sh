#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p runtime
exec flock -n runtime/gold-start.lock node scripts/start-gold-paper.cjs
