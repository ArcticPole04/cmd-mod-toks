# Prior work and attribution

This mod is MIT licensed (see `LICENSE`). It is an independent implementation, but two earlier
Command Code tok/s mods informed its measurement guards, and that should be stated rather than
left implicit.

## Measurement guards

Both projects are MIT licensed, and their notices are reproduced here as that license requires.

### cmd-footer

<https://github.com/iAziz786/cmd-footer> — MIT, Copyright (c) 2026 Mohammad Aziz.

Contributed the idea of a **plausibility ceiling**: a decode rate that implies a buffered,
flush-at-once delivery is not a decode timeline, so the measurement is rejected rather than
clamped or shown. This mod uses the same threshold (400 tokens per second) and the same
constant name, `MAX_PLAUSIBLE_RATE`.

The related span floor (`MIN_SPAN_MS`) takes the same shape from that project's
`MIN_RATE_SPAN_MS`, with a lower value chosen for the shorter window this mod uses.

### commandcode-tokenspeed-mod

<https://github.com/Usama3627/commandcode-tokenspeed-mod> — MIT, Copyright (c) 2026 Usama3627.

Contributed the **EMA time constant** used to smooth the live rate: `TAU_MS = 600`, applied as
`1 - Math.exp(-Δt / TAU_MS)`. The formula itself is standard exponential smoothing; the value and
its role here come from that project.

## Documentation

The single-file, anchor-linked bilingual README follows the convention already used by two other
mods, both MIT licensed:

- <https://github.com/holtwood/cmdc-statusline> — MIT, Copyright (c) 2026 holtwood.
- <https://github.com/jashjacob/commandcode-token-metrics> — MIT, Copyright (c) 2026 Jash Jacob.

## What is original here

No source code was copied. Specifically, the following are this mod's own design, and the defects
below were found by building and measuring it rather than inherited:

- **Sampling from `message_update` absolute counts** rather than from deltas. This is what makes the
  count invariant to stream fragmentation, lets a mid-stream retry self-correct as a shrinking
  total, and counts tool-call arguments that never arrive as a `text_delta`.
- **The median of per-frame contributions** as the representative rate, instead of window total
  divided by window span.
- **Excluding the opening frame** from the live rate: a measured run delivered 428 tokens in frame 0
  against a median of 3 for the remaining frames.
- **Widening the window** until it holds enough frames, so a provider emitting one frame per 200 ms
  still produces a reading.
- **Script-aware estimation** (CJK one token per character, other scripts 1/3.6).
- **Dual-candidate calibration**, which handles providers that bill reasoning tokens inside
  `outputTokens` and providers that do not.
- **Validating `cmd.state` values on read**, because that state outlives the process that wrote it.

The test suite is written against defects observed while building this mod: retry double-counting,
a single-frame reasoning burst, CJK under-reporting, one-character deltas, missing usage, providers
that exclude reasoning tokens, late first tokens, interruptions, and sparse streams.
