/**
 * Measurement tests. Each case here corresponds to a defect that shipped in an
 * earlier prototype, so the assertions are the regression record, not decoration.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	applyCalibration,
	CALIBRATION_ALPHA,
	CALIBRATION_MAX,
	CALIBRATION_MIN,
	CHARS_PER_TOKEN,
	estimateContent,
	estimateTokens,
	finalizeRequest,
	MAX_PLAUSIBLE_RATE,
	MAX_SAMPLES,
	MIN_LIVE_GROWTH,
	MIN_RATE_MS,
	MIN_SPAN_MS,
	nextEma,
	pickCalibration,
	pruneSamples,
	stalledFor,
	STALL_MS,
	TAU_MS,
	WINDOW_MS,
	type Sample,
} from '../src/measure.ts';

function series(points: Array<[at: number, total: number]>): Sample[] {
	return points.map(([at, total]) => ({at, total, billed: total}));
}

// ---------------------------------------------------------------- estimation

test('CJK estimates about one token per character', () => {
	// 4 characters, all wide.
	assert.equal(estimateTokens('潮汐锁定'), 4);
});

test('Latin estimates roughly one token per CHARS_PER_TOKEN characters', () => {
	const value = estimateTokens('the quick brown fox jumps');
	assert.ok(Math.abs(value - 25 / CHARS_PER_TOKEN) < 0.01, `got ${value}`);
});

test('CHARS_PER_TOKEN is exported so tests can derive their expectations', () => {
	assert.ok(CHARS_PER_TOKEN > 1, 'the constant must be a usable divisor');
});

test('a CJK/ASCII mix lands between the two extremes', () => {
	const mixed = estimateTokens('潮汐ab');
	assert.ok(mixed > 2 && mixed < 4, `got ${mixed}`);
});

test('an empty string contributes no tokens', () => {
	assert.equal(estimateTokens(''), 0);
});

test('content estimation counts text, thinking and tool arguments separately', () => {
	const estimate = estimateContent([
		{type: 'thinking', thinking: '思考'},
		{type: 'text', text: 'abcd'},
		{type: 'tool_use', name: 'shell_command', input: {command: 'ls'}},
	]);
	assert.ok(estimate !== null);

	// thinking: 2 wide chars -> 2
	assert.equal(estimate.thinking, 2);
	// text: 4 ascii / 3.6
	assert.ok(Math.abs(estimate.text - 4 / 3.6) < 0.01);
	// billed excludes thinking, includes the tool call
	assert.ok(estimate.billed > estimate.text);
	assert.ok(estimate.total > estimate.billed);
});

test('tool arguments count even though they never arrive as a text delta', () => {
	const withTool = estimateContent([
		{type: 'tool_use', name: 'edit_file', input: {file_path: 'a.ts', content: 'x'.repeat(100)}},
	]);
	const withoutTool = estimateContent([{type: 'text', text: ''}]);
	assert.ok(withTool !== null && withoutTool !== null);
	assert.ok(withTool.total > 20, `got ${withTool.total}`);
	assert.equal(withoutTool.total, 0);
});

test('a malformed content payload yields null rather than throwing', () => {
	assert.equal(estimateContent(undefined), null);
	assert.equal(estimateContent('not-an-array'), null);
	assert.equal(estimateContent({}), null);
});

// ------------------------------------------------------------- live window

test('a reading appears as soon as one short window has filled', () => {
	// The earlier design waited 1.5s before showing anything. A 600ms window makes
	// the number useful within the first second of a stream.
	const samples = series([
		[0, 0],
		[150, 5],
		[300, 10],
		[450, 15],
		[600, 20],
	]);
	const ema = nextEma(samples, 600, null, 0);
	assert.ok(ema !== null, 'expected a reading after one window');
	assert.ok(Math.abs(ema - 33.3) < 1, `got ${ema}`);
});

test('nothing is reported before the span floor is reached', () => {
	const samples = series([
		[0, 0],
		[100, 30],
	]);
	assert.equal(nextEma(samples, 100, null, 0), null);
});

test('the span floor is what rejects a short window, not the frame count', () => {
	// Mutation testing showed the earlier case passed for the wrong reason: two
	// frames trip the frame guard before the span check is ever reached. This case
	// has enough frames, so only MIN_SPAN_MS can reject it.
	const samples = series([
		[0, 0],
		[40, 12],
		[80, 24],
		[120, 36],
	]);
	assert.ok(
		120 < MIN_SPAN_MS,
		'the test is only meaningful while this span is below the floor',
	);
	assert.equal(nextEma(samples, 120, null, 0), null);
});

test('a provider burst arriving in one frame does not become a spike', () => {
	// Regression: 731 characters of reasoning landed in a single message_update.
	// Dividing that block by a few milliseconds reported 290-680 tok/s.
	const burst = estimateTokens('思考'.repeat(365)) + estimateTokens('abcdef');
	const samples = series([
		[0, 0],
		[10, burst],
	]);
	assert.equal(nextEma(samples, 10, null, 0), null);
});

test('a burst that lands under the rate ceiling is still rejected by the frame count', () => {
	// Regression: the first real run after the window change reported 322 tok/s
	// from two frames, which slipped past the 400 ceiling. A real decode fills the
	// window with many frames; a handed-over block does not.
	const samples = series([
		[0, 0],
		[380, 122], // 322 tok/s over two frames — plausible by rate, not by delivery
	]);
	assert.equal(nextEma(samples, 380, null, 0), null);
});

test('enough frames in the window make the same rate measurable', () => {
	const samples = series([
		[0, 0],
		[100, 20],
		[200, 40],
		[300, 60],
		[380, 80],
	]);
	const ema = nextEma(samples, 380, null, 0);
	assert.ok(ema !== null, 'a genuinely streamed window must still measure');
});

test('a sparse window is widened so a slow stream still gets a reading', () => {
	// Regression: a provider that emits one frame per 400ms never fills the 600ms
	// window with three frames, so widening had to add the oldest frames back.
	// Without it the window holds two frames, the frame loop never runs, and the
	// reading disappears.
	const samples = series([
		[0, 0],
		[400, 10],
		[800, 20],
	]);
	const ema = nextEma(samples, 800, null, 0);
	assert.ok(ema !== null, 'the window must be widened to the newest frames');
	assert.ok(Math.abs(ema - 25) < 1, `got ${ema}`);
});

test('a rate above the ceiling is rejected rather than clamped', () => {
	// Clamping would invent a number that looks authoritative; withholding is the
	// honest answer, and the next window produces a real measurement.
	const samples = series([
		[0, 0],
		[100, 1000],
		[200, 2000],
		[300, 3000],
		[400, 5000],
	]);
	assert.equal(nextEma(samples, 400, null, 0), null);
});

test('a burst is followed by a real reading once the window slides past it', () => {
	const burstAt = 0;
	const samples = series([
		[burstAt, 733],
		[burstAt + 180, 740],
		[burstAt + 360, 747],
		[burstAt + 480, 754],
		[burstAt + 620, 761],
	]);
	// 28 tokens over ~620ms is ~45 tok/s; the burst is outside the window now.
	const ema = nextEma(samples, burstAt + 620, null, 0);
	assert.ok(ema !== null, 'expected the window to produce a reading');
	assert.ok(ema > 20 && ema < 90, `got ${ema}`);
});

test('growth below the floor produces no reading', () => {
	const samples = series([
		[0, 100],
		[150, 101],
		[300, 101],
		[450, 101],
		[600, 100 + MIN_LIVE_GROWTH - 1],
	]);
	assert.equal(nextEma(samples, 600, null, 0), null);
});

test('a genuinely slow stream still reports', () => {
	// Regression: a growth floor tuned for fast streams suppressed every reading
	// for a one-character-per-chunk stream.
	const samples = series([
		[0, 0],
		[150, 2],
		[300, 4],
		[450, 6],
		[600, 8],
	]);
	const ema = nextEma(samples, 600, null, 0);
	assert.ok(ema !== null, 'a slow stream must still produce a number');
	assert.ok(ema > 0 && ema < 40, `got ${ema}`);
});

test('an even number of frames averages the two middle rates', () => {
	// Regression: the median comment claimed the lower of the two middles while
	// the code averages them. The reading has to match the implementation.
	const samples = series([
		[0, 0],
		[100, 10],
		[200, 20],
		[300, 40],
		[400, 70],
		[500, 100],
	]);
	const ema = nextEma(samples, 500, null, 0);
	assert.ok(ema !== null, 'expected a reading');
	assert.ok(Math.abs(ema - 250) < 0.01, `got ${ema}`);
});

test('the leading two frames of the window are skipped, not just the request start', () => {
	// Regression: the skip is window-relative, so a window that still begins at
	// the request's frame 0 drops the buffered frame-0 and frame-1 deltas. A huge
	// first delta must not reach the reading. The middle of the remaining rates
	// (100 and 300) is 200; including the buffered frame-0 rate would make the
	// median 300, so the assertion pins the skip index to 2.
	const samples = series([
		[0, 0],
		[100, 9000], // buffered hand-over: 90,000 tok/s if it were a delta
		[200, 9010], // +10 tokens over 100ms -> 100 tok/s
		[300, 9040], // +30 tokens over 100ms -> 300 tok/s
	]);
	const ema = nextEma(samples, 300, null, 0);
	assert.ok(ema !== null, 'expected a reading from the third frame');
	assert.ok(Math.abs(ema - 200) < 0.01, `got ${ema}`);
});

test('the EMA moves toward the new rate without jumping to it', () => {
	const slow = series([
		[0, 0],
		[150, 9],
		[300, 18],
		[450, 18],
		[600, 27],
	]);
	const first = nextEma(slow, 600, null, 0);
	assert.ok(first !== null);

	const faster = series([
		[0, 0],
		[150, 9],
		[300, 18],
		[450, 18],
		[600, 27],
		[750, 55],
		[900, 80],
		[1050, 105],
		[1200, 130],
	]);
	const second = nextEma(faster, 1200, first, 600);
	assert.ok(second !== null);
	assert.ok(second > first, `EMA should rise toward the faster rate, got ${second}`);
});

test('an empty window keeps the previous value instead of dropping to zero', () => {
	assert.equal(nextEma([], 1000, 42, 0), 42);
});

test('an unmeasurable frame keeps the previous value', () => {
	// Withholding a reading must not erase a good one from the frame before.
	const samples = series([
		[0, 0],
		[10, 5000], // a burst: rejected
	]);
	assert.equal(nextEma(samples, 10, 55, 0), 55);
});

test('pruning drops stale samples but keeps the newest two', () => {
	const samples = series([
		[0, 10],
		[10_000, 20],
		[10_100, 30],
	]);
	const kept = pruneSamples(samples, 10_100);
	assert.ok(kept.length >= 2);
	assert.equal(kept[kept.length - 1]!.total, 30);
});

test('pruning keeps every sample still inside the window', () => {
	// Regression: the floor drops samples older than WINDOW_MS * 4, so samples
	// that are all recent must not be trimmed.
	const now = 100_000;
	const samples = series([
		[now - 100, 1],
		[now - 50, 2],
		[now - 10, 3],
	]);
	assert.deepEqual(pruneSamples(samples, now), samples);
});

test('pruning keeps exactly the two newest samples when everything is stale', () => {
	// The newest-two floor is deliberate: it must not fall back to a single
	// sample, and it must not leave a stale one behind.
	const now = 1_000_000;
	const samples = series([
		[0, 1],
		[1, 2],
		[2, 3],
		[3, 4],
	]);
	const kept = pruneSamples(samples, now);
	assert.equal(kept.length, 2);
	assert.equal(kept[0]!.total, 3);
	assert.equal(kept[1]!.total, 4);
});

test('pruning truncates a long live window to the newest MAX_SAMPLES', () => {
	// Regression: the cap is a plain constant, so a mutation of it must change
	// the result. The expected count is therefore the literal, and the constant
	// is asserted first to keep the test honest.
	assert.equal(MAX_SAMPLES, 600, 'this test pins the documented cap');

	const now = 10_000_000;
	const samples = series(
		Array.from({length: 601}, (_, i) => [now - (601 - i), i + 1] as [number, number]),
	);
	const kept = pruneSamples(samples, now);
	assert.equal(kept.length, 600);
	assert.equal(kept[0]!.total, 2);
	assert.equal(kept[599]!.total, 601);
});

test('stall detection reports silence only after the threshold', () => {
	assert.equal(stalledFor(1000, 1000 + STALL_MS - 1), null);
	const value = stalledFor(1000, 1000 + STALL_MS + 500);
	assert.ok(value !== null && value > STALL_MS);
	assert.equal(stalledFor(0, 99_999), null);
});

test('the window is shorter than the old fixed lookback it replaced', () => {
	assert.ok(WINDOW_MS < 1000, 'the whole point is a faster first reading');
});

// ------------------------------------------------------------- calibration

test('calibration uses the total when the provider bills reasoning tokens', () => {
	// 100 estimated total, 70 of it billed (text+tools): reported 100 -> total wins.
	assert.equal(pickCalibration(100, 100, 70), 1);
});

test('calibration uses the billed figure when reasoning is not billed', () => {
	// Regression: one provider reported 303 tokens for 731 characters of thinking
	// plus 222 of text. Calibrating against the total (953) scaled every live
	// reading down 3x, so the closer candidate has to win.
	const ratio = pickCalibration(303, 953, 222);
	assert.ok(ratio !== null);
	assert.ok(Math.abs(ratio - 303 / 222) < 0.001, `got ${ratio}`);
});

test('a candidate outside the accepted range is skipped, not clamped', () => {
	// 300/60 would be 5x, which is not a plausible estimate error. The only usable
	// candidate here is the total.
	assert.equal(pickCalibration(300, 950, 60), 300 / 950);
});

test('calibration rejects an implausible ratio and leaves the previous one alone', () => {
	assert.equal(pickCalibration(10, 1000, 900), null);
	assert.equal(pickCalibration(9000, 100, 90), null);
});

test('calibration needs a positive estimate to work from', () => {
	assert.equal(pickCalibration(100, 0, 0), null);
});

test('a new ratio is blended in, not applied whole', () => {
	const blended = applyCalibration(1, 2);
	assert.ok(Math.abs(blended - (1 * (1 - CALIBRATION_ALPHA) + 2 * CALIBRATION_ALPHA)) < 1e-9);
	assert.ok(blended > 1 && blended < 2);
});

test('calibration bounds bracket both billing styles', () => {
	assert.ok(CALIBRATION_MIN <= 0.5);
	assert.ok(CALIBRATION_MAX >= 2);
});

// ---------------------------------------------------------- final reading

test('the decode span excludes the wait for the first token', () => {
	const result = finalizeRequest({output: 200, ms: 3000, ttftMs: 500, model: 'm', at: 0});
	assert.ok(result !== null);
	assert.equal(result.decodeMs, 2500);
	assert.ok(Math.abs(result.rate - 80) < 0.001);
	assert.equal(result.clamped, false);
});

test('a very late first token falls back to the whole span and is flagged', () => {
	// Regression: decodeMs was floored at 1ms, which reported 500,000 tok/s. The
	// fallback now uses the whole span, so the same input reads 100 tok/s.
	const result = finalizeRequest({output: 500, ms: 5000, ttftMs: 4999, model: 'm', at: 0});
	assert.ok(result !== null);
	assert.equal(result.clamped, true);
	assert.equal(result.decodeMs, 5000);
	assert.equal(result.rate, 100);
});

test('an absurd rate is rejected rather than displayed', () => {
	const result = finalizeRequest({output: 5000, ms: 100, ttftMs: 0, model: 'm', at: 0});
	assert.equal(result, null);
});

test('a plausible but late first token is clamped and marked', () => {
	const result = finalizeRequest({output: 100, ms: 4000, ttftMs: 3900, model: 'm', at: 0});
	assert.ok(result !== null);
	assert.equal(result.clamped, true);
	assert.equal(result.decodeMs, 4000);
	assert.ok(result.rate <= MAX_PLAUSIBLE_RATE);
});

test('no output tokens means no reading', () => {
	assert.equal(finalizeRequest({output: 0, ms: 1000, ttftMs: 0, model: 'm', at: 0}), null);
});

test('a request too short to measure is dropped', () => {
	assert.equal(finalizeRequest({output: 5, ms: 10, ttftMs: 0, model: 'm', at: 0}), null);
});

test('a request exactly at the minimum span is measured, one below is dropped', () => {
	// Regression: MIN_RATE_MS was a live threshold that nothing pinned. The
	// boundary itself must be admitted and the value just under it must not. The
	// expected spans are literals so a mutation of the constant changes the result.
	assert.equal(MIN_RATE_MS, 50, 'this test pins the documented threshold');

	const atBoundary = finalizeRequest({
		output: 10,
		ms: 50,
		ttftMs: 0,
		model: 'm',
		at: 0,
	});
	assert.ok(atBoundary !== null, 'ms === 50 must not be dropped');

	const below = finalizeRequest({
		output: 10,
		ms: 49,
		ttftMs: 0,
		model: 'm',
		at: 0,
	});
	assert.equal(below, null, 'ms just under the floor must be dropped');
});

test('a missing first-token timestamp uses the whole span', () => {
	const result = finalizeRequest({output: 100, ms: 2000, ttftMs: null, model: 'm', at: 0});
	assert.ok(result !== null);
	assert.equal(result.decodeMs, 2000);
	assert.equal(result.ttftMs, null);
});

test('the reported rate always stays under the plausibility ceiling', () => {
	for (const ms of [100, 500, 1000, 5000]) {
		for (const ttft of [0, 50, ms - 10, ms]) {
			const result = finalizeRequest({output: 300, ms, ttftMs: ttft, model: 'm', at: 0});
			if (result !== null) {
				assert.ok(
					result.rate <= MAX_PLAUSIBLE_RATE,
					`rate ${result.rate} exceeded the ceiling for ms=${ms} ttft=${ttft}`,
				);
			}
		}
	}
});

test('the time constant is a smoothing value, not a hard cutoff', () => {
	assert.ok(TAU_MS > 0 && TAU_MS < WINDOW_MS * 3);
});
