# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-17

First release.

### Added

- Live tokens-per-second reading beside the working spinner, and a footer line with the exact
  figure once a request finishes.
- `/toks` report with the last request's rate, token count, total and decode time, and time to
  first token.
- Runtime toggles (`/toks on`, `off`, `spinner`, `status`) that apply without restarting.
- Script-aware token estimation: CJK characters count as one token, others as 1/3.6.
- Calibration against the provider's reported `outputTokens`, with both billing styles handled
  (providers that include reasoning tokens in that figure and providers that do not).
- Phase label distinguishing reasoning from visible output.
- Stall detection: silence longer than two seconds reads as `stalled`, not as a decaying number.
- `lang` option (`en` / `zh`, default `zh`) and `/toks lang` at runtime. The footer line stays
  language-neutral (`tok/s` plus a clock) because it shares a row with the host's own English
  segments; the phase label, report and notices are localized.
- README and CHANGELOG in English and Chinese within a single file, matching the convention used by
  other Command Code mods.

### Fixed before first release

Found by reviewing the code against the TypeScript, code-review, API-design and hardening skills
rather than by running it:

- **A stored `lastRequest` was trusted after a type assertion only.** `cmd.state` outlives the
  process that wrote it, so a value from an older version — or a partial write — came back typed as
  `LastRequest` without a check. A stored string rendered `0 tok/s · undefined tokens · total NaNs`,
  and a `NaN` rate rendered as `0 tok/s`, which reads as a stall rather than as damage. Every field
  is now validated on read, including finiteness.
- **`/toks lang` was undiscoverable.** The argument worked but neither usage string mentioned it.
- **Language matching was exact-match only.** `EN`, `en-US` and ` en ` all silently fell back to
  Chinese; case, whitespace and a region suffix are now ignored.
- **`Copy` formatters took pre-formatted strings**, so `stalled('2.3s')` produced `2.3ss` and
  `firstToken('abc')` produced `abcms`. They take numbers now, and the unit is appended once.
- **Adding a language required four edits.** The copy table is a `Record<Lang, Copy>` and the lookup
  is a single index, so a new language touches the union and the table only.

### Attribution

Reviewed the implementation history against the MIT-licensed prior art it drew on. Two earlier
Command Code tok/s mods informed the measurement guards — `cmd-footer` (the plausibility ceiling and
its 400 tok/s threshold) and `commandcode-tokenspeed-mod` (the 600ms EMA time constant) — and both
are now credited in `NOTICE.md`, which also records what is original to this mod. The LICENSE
copyright line names the account this repository belongs to instead of "contributors".

### Authorship disclosed

The README now states that the implementation was produced with an AI coding agent under human
direction, and says what that means for the license: nothing in npm's terms or the mods hub schema
requires this, but MIT derives its force from copyright, and US case law is unsettled on whether
purely machine-generated code is copyrightable. The disclosure names which decisions were human and
points a compliance reader at the honest reading — source-available reference rather than a
warranted grant — instead of leaving the question to be discovered later.

### Design decisions worth recording

- **Sampling uses `message_update`, not deltas.** The event carries the whole partial message, so
  the count is invariant to stream fragmentation, a retried stream self-corrects as a shrinking
  absolute count, and tool-call arguments — which never arrive as a text delta — are counted.
- **Guards reject rather than clamp.** A rate above 400 tok/s means the reply was buffered and
  flushed in one burst. The reading is withheld; clamping would present a fabricated number with
  the same authority as a measured one.
- **The opening frame is excluded from the live rate.** Measured on a real run: 428 tokens in
  frame 0 against a median of 3 for the remaining frames. Including it as a delta invents a spike
  of several hundred tok/s.
- **The rate is the median of per-frame contributions, not the window total divided by its span.**
  One burst among steady frames should not define the window.

### Defects found and fixed during development

Each of these shipped in an earlier prototype and is now covered by a test:

- A mid-stream retry double-counted the withdrawn text, which then corrupted the calibration ratio
  permanently.
- A reasoning block arriving as one frame produced readings of 290–680 tok/s.
- CJK text divided by 4 under-reported by roughly 4×.
- One-character deltas each counted as a full token, over-reporting by 4×.
- A provider that omitted usage left the footer silently empty with no way to tell "never ran"
  from "ran and could not measure".
- Calibrating on the total estimate when the provider excluded reasoning tokens scaled every live
  reading down by 3×.
- A late first token shrank the decode span toward zero and reported up to 500,000 tok/s.
- An interrupted run left the window painting forever.
- Requiring three frames in the window hid every reading from a provider emitting one frame per
  200ms; the window now widens until it has enough frames.

[0.1.0]: https://github.com/ArcticPole04/cmd-mod-toks/releases/tag/v0.1.0
