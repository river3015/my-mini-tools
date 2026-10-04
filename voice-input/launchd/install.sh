#!/bin/bash
# Register voice-input as a LaunchAgent so it starts at login.
# Usage: launchd/install.sh [uninstall]
set -euo pipefail

LABEL="io.github.river3015.voice-input"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/voice-input.log"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/voice_input.py"
UV="$(command -v uv)"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
fi

if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

# A second instance would react to the same hotkey.
if pgrep -f "$SCRIPT" >/dev/null; then
  echo "voice_input.py is already running. Stop it first (Ctrl+C in its terminal)." >&2
  exit 1
fi

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
    <string>$UV</string>
    <string>run</string>
    <string>--script</string>
    <string>$SCRIPT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$UV"):/usr/bin:/bin:/usr/sbin:/sbin</string>
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
