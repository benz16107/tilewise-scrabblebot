# Tilewise

A bot for Clockwork Labs' [ScrabbleBot](https://github.com/clockworklabs/scrabblebot) game, written for the HackUTD 2026 ScrabbleBot tournament (team "Ben Zhou", bot "Tilewise").

## Strategy

- **Hold for 3x words.** Before the endgame it plays only words of 7+ letters, which earn the full 3x length multiplier. In the last few auctions (`cashAt`, by `match_state.bag_total`) it cashes in every word it can, best first, several at once.
- **Bid by value, not face.** Each letter's value is the rise in the rack's best-word score plus a face-value term for future long words. That value goes down for duplicates and for a Q without a U, and goes up when the rack needs vowels or consonants. In a Vickrey auction, bidding your value is the right play.
- **Spend the balance down.** Leftover balance scores nothing, so bids scale up when balance per remaining auction is high. In the endgame the bot bids its whole balance on any letter that adds to what it can cash in. It skips the last auctions, because a letter won there can't be played before the match ends.
- **Fast search.** At startup it builds an index from sorted letters to words and a prefix set. Finding the best word from a 19-tile rack takes about 100 ms.

The rules come from the module source in `spacetimedb/src/game.ts`. Bids above balance are refused. A letter nobody bids on is discarded, not returned to the bag. The match ends the moment the last auction closes, and later words are refused.

## Layout

- `bot/src/strategy.ts`: bidding and word choice (pure functions, tunable `PARAMS`)
- `bot/src/index.ts`: the SpacetimeDB client (narrow subscriptions, in-flight tile tracking, auto-registration for tournaments)
- `bot/src/sim.ts`: offline 6-bot match simulator using the module's rules
- `spacetimedb/`: the game module, needed by `npm run generate` and for the word list

## Run

```sh
cd bot
npm install
npm run generate
BOT_NAME=Tilewise BOT_TOKEN=<token from the team page> ./run.sh
```

`run.sh` restarts the bot after a crash or disconnect. See [RUN.md](RUN.md) for running it in the background.

Tests and simulator:

```sh
cd bot
npm test
npx tsx src/sim.ts 300 market   # vs bots bidding at live prices
npx tsx src/sim.ts 300 report   # vs the module's sim bots and the starter
```

## Credit

The client in `bot/src/index.ts` started as `bot-starter/` from [clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot). The `spacetimedb/` module and its word list also come from that repo. Both are MIT licensed (see `LICENSE`). The strategy, simulator and client changes are this repo's own.
