#!/usr/bin/env bash
# Build the README split before/after GIF proving the memory loop.
#   1) capture the real claude runs ONCE into e2e/live/gif/cap/ (tokens; skip with --no-capture)
#   2) render both panels with vhs (deterministic replay of the capture — no tokens)
#   3) stack them side by side with a violet divider -> docs/assets/certify-loop.gif
# Model for the capture: ABS_GIF_MODEL (default sonnet for the public asset; use haiku to iterate).
set -euo pipefail
cd "$(dirname "$0")/.."
GIF_DIR="e2e/live/gif"
OUT="docs/assets/certify-loop.gif"

if [ "${1:-}" != "--no-capture" ]; then
  echo "→ building"; npm run build >/dev/null
  echo "→ capturing real claude runs (model=${ABS_GIF_MODEL:-sonnet})"
  ABS_GIF_MODEL="${ABS_GIF_MODEL:-sonnet}" npx tsx "$GIF_DIR/capture.ts"
fi

[ -s "$GIF_DIR/cap/with-answer.txt" ] || { echo "no capture found — run without --no-capture first"; exit 1; }

echo "→ rendering panels with vhs"
vhs "$GIF_DIR/without.tape"
vhs "$GIF_DIR/with.tape"

echo "→ composing the README split (hstack + violet divider)"
# Pad each panel with a half-divider on its inner edge, then stack. Two-pass palette.
ffmpeg -y -loglevel error \
  -i "$GIF_DIR/without.gif" -i "$GIF_DIR/with.gif" -filter_complex \
  "[0:v]pad=iw+3:ih:0:0:color=0x0A0810[lp]; \
   [1:v]pad=iw+3:ih:3:0:color=0x8B5CF6[rp]; \
   [lp][rp]hstack=inputs=2,split[s0][s1]; \
   [s0]palettegen=stats_mode=diff[p]; \
   [s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  "$OUT"
echo "→ $OUT  ($(du -h "$OUT" | cut -f1))"

STORY="docs/assets/certify-loop-story.gif"
echo "→ composing the Instagram story (vstack, 9:16 portrait)"
# WITHOUT on top, WITH below (violet divider), then pad to a 9:16 canvas centered on bg.
ffmpeg -y -loglevel error \
  -i "$GIF_DIR/without.gif" -i "$GIF_DIR/with.gif" -filter_complex \
  "[0:v]pad=iw:ih+3:0:0:color=0x0A0810[tp]; \
   [1:v]pad=iw:ih+3:0:3:color=0x8B5CF6[bp]; \
   [tp][bp]vstack=inputs=2,pad=iw:trunc(iw*16/9):(ow-iw)/2:(oh-ih)/2:color=0x0A0810,split[s0][s1]; \
   [s0]palettegen=stats_mode=diff[p]; \
   [s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  "$STORY"
echo "→ $STORY  ($(du -h "$STORY" | cut -f1))"
