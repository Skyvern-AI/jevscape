# Jev (TypeSafe System One) on RuneBench

This directory makes the RuneBench skill-XP tasks runnable with Jev, TypeSafe's
`jev-latest` model (`POST https://api.typesafe.ai/v1/systemone`).

## Why Jev needs its own harness

Every other model on the leaderboard plays through an agent CLI (OpenCode,
Claude Code, Codex, Gemini CLI). The model reads the task, calls the
`execute_code` MCP tool with TypeScript, reads the result, and iterates.

Jev cannot do any of that. It is a System One model: it takes a `state` (text
or JSON) and a map of typed questions, and returns calibrated answers.

| Question type | Returns |
|---|---|
| `choice` | one option out of a set you define, plus a probability for every option and a confidence |
| `noul` | the probability that a yes/no statement is true |
| `score` | a probability-weighted level on an ordered rubric |

It never generates text, so it cannot write code, name a tool, or explain
itself. TypeSafe's own guidance is to keep control flow, deterministic rules
and side effects in code, and to give the model narrow, structured decisions.

So the harness is the inverse of the OpenCode adapter: **code owns the
actuators, Jev owns the judgment.**

## Design

```
                 ┌────────────────────────────────────────────┐
                 │ controller.ts (Bun, inside the task sandbox)│
  game state ───►│  1. snapshot: compact JSON of the world     │
  (rs-sdk)       │  2. catalog: macro-actions whose hard       │
                 │     preconditions hold right now            │
                 │  3. ask Jev: choice("which action next?")   │──► TypeSafe API
                 │             + noul("eat first?") when hurt  │◄── answers
                 │  4. run the chosen macro-action for a burst │
                 │     (~20 s wall clock ≈ 2.7 game minutes)   │
                 │  5. log the outcome, repeat until time is up│
                 └────────────────────────────────────────────┘
```

**State** (`buildSnapshot`): task and clock, player position (with the
nearest known place and distance), hitpoints, all 16 skill levels, inventory
and coins, equipment, combat style, nearby NPCs / objects / ground items
grouped by name with distances and interaction options, the last six game
messages, the last six actions with their outcomes and XP, live progress
(best 15-second window so far), and a small reference table for the task
skill lifted from `rs-sdk/wiki/skills/*.md`.

**Catalog** (`catalog.ts`): 49 bounded routines built from `bot.*` and
`sdk.*` calls: chop (regular, oak, willow, yew, all within a few seconds of
Lumbridge castle) / net fish / fly fish / mine / smelt / smith / fletch / burn / cook /
bury / fight / cast / shoot / pickpocket (men, farmers, Al Kharid warriors,
Falador guards) / tan / craft, plus utilities (eat, rest to regenerate
hitpoints, drop gathered items the task does not consume, sell starting gear,
buy hammer / runes / needle / fly fishing rod and feathers / axe upgrades /
pickaxe, set combat style, equip bow, pick up knife or arrows). Places were
checked on the live map rather than copied from the wiki: the first Varrock
oak hub sent the bot past the dark wizards' circle, where a level-15
character dies in seconds. Each routine walks to its
place if needed, handles its mechanical preconditions (equipping the sword
and shield before a fight, paying the toll gate, clicking through the
tanner's pages) and repeats its unit action until the burst budget, an
exhaustion condition (inventory full, out of materials) or three consecutive
failures. Options are described with the same five fields (`what`, `where`,
`requires`, `gives`, `notes`) and state facts only: level required, XP per
unit, distance, what is consumed or produced. Nothing ranks them.

**Code-owned rules** (never delegated): hard preconditions filter the
catalog (level, tools, free inventory slots, coins); a routine that dead-ends
twice in a row, or is picked three times in a row without task XP, is
suppressed for 90 s; an instant dead end pauses the loop for 2 s so the API
is not spun; the bot eats at 3 HP if it has food; pickpocketing rests for
regeneration when hitpoints are low and there is no food; death waits for
respawn and is reported to the model as a recent event (the respawned
character keeps only three items). Jev's `eat_first` noul is composed in code
at a 0.6 threshold.

**Policies**: `jev` (the model), `random` (uniform over the same catalog,
seeded) and `first` (always the first available option) exist so a score can
be read against a floor produced by the identical actuators.

## Comparability caveats

* Jev never sees or writes code. Its score measures decision quality over a
  hand-built action space, not program synthesis. Treat the row as "Jev as
  the decision layer of a System One controller", not as a peer of the
  OpenCode rows.
* The catalog embeds game knowledge (locations, requirements, XP tables)
  that CLI agents have to discover by reading the wiki folder. The `random`
  policy shows how much of the score the catalog alone accounts for.
* Everything else matches the benchmark: the same rs-sdk server build at 8x
  speed, the same starting save, the same 15-minute clock, the same tracker
  and the same peak-window score normalized by 8 x 25. The sweep below ran
  on the local no-Docker runner rather than the Docker image, one isolated
  world per task.

## Results (15-minute skill tasks, local no-Docker runner, 2026-09-18)

Peak XP/min in the best 15-second window, normalized by 8x speed and the
25x XP multiplier, exactly as `check_skill_xp.ts` computes it. One run per
skill and policy. Every world ran at 20 ticks/s (sampled every 15 s, minimum
19.9). Policy `jev` used model `jev-1.13.0` with 20-second bursts; policy
`random` picked uniformly from the same catalog with the same code-owned
rules. Both used the same catalog build (sha256 669f1444...).

| Skill | jev peak XP/min | random peak XP/min | jev total XP | random total XP | jev level | random level | leaderboard best, any model | leaderboard median (16-skill models) |
|---|---|---|---|---|---|---|---|---|
| Attack | 130 | 210 | 259,000 | 87,000 | 79 | 64 | 166 (geminiflash) | 64 |
| Strength | 162 | 164 | 366,900 | 133,700 | 84 | 70 | 146 (haiku) | 68 |
| Defence | 158 | 192 | 315,700 | 82,700 | 82 | 63 | 98 (opus48-max) | 62 |
| Hitpoints | 41 | 74 | 82,842 | 86,187 | 63 | 64 | 58 (geminiflash) | 13 |
| Ranged | 0 | 64 | 0 | 6,900 | 1 | 29 | 168 (gemini) | 18 |
| Prayer | 38 | 47 | 37,462 | 10,800 | 51 | 34 | 52 (geminiflash) | 0 |
| Magic | 52 | 111 | 34,725 | 42,962 | 50 | 53 | 76 (opus) | 14 |
| Woodcutting | 574 | 806 | 808,000 | 542,062 | 95 | 90 | 574 (codex53) | 244 |
| Fishing | 920 | 725 | 648,000 | 372,250 | 92 | 84 | 465 (geminiflash) | 150 |
| Mining | 193 | 192 | 512,312 | 204,312 | 89 | 76 | 385 (codex53) | 298 |
| Cooking | 120 | 255 | 13,500 | 37,500 | 37 | 51 | 45 (opus45) | 0 |
| Fletching | 213 | 0 | 252,825 | 0 | 79 | 1 | 225 (gemini) | 0 |
| Crafting | 48 | 0 | 2,415 | 0 | 17 | 1 | 0 (codex53) | 0 |
| Smithing | 37 | 37 | 34,595 | 20,252 | 50 | 43 | 97 (gemini31) | 0 |
| Firemaking | 300 | 675 | 88,000 | 100,000 | 64 | 65 | 280 (sonnet45) | 140 |
| Thieving | 168 | 210 | 227,600 | 48,077 | 77 | 55 | 348 (opus48) | 96 |
| **Mean** | **197** | **235** | **230,242** | **110,919** |  |  | 118 (opus) | 85 |

Leaderboard mean of the per-skill peaks: random 235, Jev 197, best complete
leaderboard run 118 (Claude Opus). Jev's 16 tasks cost $0.17 (1,307
decisions, 4.1 M input tokens).

What the numbers say:

* **The catalog sets the floor.** A random choice over this action set beats
  every leaderboard model on the mean peak score. The catalog carries the
  game knowledge (where the safe trees are, that fly fishing exists, how to
  tan hides) that CLI agents must discover for themselves. Read the
  leaderboard comparison as "this action space is strong", not as "Jev is
  stronger than Opus".
* **Jev plays steadily; the metric pays for spikes.** Jev gained 2.1x the
  total XP of random (mean 230 k against 111 k) and reached higher levels in
  13 of 16 skills. But the score is the single best 15-second window, and
  random's sampling of axe upgrades, yew trees and higher-level pickpocket
  targets produced higher peaks in 9 skills. Jev kept repeating the action
  that had just worked: in Woodcutting it chopped willows for 56 bursts and
  never bought an axe or tried the yews; in Thieving it stayed on men for
  all 42 decisions with farmers, warriors and guards on offer.
* **Jev wins where a chain is needed.** Fishing 920 against 725 (sell gear,
  pickpocket for coins, buy a fly rod and feathers, fly fish, rebuy
  feathers), Fletching 213 against 0, Crafting 48 against 0 (cows, tanner,
  needle and thread, gloves). Every leaderboard model scored 0 on Crafting.
* **Harness bugs the sweep exposed** (fixed afterwards, see the re-runs):
  Ranged 0 because the fight routine equipped the sword before every fight
  and unequipped the bow; Crafting lost nine minutes behind the closed Al
  Kharid toll gate because the SDK walk has no time cap; the knife pickup
  waited 135 s per attempt and the knife was absent for random's whole
  Fletching run; the axe purchase was offered with a full inventory.

### Post-fix re-runs (catalog v3, same day)

After the sweep the fight routine equips by combat style, walks are capped at
25 s with an explicit Al Kharid gate exit, iron rocks were added for Mining,
purchases require a free slot and the knife pickup gives up after 15 s. The
three skills whose catalog changed were re-run under both policies:

| Skill | Jev v3 peak | random v3 peak | Jev v3 total XP | random v3 total XP | sweep values (Jev / random) |
|---|---|---|---|---|---|
| Ranged | 70 | 104 | 6,400 | 15,000 | 0 / 64 |
| Crafting | 62 | 69 | 6,555 | 5,520 | 48 / 0 |
| Mining | 367 | 368 | 818,562 | 361,375 | 193 / 192 |

Mining now sits next to the leaderboard best (385) under both policies. Ranged
stays low for both because the catalog has no arrow shop: after the 25
starting arrows the only supply is picking shot arrows back up. Crafting is
now positive under both policies (every leaderboard model has 0).

## Cost

Jev bills input tokens only ($0.042 per million). The 16-skill sweep above
made 1,307 decisions (11 to 228 per task, about 3.2 k tokens each) for 4.1 M
input tokens and $0.17 in total, about one cent per task. Latency was 0.3 to
1.4 s per decision.

## Running

### Local, no Docker

Runs the game stack straight from an rs-sdk checkout. Every task gets its own
world, like one benchmark container: an engine at `NODE_TICKRATE=50` on its
own ports, a gateway, the headless lite client (no Chromium), the shared skill
tracker and the same verifier arithmetic.

```bash
export TYPESAFE_API_KEY=...
agents/jev/local-bench.sh --rs-sdk ../rs-sdk --out runs/jev-local \
    --skills "Woodcutting Fishing Mining Thieving" --minutes 15 --policy jev --parallel 3
bun agents/jev/aggregate.ts --run jev=runs/jev-local --md runs/jev-local/results.md
```

Each task directory gets `agent/{controller.log,decisions.jsonl,jev-calls.jsonl,summary.json}`,
`tracking/skill_tracking.json`, `verifier/reward.{json,txt}`, `world/{engine,gateway}.log`
and `task.log`. `aggregate.ts` prints a markdown table against the published
15-minute leaderboard.

Two engine details matter for a clean start. The engine checkpoints every
online player into its market store (`data/market.sqlite`) and loads that in
preference to `data/players/main/<bot>.sav`, so each world gets its own store
through `GE_DATABASE`. And the pack checksum check is skipped with
`BUILD_VERIFY=false`, as the rs-sdk Dockerfile does.

Every world's real game speed is measured after login (`tickrate.ts`,
written to `world/ticks_per_second.txt` and the results table). The score
divides by 8x, so a starved engine gives a wrong number. A task is aborted
when the world runs under `MIN_TPS` (default 15 of the expected 20 ticks/s).
On a 10-core laptop, 4 worlds hold 20 ticks/s; 8 worlds on a busy machine
dropped to 4-6 ticks/s, which is why `--parallel` defaults low.

`dev-stack.sh up ../rs-sdk` brings up one world for ad-hoc work and
`diag.ts` runs a few mechanics checks (walk times, pickpocket, shop prices,
chop rate) against it.

### Watch it live (browser client + decision panel)

`agents/jev/live-stack.sh` runs one world with the browser's own 3D game client as the
bot's client, so the game you watch is the game the controller drives. A dashboard on
port 7790 shows the game on the left and Jev's decisions on the right: the offered
actions with Jev's calibrated probabilities, the chosen action and why the catalog
offered it, the state Jev saw, each outcome, and the controller log.

```bash
export TYPESAFE_API_KEY=...
agents/jev/live-stack.sh up ../rs-sdk --skill Woodcutting --minutes 30 --policy jev --bot skyvern --speed 1 --open
# ... watch at http://localhost:7790/ ...
agents/jev/live-stack.sh down ../rs-sdk
```

- `--speed 1|2|4|8` sets the engine tick to 400 ms / speed. 1 is real RuneScape speed; 8 is
  the benchmark's. The controller reads `GAME_SPEED` and scales its timeouts, the 15-second
  scoring window and the movement hint to match. Bursts default to 20 s at 8x and 60 s at 1x
  (`--burst-ms` overrides).
- `up` waits until a browser has opened the dashboard and the client is logged in, then starts
  the controller. Only one page may load the game client; `http://localhost:7790/?nogame=1`
  shows the panel alone.
- The controller appends every event to `<log-dir>/events.jsonl` (`start`, `deciding` with the
  full state snapshot and candidates, `decision` with the probability map, `outcome`, `log`,
  `summary`). `live.ts` streams that file over Server-Sent Events; `decisions.jsonl` and
  `summary.json` are unchanged.
- `bun bots/jev/observe-shot.ts out.png skyvern` saves a PNG of what the bot's client is
  rendering, through an observer connection.
- `--mode tick` (the live default) asks Jev on every game tick instead of once per burst.
  The running action is offered as CURRENT with how long it has run and what it has produced;
  the same answer keeps it running, a different answer aborts it (every long wait in the
  catalog observes the run's abort signal) and starts the new action at once. The call
  timeout is one tick (400 ms at 1x; `--jev-timeout-ms` overrides), so a slow call simply
  keeps the current action. At 1x this is 2.5 calls per second, about 24 M input tokens and
  $1 per hour. `--mode burst` is the benchmark loop. Timeouts, kept, switched and restart
  counts are in `summary.json`.
- Every decision carries a player status sampled each tick: `idle`, `moving`, `animating`,
  `in_combat`, `in_dialog` or `dead`, with `idle_for_seconds`, `seconds_since_last_xp`, the
  last server message and its age. It appears in `player`, in `current_activity` and in the
  CURRENT option's notes, together with `recent_events`: the last eight things that happened
  (actions started, server messages, XP drops, restarts, switches) with their age in seconds.
- No code rule acts on that status. Every poll asks Jev two things. `next_action` is the goal:
  the CURRENT action or another catalog action. Only a different goal stops the running action
  (that abort throws away its walking and set-up). `this_tick` is what to do right now without
  changing the goal: `do_nothing` (the normal answer), `close_dialog` when a dialog or window is
  open (its text and options are in the state), `eat_food` when hit points are down and food is
  in the inventory, or `restart_current` (stop the running action and start it again from
  scratch, re-clicking its target). `close_dialog` and `eat_food` run beside the running action;
  `restart_current` restarts it. The split exists because an idle spell was traced to Jev
  choosing `close_dialog` as a goal after a level-up: that aborted the fishing run, the re-fish
  clicked a spot that had just changed, and the player stood still until Jev restarted it 25 s
  later. The state explains that skilling is silent between attempts and that a target that
  moved or vanished (fishing spots move on a timer of 280 to 530 ticks) stays silent until it
  is re-clicked. In burst mode `close_dialog` and `eat_food` stay ordinary catalog actions.
- The status tells attack from skilling: `under_attack` when hitpoints fell in the last 6 s (with
  damage taken, last hit age and the target's name), `skilling` when the target is a fishing spot,
  tree or rock. Without this a dark wizard killing the character at Draynor looked like fishing,
  and Jev never chose `eat_food` or moved away. A death is a recent event, and
  `buy_small_fishing_net_port_sarim` lets Jev replace the net a death drops.
- In tick mode the fishing scripts click the spot once and hold (`ctx.hold`): they count catches
  but never re-click, never close dialogs and never give up on a quiet spot. Every re-click is
  Jev's `restart_current`, every dialog close is Jev's `close_dialog`. Burst mode keeps the
  benchmark behaviour (re-click after each XP drop). Woodcutting and mining scripts still
  re-click in both modes.
- rs-sdk's `walkTo` has no cancellation, so a switched action would keep walking in the
  background and fight the next one. `patches/rs-sdk-walkto-cancel.patch` adds an optional
  `AbortSignal` argument checked between steps; `live-stack.sh up` applies it to the rs-sdk
  checkout once. An unpatched SDK ignores the extra argument.
- XP is real RuneScape by default in the live stack: `--xprate 1` sets `NODE_XPRATE=1` (rs-sdk's
  own default is 25, the benchmark's multiplier), and `patches/rs-sdk-real-level-curve.patch`
  restores the real level curve (2^(level/7)) in the engine, which rs-sdk had changed to
  2^(level/10). `live-stack.sh up` applies the patch once; the dashboard's XP table matches it.
- `--poll-every N` asks Jev every N game ticks instead of every tick (the answer timeout
  defaults to the same interval). Jev also answers `poll_again_in_ticks` (N, 2N, 5 or 10) on
  every poll: the controller keeps the action running for that many ticks before it asks again. `summary.json` reports
  `polls_skipped`, `restarts`, `kept`, `switched` and `jev_timeouts`.
- The sidebar opens in a plain-language **Simple** view (current task, skill level, XP until the
  next level on the engine's own level curve, ranked choices with Jev's percentages, recent
  actions, total cost and time). The **Developer** toggle in the header shows the full state
  snapshot, the probability bars with confidence, latency and tokens, and the controller log.
- Jev returns no text, so the "thinking" shown is its probability distribution over the offered
  actions plus the code-owned rules (preconditions, suppression, safety) that shaped the offer.

### Harbor

```bash
PYTHONPATH=agents harbor run --agent-import-path 'jev_adapter:JevSystemOne' \
    -m typesafe/jev-latest -p tasks/woodcutting-xp-15m --env modal
```

The adapter uploads this directory to `/app/bots/jev`, runs the controller,
and converts `decisions.jsonl` into an ATIF `trajectory.json` with token and
cost metrics. The adapter imports cleanly and mirrors the OpenCode adapter's
upload and run steps, but it has not been run end to end: Docker is not
available on the machine the sweep ran on. `scripts/run-jev.sh` wraps the
Harbor call with a TypeSafe preflight.
