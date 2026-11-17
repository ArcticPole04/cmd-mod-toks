/**
 * Pure string building for every surface the mod paints: the spinner suffix, the
 * footer status line, and the `/toks` report.
 *
 * No mod-API imports and no clock reads, so the exact bytes shown are unit
 * testable. All prose comes from `copy.ts`, so this module holds layout only.
 */

import type {Copy} from './copy.ts';
import type {LastRequest, LiveReading} from './measure.ts';

/** Wall-clock time of day, `HH:MM`, in the local timezone. */
export function clockOf(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}

/** One decimal below 100, whole numbers above; never a trailing `.0`. */
export function formatRate(rate: number): string {
	if (!Number.isFinite(rate) || rate <= 0) return '0';
	const rounded = Math.round(rate * 10) / 10;
	if (rounded >= 100) return String(Math.round(rounded));
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** The suffix drawn beside the host's working spinner. */
export function liveLabel(
	reading: LiveReading,
	copy: Copy,
): {text: string; color: 'cyan' | 'yellow'} {
	if (reading.stalledFor !== null) {
		return {
			text: `⚡ ${copy.stalled(reading.stalledFor / 1000)}`,
			color: 'yellow',
		};
	}

	const phase = reading.phase === 'thinking' ? copy.thinking : copy.writing;
	return {
		text: `⚡ ~${formatRate(reading.rate)} tok/s · ${phase}`,
		color: 'cyan',
	};
}

/** The footer segment written once a request finishes. */
export function statusLabel(last: LastRequest): string {
	return `⚡ ${formatRate(last.rate)} tok/s · ${clockOf(last.at)}`;
}

/**
 * The `/toks` report: what happened last time, and whether a request is running
 * now. Kept on one line so it reads like a status row rather than a paragraph.
 */
export function describe(
	input: {last: LastRequest | null; measuring: boolean},
	copy: Copy,
): string {
	const {last, measuring} = input;

	if (last === null) {
		return measuring ? copy.measuring : copy.nothingMeasured;
	}

	const name = last.model ? `${last.model} · ` : '';
	const firstToken = last.ttftMs === null ? '' : copy.firstToken(last.ttftMs);
	const note = last.clamped ? copy.clampedNote : '';
	const prefix = measuring ? copy.previousPrefix : '';

	return (
		`${prefix}${name}${formatRate(last.rate)} tok/s` +
		copy.tokens(last.output) +
		copy.durations(last.ms / 1000, last.decodeMs / 1000) +
		`${firstToken}${note} · ${clockOf(last.at)}`
	);
}

export function surfaceLabel(name: 'status' | 'spinner', copy: Copy): string {
	return name === 'status' ? copy.statusSurface : copy.spinnerSurface;
}
