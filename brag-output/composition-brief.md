# Hyperframes Composition Brief: Gatewright

## Objective
Create a short launch-style brag video for Gatewright — an evidence-gated work tracker
for coding agents — built entirely around the moment the tool refuses a stage move.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20.0s

## Source Material
- Project root: `/home/rahil/Projects/gatewright`
- Primary files read: `README.md`, `package.json`, `viewer/board.html` (`:root` theme),
  `docs/img/board.png`, `templates/stages.json`, `bin/gw.js` output
- Product name: Gatewright (`gw`)
- Tagline / strongest claim: **Work that earns its way forward.**
- Key UI moments to recreate: (1) the terminal refusal block from README "The refusal",
  (2) the dark board from `docs/img/board.png` with its column/card/chip grammar and the
  plain-English gate panel from README "Live board"
- Copy that must appear verbatim:
  - `$ gw move P1-01 built`
  - `target stage requirements are not met`
  - `needs at least 1 evidence entry`
  - `$ gw move P1-01 built --evidence abc1234 --evidence test/scheduler.test.js`
  - `P1-01  building → built  ·  evidence: abc1234, test/scheduler.test.js`
  - `Not met yet:` / `Someone must have claimed it` / `[Claim]` / `Needs at least one piece of evidence`
  - `Work that earns its way forward.`
  - `npm i -g gatewright`
  - `gatewright.dev · zero dependencies · MIT`

## Creative Direction
- Tone preset: polished
- Creative direction: a quiet dev-tool film built around one refusal — terminal-native, no salesmanship
- Interpretation: 4 scenes, long holds, soft crossfades, restrained motion. The product's literal
  output carries the copy, so on-screen prose is one short sans line per scene and never competes
  with the terminal. Confidence through restraint.
- Angle: Every tracker takes your word for it. This one doesn't. Show a real `gw move` rejected,
  the same command accepted the moment evidence is attached, then the board enforcing the identical
  gate with a mouse — refusing a drag in English and offering the button that clears it.
- Hook: at 2.12s, two seconds in, the tool tells its own user no, in its own danger red.
- Outro / punchline: wordmark, `Work that earns its way forward.`, `npm i -g gatewright`.
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign (the board's palette and chip grammar are the product's own)

## Visual Identity
From `viewer/board.html` `:root` dark theme.
- Background: `#17181a`; raised `#1f2124`; sunken `#131415`; border `#33363a`
- Text: `#e7e7e4`; dim `#a3a39c`; faint `#8e8e88` (the product's `#6e6e68`, lifted to clear WCAG AA)
- Accent: `#6badde` (accent-bg `#1d3245`); danger `#e0806e`; ok `#7fc394`; warn `#d8b458`
- Display font: mono — Gatewright is a CLI, so mono is its display face. Embedded locally as
  `@font-face` "GW Mono" (Noto Sans Mono Regular/Medium/Bold, OFL, copied into `assets/fonts/`):
  the render browser resolves `ui-monospace` and bare `monospace` to a sans face, which silently
  destroyed the terminal identity in the first render.
- Body font: `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`
- Visual references from the project: the terminal refusal block; the board header with
  `30 items · 24 open · 7 flagged`; columns Backlog / Specified / Building / Built with counts;
  cards carrying mono ID, title, type chip, `ev:n` chip, `blocked` chip.

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. The refusal — 0.00→6.34s — command types, refusal block lands at 2.12s and holds; sans line
   `A tracker that says no.` at 4.23s.
2. Evidence earns it — 6.34→10.54s — same terminal, same frame; the two `--evidence` flags type on,
   the green accepted line lands at 8.44s; sans line `Evidence, or it doesn't move.`
3. The board does the same thing — 10.54→15.81s — dark board reveals; card `P1-01` drags
   Building→Built and lands at 12.65s with `ev:0`→`ev:2`; gate panel reveals two lines at
   13.18s and 13.70s and holds the set.
4. Work that earns its way forward — 15.81→20.00s — wordmark, tagline, install line; hold, still.

## Audio
- Audio role: sparse professional accents over a low, restrained bed
- Audio arc: bed sits under the terminal, lifts slightly for the board, fades out under a still wordmark
- Music: `assets/music/happy-beats-business-moves-vol-9-by-ende-dot-app.mp3` (114.84 BPM)
- Music treatment: starts at 0.0s at ~0.20 gain, small lift into the board scene, fade 18.5s → 0 at 20.0s
- Music cue guidance: bundled preset
  `~/.claude/skills/brag/assets/music/cues/happy-beats-business-moves-vol-9-by-ende-dot-app.music-cues.json`.
  Strong cues to lock: **4.23s**, **8.44s**, **10.54s**, **12.65s**. Grid beats used: 2.12s (refusal),
  13.18s / 13.70s (gate panel lines), 15.81s (wordmark).
- Audio-reactive treatment: subtle. Pre-extracted per-frame bands (`assets/audio-data.json`, trimmed to
  600 frames) drive a `--energy` / `--sparkle` custom property on the root: terminal panel glow and
  board card presence breathe on bass; the outro rule brightens faintly on treble. No waveform,
  equalizer, note graphics, strobing, or text scaling.
- Audio-coupled moments:
  - Scene 1 typing — quiet key ticks under the typed command
  - Scene 1 refusal (2.12s) — one dry warm impact, not a buzzer
  - Scene 2 accepted line (8.44s) — one soft confirm
  - Scene 3 card landing (12.65s) — card-slide
  - Scene 3 gate panel lines (13.18s, 13.70s) — two tiny interface clicks
  - Scene 4 wordmark (15.81s) — one restrained soft impact
- SFX selection guidance: motion-matched and sparse; warm / low-HF-risk files only.
- SFX analysis guidance: `~/.claude/skills/brag/assets/sfx/sfx-analysis.md`. Selected from the
  low-risk picks: `impact/impactSoft_medium_002.ogg`, `interface/bong_001.ogg`,
  `interface/click_003.ogg`, `casino/card-slide-1.ogg`, `impact/impactSoft_heavy_002.ogg`,
  `keyboard/keypress-003|007|011.wav`.
- Exact SFX choice: timestamps and gains set against the implemented animation.
- Audio files: copied into `brag-output/composition/assets/`.
- Restraint rule: no whooshes on crossfades, no riser into the outro, no drop. The refusal is dry.

## Hyperframes Instructions
Built with `hyperframes-core` (monolithic standalone composition, `data-*` timing),
`hyperframes-animation` / `hyperframes-keyframes` (seek-safe GSAP on one paused timeline),
`hyperframes-creative` (audio-reactive per-frame sampling), `hyperframes-cli` (check + render).
Gate: `npx hyperframes check` with zero errors before render.
