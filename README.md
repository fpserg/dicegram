# DiceGram

Multiplayer crypto board game prototype. Players top up a GRAM balance, buy turns
(1 turn = 1 GRAM by default), roll a die and race their figurines across the board.
Cells can hold prizes, tasks (quizzes), chance cards, jumps, moves, free turns or
skipped rolls. Token prizes are locked while a game runs and become withdrawable
when it ends.

Zero dependencies — Node.js 20+ only.

## Two ways to run it

**1. No install (serverless app)** — `public/app.html`. The whole game runs in the
browser and keeps its state in a pluggable store (`public/standalone/store.js`):

- **On claude.ai as an Artifact** — uses the artifact's shared database, so it is real
  multiplayer across phones. The artifact owner sees the **Admin** button (board designer,
  games, players, withdrawals); people it's shared with just play.
- **Anywhere else** (GitHub Pages, a local file server) — single-device mode: state is
  saved in that browser only. Good for trying boards out. `.github/workflows/pages.yml`
  deploys it to GitHub Pages on every push to `main` (enable it once under
  Settings → Pages → Source: *GitHub Actions*).

In this mode the rules run on each player's device, so a determined player could cheat
(e.g. read quiz answers or edit their balance). Fine for test GRAM; real money needs
the server.

**2. Node server** (`npm start`) — the authoritative version: dice, task answers and
balances live on the server, with a REST API and live updates over SSE.

```sh
npm start          # http://localhost:3000  (player app)
                   # http://localhost:3000/admin  (admin app, token "admin")
npm test
```

| Env var       | Default        | Meaning                                              |
|---------------|----------------|------------------------------------------------------|
| `PORT`        | `3000`         | HTTP port                                            |
| `ADMIN_TOKEN` | `admin`        | Admin app password — **set it before exposing**      |
| `DEV_FAUCET`  | on             | `0` disables the free "+ Test GRAM" top-up           |
| `DB_FILE`     | `data/db.json` | JSON file holding all state                          |

## How it plays

1. **Player app** — pick a name, add test GRAM, open a game, join, buy turns, roll.
   Everyone in the game sees moves live (Server-Sent Events). Players roll whenever
   they have turns (a real-time race, not strict turn order).
2. Landing on a cell applies its effect. A **task** must be answered (or skipped)
   before rolling again; correct answers are checked on the server and the answer is
   never sent to clients.
3. The game ends when the configured number of players reach the finish, or when the
   admin ends it. Then: unused **paid** turns are refunded in GRAM, and the tokens won
   move to the player's withdrawable balance.
4. **Withdraw** — the player requests a withdrawal to a TON address; the admin pays it
   out manually and marks it paid (or rejects it, which returns the tokens).

## Admin app (`/admin`)

- **Boards** — visual designer: set grid size and colours, click empty squares to lay
  out the path, click a cell to set its type, label, colour and values (prize token and
  amount, steps, jump target, quiz question/options/answer/reward, chance outcomes).
  First cell is always Start, last is always Finish. Validated on the server.
- **Games** — create a game from a board (the board is copied, so later edits don't
  affect it), set turn price, max players, how many finishers end it, and finish prizes
  per place. Start / end / delete.
- **Players** — balances, prizes, manual GRAM adjustments.
- **Withdrawals** — mark paid with a tx hash, or reject.

## Cell types

| Type    | Effect                                                         |
|---------|----------------------------------------------------------------|
| prize   | win `amount` of `token` (locked until the game ends)           |
| move    | move `steps` forward (or back if negative)                     |
| jump    | teleport to cell `to` (ladder or snake)                        |
| bonus   | gain `turns` free (non-refundable) turns                       |
| skip    | the next `turns` rolls are wasted                              |
| task    | multiple-choice question; correct answer pays `reward` (+ free turns) |
| chance  | one random outcome: prize / move / bonus / skip / nothing      |

Effects don't chain: a move or jump does not trigger the cell it lands on (but
reaching the finish that way counts).

## Prototype limits / next steps

- Balances are an **off-chain ledger**; GRAM is added via the test faucet. To go live,
  replace `/api/wallet/faucet` with deposit detection (watch a TON deposit address /
  jetton transfers with a per-user memo) and pay withdrawals from a hot wallet.
- Auth is a random bearer token per browser (stored in localStorage). Use TON Connect
  (wallet signature) for real accounts.
- Storage is one JSON file and one process. Move to a real database (with
  transactions) before handling real money.
- Dice use `crypto.randomInt` on the server; consider commit-reveal for provable fairness.

## Layout

```
public/shared/engine.js   game rules (pure, unit-tested; shared by server and browser)
public/shared/demo.js     demo board
public/shared/board.js    SVG board renderer
public/app.html           serverless app (player + admin), see public/standalone/
public/index.html         player app for the Node server
public/admin/             admin app for the Node server
server/app.js             HTTP API, SSE, money ledger, static files
server/seed.js            demo board + game created on first start
test/                     node:test suites
```
