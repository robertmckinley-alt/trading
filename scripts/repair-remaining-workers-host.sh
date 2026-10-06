#!/usr/bin/env bash
# Run on VPS host. Repair enabled workers and train the isolated HMM from cache.
set -euo pipefail
container='openclaw-anwx-openclaw-1'
project='/data/.openclaw/workspace/lucid-nq-paper-trader'
docker exec -w "$project" "$container" node scripts/strategy-watchdog.cjs --retry-now
docker exec -w "$project" "$container" node scripts/coordination-shadow.cjs --start
if ! docker exec -w "$project" "$container" test -f runtime/regime-experiment/model.json; then
  docker exec -w "$project" "$container" node scripts/prepare-regime-training.cjs
  docker exec -w "$project" "$container" node -e '
  const p=require("./runtime/regime-experiment/training.json");
  const dates=new Set(p.rows.map(r=>r.availableAt.slice(0,10))).size;
  if(dates<60||p.rows.length<10000){console.error(`HMM blocked: ${dates} dates, ${p.rows.length} rows. Need 60 dates and 10000 rows; no history purchased.`);process.exit(1);}
  '
  work=$(mktemp -d /tmp/trading-hmm.XXXXXX)
  trap 'rm -rf "$work"' EXIT
  docker cp "$container:$project/runtime/regime-experiment/training.json" "$work/training.json" >/dev/null
  docker cp "$container:$project/scripts/train-regime-model.py" "$work/train.py" >/dev/null
  docker cp "$container:$project/requirements-regime.txt" "$work/requirements.txt" >/dev/null
  echo 'Training HMM in isolated Python 3.12 container (one CPU, 2 GB maximum). Existing traders keep running.'
  docker run --rm --cpus=1 --memory=2g --volume "$work:/work" --workdir /work \
    -e OMP_NUM_THREADS=1 -e OPENBLAS_NUM_THREADS=1 python:3.12-slim \
    sh -ec 'python -m pip install --no-cache-dir -r requirements.txt && python train.py training.json model.json'
  # Validate before writing; exclusive creation never replaces an existing model.
  docker exec -i -w "$project" "$container" node -e '
  let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>text+=d);
  process.stdin.on("end",()=>{const model=JSON.parse(text);require("./lib/regime-model.cjs").validate(model);require("fs").writeFileSync("runtime/regime-experiment/model.json",text,{flag:"wx"});console.log("Validated model saved");});
  ' < "$work/model.json"
fi
docker exec -w "$project" "$container" node -e 'require("./lib/regime-model.cjs").validate(require("./runtime/regime-experiment/model.json"))'
docker exec -w "$project" "$container" node scripts/regime-paper.cjs --enable
echo 'Repair commands finished. Allow one minute for heartbeat verification; HMM training success is not proof of strategy profitability.'
