# Trivia Showdown

A Trivial Pursuit style board game you can play with friends over the internet.
One Node process serves both the game and the web client, so a single
`cloudflared` tunnel URL is all anyone needs to join.

- Six categories, six wedges, a wheel with six spokes and a hub
- Real board movement: you pick which way to go, and you can cut through the hub
- Multiple-choice questions (240 of them) with an optional answer timer
- Room codes, live game log, chat, and reconnect-without-losing-your-seat
- No build step, no database, one dependency (`ws`)

## Running it

```bash
npm install
npm start
```

The game is now at <http://localhost:3000>.

### Playing over the internet

In a **second terminal**, start the tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Cloudflared prints a URL like `https://random-words-here.trycloudflare.com`.
Share that with everyone playing — including yourself. Open it, enter a name,
click **Create a game**, and send the other players the 4-character room code
(the **Room** button in the top bar copies a direct invite link).

On WSL2, run both commands inside WSL. The server binds `0.0.0.0`, so
cloudflared reaches it on `localhost` without any port-forwarding setup.

The tunnel URL changes every time you restart cloudflared, so keep that terminal
open for the whole session.

### Options

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |

## How to play

Everyone starts in the hub. On your turn:

1. **Roll** the die.
2. **Choose where to land.** Every legal landing space lights up — you pick the
   direction. You cannot reverse partway through a move, but you may change
   direction between turns, and you can pass through the hub from one spoke into
   another.
3. **Answer the question** for the colour you landed on.
   - Correct → you roll again.
   - Wrong (or out of time) → your turn ends.

Special spaces:

- **Category headquarters** — the six large spaces around the wheel. Answer
  correctly here to win that category's wedge.
- **Roll Again** — the diamonds where each spoke meets the wheel. Free extra roll.
- **The hub** — once you hold every wedge, land here by exact count. An opponent
  chooses the category for one final question. Get it right and you win; get it
  wrong and you have to leave and come back.

A full six-wedge game runs long, same as the boxed version. Set **Wedges to win**
to 3 or 4 in the lobby for something that finishes in a single sitting.

### If someone drops out

Refreshing or losing connection is safe — reopening the URL puts you back in your
seat with your wedges and position intact. If a player goes quiet, the host gets
a **Skip turn** button, and any player can skip someone who is offline.

## Adding your own questions

Everything lives in [server/questions.js](server/questions.js). Append entries in
this shape — the first answer is the correct one, and the server shuffles the
options before sending them out:

```js
{ c: 0, q: "What is the capital of Australia?", a: ["Canberra", "Sydney", "Melbourne", "Perth"] },
```

`c` is the category: `0` Geography, `1` Entertainment, `2` History,
`3` Arts & Literature, `4` Science & Nature, `5` Sports & Leisure.

Restart the server to pick up changes. Each category is dealt from its own
shuffled deck that only reshuffles once exhausted, so you will not see the same
question twice in a game.

## Layout

```
server/
  index.js      HTTP + WebSocket server, static file serving
  rooms.js      room registry, socket fan-out, idle-room cleanup
  game.js       turn state machine, scoring, timers
  board.js      wheel geometry and the movement graph
  questions.js  the question bank
public/
  index.html    all the screens
  app.js        client state, rendering, input
  board.js      SVG board rendering
  style.css
```

The server is authoritative: it owns the dice, picks the questions, and never
sends the correct answer to anyone until the reveal.
