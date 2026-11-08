// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { chooseWord, decideBid, indexFor } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick
// Build the word index now, not on the first auction.
const t0 = Date.now();
indexFor(DICTIONARY);
console.log(`[${BOT_NAME}] word index: ${DICTIONARY.length} words in ${Date.now() - t0} ms`);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
// Letters in words sent but not yet confirmed, per match, so the bot never
// spends the same tile twice while a reducer call is in flight.
const inFlight = new Map<string, Map<string, number>>();
// Words the module refused, per match, with when; skipped for a while.
const refused = new Map<string, number>();
const REFUSED_RETRY_MS = 3000;
const registeredTournaments = new Set<string>();

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const t = Date.now();
  const bagTotal = conn.db.matchState.id.find(matchId)?.bagTotal;
  let amount = 0;
  try {
    amount = decideBid({
      letter,
      myBalance: participant.balance,
      myRack: rackForMatch(conn, matchId),
      bagTotal,
      dictionary: DICTIONARY,
    });
  } catch (e) {
    console.warn(`[${BOT_NAME}] decideBid threw: ${e}`);
  }
  const ms = Date.now() - t;
  if (ms > 150) console.warn(`[${BOT_NAME}] slow bid decision: ${ms} ms`);
  if (amount <= 0) return;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId}, bag ${bagTotal}, bal ${participant.balance})`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Set<bigint>();
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.add(p.matchId);
  }
  for (const matchId of matches) {
    const key = String(matchId);
    const held = inFlight.get(key) ?? new Map<string, number>();
    inFlight.set(key, held);
    const rack = rackForMatch(conn, matchId);
    for (const [l, n] of held) {
      const left = (rack.get(l) ?? 0) - n;
      if (left > 0) rack.set(l, left);
      else rack.delete(l);
    }
    const m = conn.db.matchState.id.find(matchId);
    const participant = participantForMatch(conn, matchId);
    // Several words can go out at once in the endgame cash-in.
    for (let guard = 0; guard < 8; guard++) {
      let word: string | null = null;
      try {
        word = chooseWord({
          myRack: rack,
          dictionary: DICTIONARY,
          bagTotal: m?.bagTotal,
          myBalance: participant?.balance,
        });
      } catch (e) {
        console.warn(`[${BOT_NAME}] chooseWord threw: ${e}`);
      }
      if (!word) break;
      const rk = `${key}:${word}`;
      if (Date.now() - (refused.get(rk) ?? 0) < REFUSED_RETRY_MS) break;
      for (const c of word) {
        held.set(c, (held.get(c) ?? 0) + 1);
        const left = (rack.get(c) ?? 0) - 1;
        if (left > 0) rack.set(c, left);
        else rack.delete(c);
      }
      console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}' (bag ${m?.bagTotal})`);
      const release = () => {
        for (const c of word!) {
          const n = (held.get(c) ?? 0) - 1;
          if (n > 0) held.set(c, n);
          else held.delete(c);
        }
      };
      conn.reducers
        .submitWord({ matchId, word })
        .then(release, (err: unknown) => {
          refused.set(rk, Date.now());
          release();
          logFailure(`playing '${word}'`)(err);
        });
    }
  }
}

// Register for every tournament open for registration that this bot
// hasn't entered yet. Once per tournament per process.
function autoRegister(conn: DbConnection) {
  if (myBotId === null) return;
  for (const t of conn.db.tournament.iter()) {
    if (t.status.tag !== "Registration") continue;
    const id = String(t.id);
    if (registeredTournaments.has(id)) continue;
    const entered = Array.from(conn.db.tournamentEntry.iter()).some(
      (e) => e.tournamentId === t.id && e.botId === myBotId,
    );
    registeredTournaments.add(id);
    if (entered) {
      console.log(`[${BOT_NAME}] already registered for tournament ${id}`);
      continue;
    }
    console.log(`[${BOT_NAME}] registering for tournament ${id}`);
    conn.reducers
      .registerForTournament({ tournamentId: t.id })
      .then(() => console.log(`[${BOT_NAME}] registered for tournament ${id}`))
      .catch((err: unknown) => {
        registeredTournaments.delete(id); // try again on the next change
        logFailure(`registering for tournament ${id}`)(err);
      });
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            console.log(`[${BOT_NAME}] claimed credential for bot id ${myBotId}`);
            subscribeMine(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      console.log(`[${BOT_NAME}] acting as bot id ${myBotId}`);
      subscribeMine(conn);
    })
    .onError((ctx) => {
      console.error(`[${BOT_NAME}] base subscription failed: ${ctx.event}`);
      process.exit(4);
    })
    // Small tables only. subscribeToAllTables pulls the server's whole
    // history (millions of auction rows) and stalls the bot.
    .subscribe([
      "SELECT * FROM bot_credential",
      "SELECT * FROM tournament",
      "SELECT * FROM lobby",
      "SELECT * FROM lobby_member",
    ]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.myRack.onDelete(() => tryPlayWord(conn));
  conn.db.tournament.onInsert(() => autoRegister(conn));
  conn.db.tournament.onUpdate(() => autoRegister(conn));
  conn.db.wordPlay.onInsert((_ctx, w) => {
    if (myBotId === null || w.botId !== myBotId) return;
    const p = participantForMatch(conn, w.matchId);
    console.log(
      `[${BOT_NAME}] WORD match ${w.matchId} '${w.word}' +${w.totalReward} (score ${p?.score}, bal ${p?.balance})`,
    );
  });
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    // Only our running matches; the subscription replays every past result.
    if (participantForMatch(conn, r.matchId) === null) return;
    if (conn.db.matchState.id.find(r.matchId)?.status.tag !== "Running") return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? r.winnerBotId === myBotId
          ? "ME"
          : String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    // bag_total drops every auction; the endgame cash-in keys off it.
    if (
      neu.status.tag === "Running" &&
      old.bagTotal !== neu.bagTotal &&
      participantForMatch(conn, neu.id) !== null
    )
      tryPlayWord(conn);
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        const p = participantForMatch(conn, neu.id);
        const tilesWon = Array.from(conn.db.auctionResult.iter()).filter(
          (r) => r.matchId === neu.id && r.winnerBotId === myBotId,
        ).length;
        const all = Array.from(conn.db.matchParticipant.iter())
          .filter((x) => x.matchId === neu.id)
          .map((x) => Number(x.score))
          .sort((a, b) => b - a);
        console.log(
          `[${BOT_NAME}] RESULT match ${neu.id}: score ${p?.score} bal ${p?.balance} tiles won ${tilesWon} | table ${all.join(",")}`,
        );
        // `touch restart.flag` asks for a restart at the next match end,
        // so new code never cuts into a match. run.sh starts it again.
        if (fs.existsSync("restart.flag")) {
          fs.unlinkSync("restart.flag");
          console.log(`[${BOT_NAME}] restart.flag found; exiting for restart`);
          process.exit(0);
        }
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

// Everything about this bot's own matches, filtered on the server.
function subscribeMine(conn: DbConnection) {
  const B = String(myBotId);
  const inMine = (t: string) =>
    `SELECT ${t}.* FROM ${t} JOIN match_participant mp ON ${t}.match_id = mp.match_id WHERE mp.bot_id = ${B}`;
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] match subscription applied`);
      bootstrapActivity(conn);
    })
    .onError((ctx) => {
      console.error(`[${BOT_NAME}] match subscription failed: ${ctx.event}`);
      process.exit(4);
    })
    .subscribe([
      `SELECT * FROM match_participant WHERE bot_id = ${B}`,
      `SELECT ms.* FROM match_state ms JOIN match_participant mp ON ms.id = mp.match_id WHERE mp.bot_id = ${B}`,
      inMine("auction"),
      inMine("auction_result"),
      "SELECT * FROM my_rack",
      `SELECT * FROM word_play WHERE bot_id = ${B}`,
      `SELECT * FROM tournament_entry WHERE bot_id = ${B}`,
    ]);
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  autoRegister(conn);
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

process.on("unhandledRejection", (e) => console.warn(`[${BOT_NAME}] unhandled rejection: ${e}`));
process.on("uncaughtException", (e) => console.warn(`[${BOT_NAME}] uncaught exception: ${e?.stack ?? e}`));

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error("connect error:", err.message);
      process.exit(3);
    })
    // run.sh restarts the process, which reconnects with the saved token.
    .onDisconnect(() => {
      console.log("disconnected; exiting so run.sh reconnects");
      process.exit(2);
    })
    .build();
}

main();
