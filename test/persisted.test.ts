import assert from 'node:assert/strict';
import test from 'node:test';

import {readStoredRequest} from '../src/persisted.ts';

/** A value shaped like what this mod writes today. */
function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		rate: 61.8,
		output: 120,
		ms: 4100,
		decodeMs: 3500,
		ttftMs: 812,
		clamped: false,
		model: 'test/model',
		at: 1_700_000_000_000,
		...overrides,
	};
}

test('a well-formed value round-trips', () => {
	const stored = readStoredRequest(valid());
	assert.ok(stored !== null);
	assert.equal(stored.rate, 61.8);
	assert.equal(stored.output, 120);
	assert.equal(stored.ttftMs, 812);
	assert.equal(stored.clamped, false);
	assert.equal(stored.model, 'test/model');
});

test('an absent value reads as null', () => {
	// The common case on a fresh session.
	assert.equal(readStoredRequest(undefined), null);
	assert.equal(readStoredRequest(null), null);
});

test('a value that is not an object is rejected', () => {
	// Regression: `cmd.state.get<LastRequest>()` handed a stored string straight to
	// the renderer, which painted "0 tok/s · undefined tokens · total NaNs".
	for (const value of ['not-an-object', 42, true, []]) {
		assert.equal(readStoredRequest(value), null, String(value));
	}
});

test('a missing numeric field is rejected', () => {
	for (const key of ['rate', 'output', 'ms', 'decodeMs', 'at']) {
		const broken = valid();
		delete broken[key];
		assert.equal(readStoredRequest(broken), null, `missing ${key}`);
	}
});

test('NaN is rejected even though it is a number', () => {
	// Regression: a NaN rate rendered as "0 tok/s", which reads as a stall rather
	// than as damaged state.
	for (const key of ['rate', 'output', 'ms', 'decodeMs', 'at']) {
		assert.equal(readStoredRequest(valid({[key]: Number.NaN})), null, `NaN ${key}`);
	}
});

test('Infinity is rejected', () => {
	assert.equal(readStoredRequest(valid({rate: Number.POSITIVE_INFINITY})), null);
	assert.equal(readStoredRequest(valid({ms: Number.NEGATIVE_INFINITY})), null);
});

test('negative durations are rejected', () => {
	assert.equal(readStoredRequest(valid({ms: -1})), null);
	assert.equal(readStoredRequest(valid({decodeMs: -1})), null);
	assert.equal(readStoredRequest(valid({rate: -5})), null);
	assert.equal(readStoredRequest(valid({output: -5})), null);
});

test('a non-boolean clamped flag is rejected', () => {
	assert.equal(readStoredRequest(valid({clamped: 'yes'})), null);
	assert.equal(readStoredRequest(valid({clamped: 1})), null);
});

test('a non-string model is rejected', () => {
	assert.equal(readStoredRequest(valid({model: 42})), null);
	assert.equal(readStoredRequest(valid({model: null})), null);
});

test('a null first-token time is accepted and preserved', () => {
	// Null is meaningful here: the request produced no observable first token.
	const stored = readStoredRequest(valid({ttftMs: null}));
	assert.ok(stored !== null);
	assert.equal(stored.ttftMs, null);
});

test('a NaN first-token time is rejected while null is allowed', () => {
	assert.equal(readStoredRequest(valid({ttftMs: Number.NaN})), null);
	assert.equal(readStoredRequest(valid({ttftMs: '812'})), null);
});

test('extra fields are ignored rather than carried through', () => {
	// A shape written by a future version should not leak unknown keys into the
	// renderer; the validated value has exactly the declared fields.
	const stored = readStoredRequest(valid({unexpected: 'ignored', nested: {a: 1}}));
	assert.ok(stored !== null);
	assert.deepEqual(Object.keys(stored).sort(), [
		'at',
		'clamped',
		'decodeMs',
		'model',
		'ms',
		'output',
		'rate',
		'ttftMs',
	]);
});

test('the validated value never contains NaN or Infinity', () => {
	// Whatever comes back must be safe to divide and format, because that is
	// exactly what the renderer does with it.
	const stored = readStoredRequest(valid());
	assert.ok(stored !== null);
	for (const value of [stored.rate, stored.output, stored.ms, stored.decodeMs, stored.at]) {
		assert.ok(Number.isFinite(value), `${value} should be finite`);
	}
	if (stored.ttftMs !== null) assert.ok(Number.isFinite(stored.ttftMs));
});
