#!/bin/bash
# Generate + install a macOS LaunchAgent for a soma bot instance.
# Usage: install-macos-service.sh <service-name> <env-file-abs-or-rel> <workdir>
set -euo pipefail

SERVICE_NAME="${1:?service name required}"
ENV_FILE="${2:?env file required}"
WORKDIR="${3:?workdir required}"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$WORKDIR/$ENV_FILE" ]]; then
    ENV_FILE="$WORKDIR/$ENV_FILE"
  else
    echo "❌ Env file not found: $ENV_FILE"
    exit 1
  fi
fi
ENV_ABS="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
WORKDIR_ABS="$(cd "$WORKDIR" && pwd)"
BUN_BIN="$(command -v bun || true)"
if [[ -z "$BUN_BIN" ]]; then
  echo "❌ bun not found in PATH"
  exit 1
fi

LABEL="ai.2lab.${SERVICE_NAME}"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
OUT_LOG="${HOME}/Library/Logs/${LABEL}.out.log"
ERR_LOG="${HOME}/Library/Logs/${LABEL}.err.log"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
PATH_VAL="$(dirname "$BUN_BIN"):${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
CMD="set -a; . ${ENV_ABS}; set +a; cd ${WORKDIR_ABS}; exec ${BUN_BIN} run start"

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"

# Unload a launchd label if present; fail hard when loaded but bootout fails
# (silent || true left in-memory legacy + new = double-bot on same token).
unload_label() {
  local label="$1"
  local plist_path="${HOME}/Library/LaunchAgents/${label}.plist"
  if launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1; then
    echo "   Unloading loaded label ${label}..."
    if ! launchctl bootout "${DOMAIN}/${label}"; then
      echo "❌ bootout failed for loaded label ${label} — refusing to continue (double-bot risk)"
      exit 1
    fi
    # wait briefly for domain absence
    local i=0
    while launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1; do
      i=$((i + 1))
      if [[ $i -ge 10 ]]; then
        echo "❌ label ${label} still present in ${DOMAIN} after bootout"
        exit 1
      fi
      sleep 0.3
    done
    echo "   ${label} removed from ${DOMAIN}"
  else
    echo "   ${label} not loaded (ok)"
  fi
  rm -f "${plist_path}"
}

# Prevent double-bot: retire legacy fable labels that share the same telegram token
case "$SERVICE_NAME" in
  elon-bot)
    unload_label "ai.2lab.soma.elon"
    ;;
  chaewon-bot)
    unload_label "ai.2lab.soma.chaewon"
    ;;
esac

# Unload previous install of this label if present
unload_label "${LABEL}"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>${CMD}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${WORKDIR_ABS}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH_VAL}</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${OUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${ERR_LOG}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF

echo "✅ macOS LaunchAgent installed (${LABEL})"
echo "   Env file: ${ENV_ABS}"
echo "   Plist: ${PLIST}"
echo "   Logs: ${OUT_LOG}"
echo "   Not started — run: ENV=${ENV_FILE} make start  (or make up)"
