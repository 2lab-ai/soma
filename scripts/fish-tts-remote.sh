#!/usr/bin/env bash
# fish-tts-remote — drop-in fish-tts.sh replacement for hosts without a local GPU.
# Same CLI contract as skills/fish-tts/scripts/fish-tts.sh:
#   fish-tts-remote.sh "text" [--voice NAME] [--output /path/out.wav]
# Calls the soma-voice API (GPU box) POST /api/tts/chunk and converts the
# returned audio to the requested output format via ffmpeg.
set -euo pipefail

SOMA_VOICE_URL="${SOMA_VOICE_URL:-http://100.107.224.40:9999}"

VOICE="iu"
OUTPUT=""
TEXT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --voice)  VOICE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *)        TEXT="$1"; shift ;;
  esac
done

[ -n "$TEXT" ] || { echo "[fish-tts-remote] no text given" >&2; exit 1; }
[ -n "$OUTPUT" ] || OUTPUT="/tmp/fish-tts-remote-$$.wav"

TMP_AUDIO="$(mktemp /tmp/fish-tts-remote-XXXXXX.audio)"
trap 'rm -f "$TMP_AUDIO"' EXIT

payload=$(printf '{"voice":%s,"text":%s}' \
  "$(printf '%s' "$VOICE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
  "$(printf '%s' "$TEXT"  | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")

http_code=$(curl -sS -m 110 -X POST "$SOMA_VOICE_URL/api/tts/chunk" \
  -H 'Content-Type: application/json' \
  -d "$payload" \
  -o "$TMP_AUDIO" -w '%{http_code}')

if [ "$http_code" != "200" ] || [ ! -s "$TMP_AUDIO" ]; then
  echo "[fish-tts-remote] soma-voice returned http=$http_code" >&2
  exit 1
fi

# soma-voice returns mp3; convert to whatever the caller asked for.
ffmpeg -hide_banner -loglevel error -y -i "$TMP_AUDIO" "$OUTPUT"
[ -s "$OUTPUT" ] || { echo "[fish-tts-remote] ffmpeg produced no output" >&2; exit 1; }
echo "[fish-tts-remote] wrote $OUTPUT"
