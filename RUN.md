# Running Tilewise on linuxbox

All commands run from the bot folder:

```sh
cd ~/Code/hackathons/scrabblebot-bot/bot
```

## First run (token from the team page)

```sh
BOT_NAME=Tilewise BOT_TOKEN="$(cat ~/.config/scrabblebot/token)" npm start
```

The bot saves the token to `.token-Tilewise` (git-ignored), so later runs need only `BOT_NAME=Tilewise`. To enter a tournament explicitly, add `TOURNAMENT_ID=<id>`. You don't need to: the bot registers itself for every tournament that is open for registration (status `Registration`) and that it hasn't entered yet. Ended tournaments are ignored.

```sh
BOT_NAME=<name> BOT_TOKEN=<token> TOURNAMENT_ID=<id> npm start
```

## In the background (survives closing the terminal)

`run.sh` restarts the bot when it crashes or the connection drops. `setsid` and `nohup` detach it from the terminal.

```sh
cd ~/Code/hackathons/scrabblebot-bot/bot
setsid nohup env BOT_NAME=Tilewise ./run.sh > bot.log 2>&1 < /dev/null & echo $! > bot.pid
```

Add `TOURNAMENT_ID=<id>` after `env` to register for a specific tournament on start.

Watch it:

```sh
tail -f bot.log | grep -v "→"          # bids, words, results
grep -E "WORD|RESULT" bot.log           # words played with rewards, final scores
```

## Restart without cutting into a match

```sh
touch restart.flag
```

At the next match end the bot sees the flag, deletes it and exits. `run.sh` then starts it again with the current code within about 5 seconds. Use this for every code change; a plain kill mid-match loses every auction until it reconnects.

## Stop it

```sh
kill -- -$(cat bot.pid)    # kills run.sh and the node process (one process group)
```

Run only one Tilewise process at a time. Check with
`ps -eo pid,args | grep "src/index.ts" | grep -v grep`.

## Currently running

The current PID is in `bot.pid`. It was started at the time recorded in the "Running now" note at the end of this file.
