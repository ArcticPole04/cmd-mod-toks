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
import type {LastRequest} from './measure.ts';

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read a stored `LastRequest`, or null when the value is absent or malformed.
 *
 * Every numeric field is checked for finiteness, not just type: `NaN` is still a
 * number, and a `NaN` rate would render as `0 tok/s`, which reads as a stall
 * rather than as damage.
 */
export function readStoredRequest(value: unknown): LastRequest | null {
	if (!isRecord(value)) return null;

	const {rate, output, ms, decodeMs, clamped, model, at} = value;
	if (!finite(rate) || rate < 0) return null;
	if (!finite(output) || output < 0) return null;
	if (!finite(ms) || ms < 0) return null;
	if (!finite(decodeMs) || decodeMs < 0) return null;
	if (!finite(at)) return null;
	if (typeof clamped !== 'boolean') return null;
	if (typeof model !== 'string') return null;

	const {ttftMs} = value;
	if (ttftMs !== null && !finite(ttftMs)) return null;

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
