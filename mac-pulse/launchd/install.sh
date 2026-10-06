#!/bin/bash
# Run the mac-pulse collector every minute as a LaunchAgent.
# Usage: launchd/install.sh [uninstall]
set -euo pipefail

LABEL="io.github.river3015.mac-pulse"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/mac-pulse.log"
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/collector/mac_pulse.py"
PYTHON="/opt/homebrew/bin/python3"
DOMAIN="gui/$(id -u)"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
fi

if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

if [[ ! -f "$HOME/.config/mac-pulse/config.toml" ]]; then
  echo "~/.config/mac-pulse/config.toml not found. Copy collector/config.example.toml first." >&2
  exit 1
fi
# Fails early (with a message) when the token is not in the Keychain.
security find-generic-password -s mac-pulse-token >/dev/null

mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$SCRIPT</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL (log: $LOG)"
