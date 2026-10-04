#!/bin/bash
# Install VoiceInput.app to ~/Applications and register it as a LaunchAgent
# so it starts at login. Build the app first with macos/build.sh.
# Usage: launchd/install.sh [uninstall]
set -euo pipefail

LABEL="io.github.river3015.voice-input"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/voice-input.log"
BUILT_APP="$(cd "$(dirname "$0")/.." && pwd)/macos/build/VoiceInput.app"
APP="$HOME/Applications/VoiceInput.app"
BIN="$APP/Contents/MacOS/VoiceInput"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  # bootout returns before the process exits.
  for _ in {1..10}; do
    pgrep -f "$BIN" >/dev/null || break
    sleep 0.5
  done
fi
# Left over from the earlier Python-based agent.
rm -rf "$HOME/.local/share/voice-input/venv"

if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$PLIST"
  rm -rf "$APP"
  echo "uninstalled $LABEL"
  exit 0
fi

# A second instance would react to the same hotkey.
if pgrep -f "voice_input.py|$BIN" >/dev/null; then
  echo "voice-input is already running. Stop it first (Ctrl+C in its terminal)." >&2
  exit 1
fi

if [[ ! -d "$BUILT_APP" ]]; then
  echo "$BUILT_APP not found. Run macos/build.sh first." >&2
  exit 1
fi
mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
cp -R "$BUILT_APP" "$APP"

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
    <string>$BIN</string>
  </array>
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
echo "installed $APP as $LABEL (log: $LOG)"
