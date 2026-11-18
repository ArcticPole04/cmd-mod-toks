/**
 * Pure measurement logic: token estimation, the live rate window, calibration
 * against the provider's reported usage, and the guards that reject untrustworthy
 * readings.
 *
 * No mod-API imports and no rendering, so every branch here is unit testable.
 */

import {isRecord} from './events.ts';

/**
 * Rolling window the live rate averages over. Long enough that a provider burst
 * cannot dominate a single frame, short enough that the first reading appears
 * quickly instead of after a fixed wait.
 */
export const WINDOW_MS = 600;
/** A span shorter than this cannot resolve a rate. */
export const MIN_SPAN_MS = 250;
/** Below this much growth over the window there is nothing meaningful to show. */
export const MIN_LIVE_GROWTH = 3;
/**
 * Protects against a provider that hands over one large block instead of
 * streaming: a real decode fills the window with several frames, a buffered
 * flush fills it with one. Three frames is the minimum that is unambiguously
 * streamed — a provider emitting every 200ms puts exactly three in a 600ms
 * window, and rejecting that would hide a genuinely slow stream.
 */
export const MIN_WINDOW_FRAMES = 3;
/** Time constant for the EMA that absorbs residual jitter. */
export const TAU_MS = 600;
/** Silence after which the stream reads as stalled rather than slow. */
export const STALL_MS = 2000;
/** Hard cap on retained samples, so a long run cannot grow without bound. */
export const MAX_SAMPLES = 600;

/** Requests shorter than this cannot resolve a rate. */
export const MIN_RATE_MS = 50;
/** The decode span may not shrink below this fraction of the whole request. */
export const MIN_DECODE_FRACTION = 0.25;
/**
 * Public models run a few hundred output tokens per second. Anything above this
 * means delivery was buffered and flushed in one burst, so the span is not a
 * decode timeline and the reading is discarded rather than shown.
 */
export const MAX_PLAUSIBLE_RATE = 400;

/** Accepted range for a calibration ratio (reported tokens / estimated tokens). */
export const CALIBRATION_MIN = 0.25;
export const CALIBRATION_MAX = 3;
/** Weight of a new sample in the calibration EMA. */
export const CALIBRATION_ALPHA = 0.3;

/**
 * Average characters per token for scripts that are not CJK. Exported so tests
 * can derive their expected values instead of re-hardcoding the constant.
 */
export const CHARS_PER_TOKEN = 3.6;

export type Phase = 'thinking' | 'writing';

export interface Sample {
	readonly at: number;
	readonly total: number;
	readonly billed: number;
}

export interface ContentEstimate {
	/** Everything streamed: thinking + text + tool arguments. */
	readonly total: number;
	readonly thinking: number;
	readonly text: number;
	/** What a provider that excludes reasoning tokens would report. */
	readonly billed: number;
}

export interface LiveReading {
	readonly rate: number;
	readonly phase: Phase;
	readonly stalledFor: number | null;
}

export interface LastRequest {
	readonly rate: number;
	readonly output: number;
	readonly ms: number;
	readonly decodeMs: number;
	readonly ttftMs: number | null;
	readonly clamped: boolean;
	readonly model: string;
	readonly at: number;
}

/**
 * Whether a code point is rendered double-width. Used for token estimation, not
 * for layout: CJK text is roughly one token per character, Latin roughly 3.6.
 */
export function isWide(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x20000 && codePoint <= 0x3fffd)
	);
}

/** Script-aware estimate: wide characters count 1, the rest count 1/3.6. */
export function estimateTokens(text: string): number {
	let wide = 0;
	let other = 0;
	for (const char of text) {
		if (isWide(char.codePointAt(0) ?? 0)) wide += 1;
		else other += 1;
	}
	return wide + other / CHARS_PER_TOKEN;
}

/**
 * Estimate a whole partial message. `message_update` carries every block, so
 * tool arguments count too — they are billed but never arrive as a text delta.
 *
 * Cost note: the host re-sends the whole partial message on every frame, so
 * each call re-walks every character — O(characters) per frame and
 * O(characters × frames) across a request. At the observed scale (a 32k-token
 * request is roughly 1.1e5 characters over ~2300 frames) the total is bounded
 * by the message size, so this is left uncached rather than keyed per block.
 */
export function estimateContent(content: unknown): ContentEstimate | null {
	if (!Array.isArray(content)) return null;

	let thinking = 0;
	let text = 0;
	let tools = 0;

	for (const block of content) {
		if (!isRecord(block)) continue;

		switch (block.type) {
			case 'text':
				if (typeof block.text === 'string') text += estimateTokens(block.text);
				break;
			case 'thinking':
				if (typeof block.thinking === 'string')
					thinking += estimateTokens(block.thinking);
				break;
			case 'tool_use':
				if (typeof block.name === 'string') tools += estimateTokens(block.name);
				try {
					tools += estimateTokens(JSON.stringify(block.input ?? {}));
				} catch {
					tools += 4;
				}
				break;
		}
	}

	return {
		total: thinking + text + tools,
		thinking,
		text,
		billed: text + tools,
	};
}

/**
 * Live rate over a trailing window, with a plausibility guard.
 *
 * The window looks back `WINDOW_MS` from now and measures how much the absolute
 * count grew across it. A provider that hands over a large block in one frame
 * therefore spreads that block across real elapsed time instead of dividing it
 * by a few milliseconds.
 *
 * Two guards keep a buffered flush from being read as a decode timeline:
 *
 * - **Span floor.** A window shorter than `MIN_SPAN_MS` cannot resolve a rate.
 * - **Ceiling.** A rate above `MAX_PLAUSIBLE_RATE` means delivery was bursty, so
 *   the measurement is discarded rather than clamped: clamping would invent a
 *   number that looks authoritative.
 *
 * When a burst does arrive, the reading is withheld for one window and then
 * reappears from real samples. That is deliberate — a missing number is honest,
 * a fabricated one is not.
 *
 * @param ema   previous smoothed rate, or null on the first measurement
 * @returns the new EMA, or the previous one when this frame is unmeasurable
 */
export function nextEma(
	samples: readonly Sample[],
	now: number,
	ema: number | null,
	lastEmaAt: number,
): number | null {
	const newest = samples[samples.length - 1];
	if (!newest) return ema;

	// Start from the window, then widen it until enough frames are included. A
	// provider that emits every 200ms never puts three frames in a 600ms window,
	// and demanding three regardless would hide a genuinely slow stream. Widening
	// keeps the frame-count guard meaningful without excluding sparse delivery.
	const windowFloor = now - WINDOW_MS;
	let oldestIndex = -1;
	for (let i = 0; i < samples.length; i += 1) {
		if (samples[i]!.at >= windowFloor) {
			oldestIndex = i;
			break;
		}
	}
	if (oldestIndex < 0) return ema;

	const needed = Math.min(MIN_WINDOW_FRAMES, samples.length);
	if (samples.length - oldestIndex < needed) {
		oldestIndex = Math.max(0, samples.length - needed);
	}

	const window = samples.slice(oldestIndex);
	const oldest = window[0]!;
	const spanMs = newest.at - oldest.at;
	if (spanMs < MIN_SPAN_MS) return ema;

	// One frame cannot be a decode timeline, but that is already covered above:
	// a single-frame window has spanMs === 0, well under the span floor.
	const growth = newest.total - oldest.total;
	if (growth < MIN_LIVE_GROWTH) return ema;

	// Every frame's contribution, in tokens per second of the window. One burst
	// among steady frames is an outlier, so the median is the representative
	// speed and the mean is not: a single 700-token frame would otherwise define
	// the whole window even when everything around it ran at 60 tok/s.
	//
	// The first frame of a request carries whatever the provider buffered before
	// streaming (measured: 428 tokens in frame 0 against a median of 3 for the
	// rest). Including it as a delta invents a huge rate, so the skip starts at
	// index 2. Note this is window-relative, not request-relative: a window that
	// slides past the request's first frames still drops its own leading two
	// frames, which a sparse delivery can make the whole window's only deltas.
	const rates: number[] = [];
	for (let i = 2; i < window.length; i += 1) {
		const previous = window[i - 1]!;
		const current = window[i]!;
		const delta = current.total - previous.total;
		if (delta <= 0) continue;
		const deltaMs = current.at - previous.at;
		if (deltaMs <= 0) continue;
		rates.push((delta / deltaMs) * 1000);
	}
	if (rates.length === 0) return ema;

	const instant = median(rates);
	if (!Number.isFinite(instant) || instant <= 0) return ema;
	if (instant > MAX_PLAUSIBLE_RATE) return ema;

	if (ema === null) return instant;

	const alpha = 1 - Math.exp(-Math.max(now - lastEmaAt, 0) / TAU_MS);
	return ema + (instant - ema) * alpha;
}

/** Middle value of a non-empty list; the average of the two middles when even. */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle]!;
	return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Drop samples outside the retained window, and cap the retained count. Kept
 * separate so it is testable.
 *
 * Two independent rules: samples older than `WINDOW_MS * 4` are dropped, but the
 * newest two are always kept as a floor, so a burst never empties the buffer
 * completely. Separately, the retained count is capped at `MAX_SAMPLES`, keeping
 * the newest.
 */
export function pruneSamples(samples: readonly Sample[], now: number): Sample[] {
	const floor = now - WINDOW_MS * 4;
	let start = 0;
	while (start < samples.length - 2 && samples[start]!.at < floor) start += 1;

	const kept = start === 0 ? [...samples] : samples.slice(start);
	return kept.length > MAX_SAMPLES ? kept.slice(kept.length - MAX_SAMPLES) : kept;
}

/**
 * How long the stream has been silent, once that silence is meaningful.
 * Null while content is still arriving.
 */
export function stalledFor(lastContentAt: number, now: number): number | null {
	if (lastContentAt <= 0) return null;
	const silence = now - lastContentAt;
	return silence > STALL_MS ? silence : null;
}

/**
 * Pick the calibration ratio that best explains the provider's reported count.
 *
 * Providers disagree about whether reasoning tokens are billed inside
 * `outputTokens`, so both estimates are offered and the closer one (in log
 * space) wins. Returns null when neither candidate is plausible, which leaves
 * the previous calibration untouched.
 */
export function pickCalibration(
	outputTokens: number,
	measuredTotal: number,
	measuredBilled: number,
): number | null {
	if (measuredTotal <= 0) return null;

	const candidates = [measuredTotal];
	if (measuredBilled > 0 && measuredBilled < measuredTotal)
		candidates.push(measuredBilled);

	let best: number | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const candidate of candidates) {
		const ratio = outputTokens / candidate;
		if (!Number.isFinite(ratio)) continue;
		if (ratio < CALIBRATION_MIN || ratio > CALIBRATION_MAX) continue;

		const distance = Math.abs(Math.log(ratio));
		if (distance < bestDistance) {
			bestDistance = distance;
			best = ratio;
		}
	}

	return best;
}

/** Fold a new calibration ratio into the running one. */
export function applyCalibration(current: number, ratio: number): number {
	return current * (1 - CALIBRATION_ALPHA) + ratio * CALIBRATION_ALPHA;
}

/**
 * Final reading for one model request.
 *
 * The decode span excludes the wait for the first token, but a very late first
 * token would otherwise shrink it toward zero and report an impossible rate. In
 * that case the whole request span is used instead and the result is flagged, so
 * the report can say what it did.
 */
export function finalizeRequest(input: {
	output: number;
	ms: number;
	ttftMs: number | null;
	model: string;
	at: number;
}): LastRequest | null {
	const {output, ms, ttftMs, model, at} = input;
	if (!Number.isFinite(output) || output <= 0) return null;
	if (!Number.isFinite(ms) || ms < MIN_RATE_MS) return null;

	const totalDecode = ttftMs === null ? ms : ms - ttftMs;
	const floor = Math.max(ms * MIN_DECODE_FRACTION, 1);
	const clamped = totalDecode < floor;
	const decodeMs = clamped ? ms : totalDecode;

	const rate = (output / decodeMs) * 1000;
	if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_PLAUSIBLE_RATE) return null;

	return {rate, output, ms, decodeMs, ttftMs, clamped, model, at};
}
