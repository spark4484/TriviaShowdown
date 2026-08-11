# Trivia Showdown

A Trivial Pursuit style board game you can play with friends over the internet.
One Node process serves both the game and the web client, so a single
`cloudflared` tunnel URL is all anyone needs to join.

- Six categories, six wedges, a wheel with six spokes and a hub
- Real board movement: you pick which way to go, and you can cut through the hub
- 900 multiple-choice questions across two difficulty tiers, plus an answer timer
- Two lifelines per player per game: 50:50, and phone-a-friend to a very small LLM
- Thumbs up/down on every question — enough downvotes and it stops being dealt
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
| `VOTES_FILE` | `data/votes.json` | Where question ratings are stored |
| `QUESTION_RETIRE_DOWNS` | `3` | Downvotes before a question can be retired |
| `QUESTION_RETIRE_RATIO` | `2` | How far downs must outweigh ups to retire |
| `LLM_URL` | `http://127.0.0.1:11434` | Where the lifeline model is served |
| `LLM_MODEL` | `qwen2.5:0.5b` | Model to ask |
| `LLM_API` | auto | `ollama` or `openai`; guessed from the URL |
| `LLM_TIMEOUT_MS` | `20000` | How long to wait before giving up on it |

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

### Lifelines

Each player gets **one of each, once per game**, spendable only on their own
question and only before they answer.

- **50:50** — two of the wrong answers are struck off the card, leaving the
  right one and a coin flip.
- **Ask the AI** — the question is put to a very small language model running on
  your own machine, and its reply goes up on the card for the whole room to see.
  The answer clock stops while it thinks.

The AI lifeline defaults to **qwen2.5:0.5b**, which is a half-billion-parameter
model and therefore not very good at trivia. That is the point — treat it as a
suggestion from an over-confident friend, not an oracle. It is often wrong,
occasionally right for the wrong reason, and reliably funny.

You need a model server running locally. Either works:

```bash
# Ollama (the default - nothing else to configure)
ollama pull qwen2.5:0.5b
ollama serve

# ...or any OpenAI-compatible server, e.g. LM Studio or llama.cpp
LLM_URL=http://127.0.0.1:1234/v1 LLM_MODEL=qwen2.5-0.5b-instruct npm start
```

If nothing is listening, the button greys out and everything else carries on as
normal — the lifeline is optional, not a dependency. If the model is reachable
but the call fails partway, the player gets the lifeline back.

### Difficulty

The lobby has three settings, and **Hard** is the default:

| Setting | Draws from | Feel |
| --- | --- | --- |
| Easy | 390 questions | General knowledge — most players get a good share |
| Hard | 510 questions | Pub-quiz final round, with plausible distractors |
| Mixed | all 900 | A bit of both |

Difficulty has a real effect on pacing, because a wrong answer ends your turn.
Median questions per two-player game, measured over simulated runs:

| Answer accuracy | 3 wedges | 4 wedges | 6 wedges |
| --- | --- | --- | --- |
| 75% | 50 | 76 | 153 |
| 50% | 89 | 102 | 268 |
| 30% | 138 | 202 | 332 |

So a full six-wedge game on Hard runs long, same as the boxed version on a slow
night. Set **Wedges to win** to 3 or 4 for something that finishes in a single
sitting — the lobby warns you when the combination is a marathon.

### If someone drops out

Refreshing or losing connection is safe — reopening the URL puts you back in your
seat with your wedges and position intact. If a player goes quiet, the host gets
a **Skip turn** button, and any player can skip someone who is offline.

## Adding your own questions

Everything lives in [server/questions.js](server/questions.js), split into an
`EASY` and a `HARD` array. Append entries to whichever fits — the difficulty tag
is applied automatically at the bottom of the file, so entries in both arrays
look identical. The first answer is the correct one, and the server shuffles the
options before sending them out:

```js
{ c: 0, q: "What is the capital of Australia?", a: ["Canberra", "Sydney", "Melbourne", "Perth"] },
```

`c` is the category: `0` Geography, `1` Entertainment, `2` History,
`3` Arts & Literature, `4` Science & Nature, `5` Sports & Leisure.

Restart the server to pick up changes. Each category is dealt from its own
shuffled deck that only reshuffles once exhausted, so you will not see the same
question twice in a game.

## Rating questions

Every question card has 👍 and 👎 buttons, and the **Questions** tab in the
sidebar keeps the last dozen questions the room has seen so you can rate one
after the card has gone. Clicking the same thumb twice takes your vote back.

Ratings are global and permanent — they are shared across every room and stored
in `data/votes.json`. Once a question reaches **3 downvotes with at least twice
as many downs as ups**, the server quietly stops dealing it. Nothing is deleted,
so raising `QUESTION_RETIRE_DOWNS` brings retired questions straight back.

One vote per player per question, deduplicated per room. To see what people have
been booing:

```bash
npm run ratings        # everything rated so far, worst first
npm run ratings -- 20  # just the 20 worst
```

That report is the eviction shortlist: fix the wording or delete the entry from
`server/questions.js`. Ratings are keyed on a hash of the question text, so
reordering the file is safe, but rewording a question resets its score — which
is what you want, since it is a different question afterwards.

If every question in a category and tier ends up retired, the server logs a
warning and deals from the unfiltered set rather than stranding the turn.

## Layout

```
server/
  index.js      HTTP + WebSocket server, static file serving
  rooms.js      room registry, socket fan-out, idle-room cleanup
  game.js       turn state machine, scoring, timers
  board.js      wheel geometry and the movement graph
  questions.js  the question bank
  votes.js      question ratings: tallies, persistence, retirement rule
  llm.js        the "ask a small model" lifeline, and whether it is reachable
scripts/
  ratings.js    "npm run ratings" - what players thought of each question
public/
  index.html    all the screens
  app.js        client state, rendering, input
  board.js      SVG board rendering
  style.css
```

The server is authoritative: it owns the dice, picks the questions, and never
sends the correct answer to anyone until the reveal.
