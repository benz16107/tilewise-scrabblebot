#!/usr/bin/env bash
# Keeps the bot running: restarts it after a crash or a dropped connection.
# Usage: BOT_NAME=Tilewise BOT_TOKEN=... ./run.sh   (BOT_TOKEN only needed once)
cd "$(dirname "$0")"
while true; do
  npx tsx src/index.ts
  echo "[run.sh] bot exited with $? at $(date); restarting in 3 s"
  unset BOT_TOKEN # the saved .token-$BOT_NAME is used from now on
  sleep 3
done
