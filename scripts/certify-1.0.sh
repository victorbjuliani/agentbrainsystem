#!/usr/bin/env bash
# Certify the 1.0 memory loop against a REAL Claude Code. Opt-in; needs `claude` auth + tokens.
# Drives Session A (capture) -> store -> Session B (recall + per-prompt injection + use),
# asserting the deterministic injection gate and the behavioral core. Evidence -> artifacts/.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="artifacts/certify-1.0"
mkdir -p "$OUT"
echo "→ building the binary under test"
npm run build >/dev/null
echo "→ running the live full-loop smoke (haiku)"
ABS_LIVE_CC=1 npx vitest run -c vitest.e2e.config.ts e2e/live/scenario.live.ts \
  --reporter=verbose 2>&1 | tee "$OUT/run.log"
echo
echo "PASS — 1.0 memory loop certified against a real Claude Code. Evidence: $OUT/run.log"
