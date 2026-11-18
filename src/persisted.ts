/**
 * Validation for values read back out of `cmd.state`.
 *
 * `cmd.state` survives `/reload` and session resume, so what comes back was
 * written by an earlier process — an older version of this mod, or a run that
 * was interrupted mid-write. A generic `get<T>()` is a type assertion, not a
 * check: it hands the value over with the shape the caller asked for regardless
 * of what is actually stored. Validating here is what keeps a stale shape from
 * reaching the renderer, where it would paint `NaN` and `Invalid Date` instead
 * of failing.
 */

import {isRecord} from './events.ts';
import {MAX_PLAUSIBLE_RATE} from './measure.ts';
import type {LastRequest} from './measure.ts';

/**
 * The largest `at` `Date.now()` can return, and the smallest negative one. A
 * stored timestamp beyond this range renders as `Invalid Date`.
 */
const MAX_AT = 8.64e15;

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read a stored `LastRequest`, or null when the value is absent or malformed.
 *
 * Every numeric field is checked against the same invariants the writer uses
 * (`finalizeRequest`), not merely for finiteness: a `NaN` rate would render as
 * `0 tok/s`, which reads as a stall rather than as damage, and a rate above
 * `MAX_PLAUSIBLE_RATE` would read as a speed no model can sustain. The writer
 * rejects these outright, so accepting them on read would let a stale write
 * through that the mod itself would never produce.
 */
export function readStoredRequest(value: unknown): LastRequest | null {
	if (!isRecord(value)) return null;

	const {rate, output, ms, decodeMs, clamped, model, at} = value;
	if (!finite(rate) || rate <= 0 || rate > MAX_PLAUSIBLE_RATE) return null;
	if (!finite(output) || output <= 0) return null;
	if (!finite(ms) || ms < 0) return null;
	if (!finite(decodeMs) || decodeMs <= 0) return null;
	if (!finite(at) || at < -MAX_AT || at > MAX_AT) return null;
	if (typeof clamped !== 'boolean') return null;
	if (typeof model !== 'string') return null;

	const {ttftMs} = value;
	if (ttftMs !== null && (!finite(ttftMs) || ttftMs < 0)) return null;

	return {
		rate,
		output,
		ms,
		decodeMs,
		ttftMs: ttftMs === null ? null : ttftMs,
		clamped,
		model,
		at,
	};
}
