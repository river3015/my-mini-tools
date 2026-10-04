#!/bin/bash
# Register voice-input as a LaunchAgent so it starts at login.
# Usage: launchd/install.sh [uninstall]
set -euo pipefail

LABEL="io.github.river3015.voice-input"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/voice-input.log"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/voice_input.py"
# Run a fixed venv's Python directly instead of `uv run`. macOS grants
# permissions to the launched binary, and uv's Homebrew path changes on upgrade.
VENV="$HOME/.local/share/voice-input/venv"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  # bootout returns before the process exits.
  for _ in {1..10}; do
    pgrep -f "$SCRIPT" >/dev/null || break
    sleep 0.5
  done
fi

if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$PLIST"
  rm -rf "$VENV"
  echo "uninstalled $LABEL"
  exit 0
fi

# A second instance would react to the same hotkey.
if pgrep -f "$SCRIPT" >/dev/null; then
  echo "voice_input.py is already running. Stop it first (Ctrl+C in its terminal)." >&2
  exit 1
fi

uv venv --quiet --allow-existing --python 3.12 "$VENV"
uv export --quiet --script "$SCRIPT" --no-hashes |
  uv pip install --quiet --python "$VENV/bin/python" -r -

mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV/bin/python</string>
    <string>$SCRIPT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL (log: $LOG)"
echo "grant Microphone, Input Monitoring and Accessibility to:"
echo "  $(readlink -f "$VENV/bin/python")"
