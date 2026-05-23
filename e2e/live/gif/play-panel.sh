#!/usr/bin/env bash
# Replays a captured panel narrative (e2e/live/gif/cap/) with a typewriter effect.
# Deterministic — no `claude`, no tokens. Usage: play-panel.sh with|without
set -euo pipefail
MODE="${1:?usage: play-panel.sh with|without}"
CAP="$(dirname "$0")/cap"

V='\033[38;2;139;92;246m'   # brand violet
C='\033[38;2;34;211;238m'   # cyan
T='\033[38;2;94;234;212m'   # teal
D='\033[38;2;122;120;138m'  # dim
W='\033[38;2;230;228;237m'  # near-white
B='\033[1m'; R='\033[0m'

type_out() { # stream text word-by-word
  local text="$1" color="$2"
  printf "%b" "$color"
  local IFS=' '
  for w in $text; do printf "%s " "$w"; sleep 0.035; done
  printf "%b\n" "$R"
}

clear
sleep 0.4
if [ "$MODE" = "with" ]; then
  printf "  %b✓ WITH agentbrainsystem%b\n" "$V$B" "$R"
  printf "  %bcheckout-api · fresh Claude Code session, days later%b\n\n" "$D" "$R"
else
  printf "  %b✗ WITHOUT agentbrainsystem%b\n" "$D$B" "$R"
  printf "  %bcheckout-api · fresh Claude Code session, days later%b\n\n" "$D" "$R"
fi
sleep 0.5
printf "  %b❯%b " "$C" "$R"
type_out "$(cat "$CAP/question.txt")" "$W"
printf "\n"; sleep 0.6

if [ "$MODE" = "with" ]; then
  printf "  %b🧠 agentbrainsystem recalled from past sessions:%b\n" "$V$B" "$R"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf "     %b%s%b\n" "$V" "$line" "$R"; sleep 0.5
  done < "$CAP/recalled.txt"
  printf "\n"; sleep 0.5
  printf "  %b🤖%b " "$T" "$R"
  type_out "$(cat "$CAP/with-answer.txt")" "$W"
else
  printf "  %b🤖%b " "$D" "$R"
  type_out "$(cat "$CAP/without-answer.txt")" "$D"
fi
# Hold the final frame so the GIF lingers on the punchline.
sleep "${PANEL_HOLD:-6}"
