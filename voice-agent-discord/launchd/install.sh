#!/bin/bash
# Register the local version (local.js) as a LaunchAgent so it starts at login
# and restarts when it crashes.
# Usage: launchd/install.sh [stop|uninstall]
#   (none)     install or reinstall, then start
#   stop       stop until the next login (or until install is run again)
#   uninstall  stop and remove the LaunchAgent
set -euo pipefail

LABEL="io.github.river3015.voice-agent-discord"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/voice-agent-discord.log"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$HOME/.config/voice-agent-discord/bot.pid"
DOMAIN="gui/$(id -u)"

# PID of the bot holding the lock (local.js, bot.js or echo.js), if it is running.
running_pid() {
  local pid
  pid=$(cut -d' ' -f1 "$LOCK" 2>/dev/null) || return 1
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  # bootout returns before the process exits.
  for _ in {1..20}; do
    running_pid >/dev/null || break
    sleep 0.5
  done
fi

case "${1:-}" in
  stop)
    echo "stopped $LABEL (it starts again at the next login)"
    exit 0
    ;;
  uninstall)
    rm -f "$PLIST"
    echo "uninstalled $LABEL"
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: $0 [stop|uninstall]" >&2
    exit 2
    ;;
esac

# Two bots with the same token would both join the voice channel.
if pid=$(running_pid); then
  echo "$(cut -d' ' -f2 "$LOCK") (pid $pid) is already running. Stop it first (Ctrl+C in its terminal)." >&2
  exit 1
fi

# launchd starts jobs with a minimal PATH. Resolve the commands here and pass their directories.
path_dirs=()
for cmd in node claude git swiftc security; do
  bin=$(command -v "$cmd") || { echo "$cmd not found in PATH" >&2; exit 1; }
  d=$(dirname "$bin")
  [[ " ${path_dirs[*]} " == *" $d "* ]] || path_dirs+=("$d")
done
for d in /usr/bin /bin /usr/sbin /sbin; do
  [[ " ${path_dirs[*]} " == *" $d "* ]] || path_dirs+=("$d")
done
LAUNCH_PATH=$(IFS=:; echo "${path_dirs[*]}")
NODE=$(command -v node)

[[ -d "$DIR/node_modules" ]] || (cd "$DIR" && npm install)

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
    <string>$NODE</string>
    <string>$DIR/local.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$LAUNCH_PATH</string>
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
