# Brag Plan: Gatewright

## What is this app?
Gatewright (`gw`) is an evidence-gated work tracker for coding agents: a file-first,
zero-dependency CLI plus a live board where a card cannot reach "Built" unless it
carries proof — a commit, a test path, a PR link — and the tracker refuses the move
out loud when it doesn't.

## The angle
Every tracker takes your word for it. This one doesn't.

The whole video is built around one thing no other tracker does: **the refusal**.
We show a real `gw move` getting rejected, the same command succeeding the moment
evidence is attached, and then the board doing the same thing with a mouse — refusing
a drag in plain English and offering the button that clears it. Nothing abstract, no
diagrams of pipelines. The product's own terminal output is the script.

## Hook (first 2-3 seconds)
A dark terminal. `gw move P1-01 built` types in fast and Enter lands at 1.6s.
At 2.1s the refusal slams in, in Gatewright's own danger red:

```
target stage requirements are not met
needs at least 1 evidence entry
```

The hook is a tool telling its own user no, two seconds in. That's the whole promise.

## Key moments (the middle)
- The same command, retyped with `--evidence abc1234 --evidence test/scheduler.test.js`,
  succeeding on a green line: `P1-01  building → built  ·  evidence: abc1234, test/scheduler.test.js`
- The dark board — real columns, real card IDs from the shipped screenshot — with a card
  dragged from Building into Built and landing on the beat.
- The board refusing a drag the same way the CLI does, in English, with the action
  attached: `Someone must have claimed it  [Claim]` / `Needs at least one piece of evidence`.

## Outro / punchline
Wordmark, then the line the README leads with: **Work that earns its way forward.**
Then `npm i -g gatewright` and `gatewright.dev · zero dependencies · MIT`.

## User flow worth showing
Entry → key action → result, and it is the centerpiece:
1. Agent tries to advance an item: `gw move P1-01 built` — **refused**.
2. Agent attaches evidence and reruns — **accepted**, one green line.
3. A human watches the card land in Built on the live board, and sees the same gate
   refuse a different card by name.

## Tone
- Preset: polished
- Creative direction: a quiet dev-tool film built around one refusal — terminal-native, no salesmanship
- Interpretation: 4 scenes, long holds, soft crossfades, restrained motion. The product's
  literal output carries the copy, so on-screen prose is minimal — one short line per scene,
  never competing with the terminal. Confidence through restraint, not energy.

## Format: landscape — 1920x1080
## Duration: 20.0s

## Visual identity (from the project)
Taken from `viewer/board.html` `:root` dark theme (the board ships light and dark; dark is
the stronger frame and matches the shipped screenshots in `docs/img/`).
- Background: `#17181a` (raised surfaces `#1f2124`, sunken `#131415`)
- Border: `#33363a`
- Accent: `#6badde`
- Text: `#e7e7e4` (dim `#a3a39c`, faint `#8e8e88` — the product's `#6e6e68` lifted to clear WCAG AA)
- Danger (the refusal): `#e0806e`  ·  OK (the accepted move): `#7fc394`  ·  Warn: `#d8b458`
- Display font: mono — Gatewright is a CLI, so mono *is* its display face. IDs, evidence and
  stage names are always mono. Shipped as an embedded `@font-face` (Noto Sans Mono, OFL) because
  the render browser resolves both `ui-monospace` and bare `monospace` to a sans face.
- Body font: system sans — `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial`
- Strongest visual element: the refusal block — two lines of `#e0806e` under a typed command
  on `#131415`. Second strongest: the board's column-and-card grid from `docs/img/board.png`.

## Share copy (draft)
Most trackers believe you. Gatewright makes you prove it — `gw move` refuses the stage
until you attach the commit, the test, or the PR. File-first, zero dependencies, MIT.

## Audio direction
- Role: sparse professional accents over a low, restrained bed
- Music: `happy-beats-business-moves-vol-9-by-ende-dot-app.mp3` (114.84 BPM) — held well under
  the terminal, present as pulse rather than melody
- Music treatment: start at 0.0s, low bed (~0.18-0.22 gain), no rise on the refusal, a small
  lift into the board scene, fade out from ~18.5s to silence at 20.0s
- Music cue guidance: preset read from `assets/music/cues/happy-beats-business-moves-vol-9-by-ende-dot-app.music-cues.json`.
  Target strong cues: **4.23s** (the "A tracker that says no." line), **8.44s** (the accepted
  green line), **10.54s** (board reveal), **12.65s** (card lands in Built). Grid beats used for
  the refusal hit (**2.12s**) and the outro wordmark (**15.81s**). Sequential reveals use the
  ~0.52s grid only for the two-line gate panel (13.18, 13.70) and then hold the full set.
- Audio-reactive treatment: subtle; let bass gently modulate the terminal's vignette/glow and
  the board's card presence. No waveform, equalizer, or note graphics. Nothing that moves text.
- SFX posture: sparse and motion-matched — key ticks under typing (quiet, not per-character
  clatter), one dry negative tick on the refusal, one soft confirm on the accepted line, one
  card-set sound when the card lands in Built, one restrained mark on the wordmark. Five cues total.
- Audio-coupled moments: the two typed commands, the refusal hit, the green success line, the
  card landing in Built, the wordmark.
- Restraint rule: no whooshes on crossfades, no riser into the outro, no drop. The refusal is a
  dry tick, not a buzzer — the joke is that the tool is calm about saying no.

## Storyboard

### Scene 1 — The refusal — 6.34s (0.00 → 6.34)
Full-frame terminal on `#131415` with a faint vignette. Prompt `$` in `#6e6e68`.
`gw move P1-01 built` types in mono `#e7e7e4` from 0.30s to 1.40s; cursor blinks; Enter at 1.60s.
At **2.12s** the refusal appears as a block, both lines together, in `#e0806e`:
`target stage requirements are not met` / `needs at least 1 evidence entry`.
Held, unmoving, until 6.34s. At **4.23s** a single sans line fades in below, `#a3a39c`,
small: `A tracker that says no.` (5 words, holds 2.1s).
Sequential/interaction: yes — the command types character-group by character-group, then the
refusal lands as one block (not line-by-line; it must read as a single rejection).
Audio intent: quiet, matter-of-fact. The refusal should feel like a fact, not an alarm.
Audio-coupled idea: soft key ticks under the typing; one dry low negative tick on the refusal.
Music: low bed, no lift.
Transition mood: clean (soft 0.5s crossfade, terminal stays put) → Scene 2

### Scene 2 — Evidence earns it — 4.20s (6.34 → 10.54)
Same terminal, same position — the frame does not cut away, which is the point.
From 6.55s the command retypes and extends: `gw move P1-01 built --evidence abc1234 --evidence test/scheduler.test.js`,
with the two `--evidence` flags in accent `#6badde`. Enter at 8.20s.
At **8.44s** the success line lands in `#7fc394`:
`P1-01  building → built  ·  evidence: abc1234, test/scheduler.test.js`.
At 8.90s the sans line replaces Scene 1's: `Evidence, or it doesn't move.` (5 words, holds 1.6s).
Sequential/interaction: yes — the flags type on after the base command so the viewer sees
*what changed* rather than a new command appearing.
Audio intent: resolution without triumph. One step up, not a win chime.
Audio-coupled idea: key ticks under the retype; one soft confirm tick on the green line.
Music: bed continues, very slight lift.
Transition mood: soft (0.5s crossfade with a small 0.97→1.0 scale settle) → Scene 3

### Scene 3 — The board does the same thing — 5.27s (10.54 → 15.81)
Cut to the dark board on `#17181a`: header `gatewright`, four visible columns —
**Backlog · Specified · Building · Built** — with real cards recreated from `docs/img/board.png`
(`P2-01 Reject / clamp / halt / fault / disarm policy table`, `P0-04 AGENTS.md block for the codex
adapter`, `P3-01 Jog network transport and clock conversion policy`, `P1-04 Memory recall trimming
should respect max_chars`), each with its mono ID, type chip and `ev:` count.
Board reveals at **10.54s**. From 11.6s a cursor drags card `P1-01` from Building toward Built;
it lands at **12.65s**, its `ev:0` chip flipping to `ev:2` in `#7fc394`.
Then the gate panel appears over a *different* column, two lines revealed at **13.18s** and
**13.70s**, and the full set holds until 15.81s (2.6s from the first line):
`Someone must have claimed it   [Claim]` / `Needs at least one piece of evidence`, with `[Claim]`
drawn as a real accent button in `#6badde` / `#1d3245`.
Sequential/interaction: yes — a simulated cursor drag-and-drop, then a two-line panel revealed
one line at a time on the beat grid and held as a set.
Audio intent: tactile and physical. The board is a thing you touch.
Audio-coupled idea: a soft card-set sound on the landing; one quiet interface tick per panel line.
Music: bed at its fullest here, still under everything.
Transition mood: soft (0.6s crossfade to near-black) → Scene 4

### Scene 4 — Work that earns its way forward — 4.19s (15.81 → 20.00)
Near-black `#131415`. Centered.
At **15.81s** the wordmark `gatewright` settles in — mono, `#e7e7e4`, generous letter-spacing,
a fine `#33363a` rule beneath.
At 16.86s, sans `#a3a39c`: `Work that earns its way forward.` (6 words, holds 3.1s).
At 17.91s, a small mono line in `#6badde`: `npm i -g gatewright`, and under it in `#6e6e68`:
`gatewright.dev · zero dependencies · MIT` (holds 2.1s).
Hold the full lockup to 20.00s. Nothing else moves.
Sequential/interaction: yes — three elements arrive in order, then the frame is still.
Audio intent: settle and stop. No swell.
Audio-coupled idea: one restrained mark on the wordmark; silence under the install line.
Music: fade from 18.5s to silence at 20.00s.
Transition mood: n/a — end on the held lockup.

**Music mood for this video:** restrained/professional — an upbeat business bed held deliberately low
**Audio summary:** A quiet bed carries typing and two terminal verdicts, lifts just enough for the
board to feel tactile, and fades out under a still wordmark — five sparse SFX total, none of them celebratory.
