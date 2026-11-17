import assert from 'node:assert/strict';
import test from 'node:test';

import {
	isRecord,
	readContent,
	readDelta,
	readModel,
	readOutputTokens,
} from '../src/events.ts';

// Event payloads are `unknown` by design: these readers are the only place the
// mod trusts a shape, so every degenerate input belongs in a test.

test('a normal delta is returned as-is', () => {
	assert.equal(readDelta({delta: 'hello'}), 'hello');
});

test('an empty or non-string delta is rejected', () => {
	assert.equal(readDelta({delta: ''}), null);
	assert.equal(readDelta({delta: 42}), null);
	assert.equal(readDelta({delta: null}), null);
});

test('a payload that is not an object is rejected', () => {
	assert.equal(readDelta(null), null);
	assert.equal(readDelta(undefined), null);
	assert.equal(readDelta('text'), null);
	assert.equal(readDelta([{delta: 'x'}]), null);
});

test('output tokens are read from the usage sub-object', () => {
	assert.equal(readOutputTokens({usage: {outputTokens: 303}}), 303);
});

test('a missing or invalid usage yields null rather than zero', () => {
	// Zero would be indistinguishable from "the provider reported nothing", which
	// is what the caller uses to decide whether it can calibrate at all.
	assert.equal(readOutputTokens({}), null);
	assert.equal(readOutputTokens({usage: {}}), null);
	assert.equal(readOutputTokens({usage: {outputTokens: 0}}), null);
	assert.equal(readOutputTokens({usage: {outputTokens: -5}}), null);
	assert.equal(readOutputTokens({usage: {outputTokens: '303'}}), null);
	assert.equal(readOutputTokens({usage: {outputTokens: Number.NaN}}), null);
	assert.equal(readOutputTokens({usage: null}), null);
});

test('snake_case output_tokens is not silently accepted as a match', () => {
	// The host reports camelCase today. Returning null keeps the caller on its
	// estimate rather than treating an absent field as a zero reading.
	assert.equal(readOutputTokens({usage: {output_tokens: 303}}), null);
});

test('the model name is read when present and empty otherwise', () => {
	assert.equal(readModel({model: 'vendor/model-name'}), 'vendor/model-name');
	assert.equal(readModel({}), '');
	assert.equal(readModel({model: 7}), '');
	assert.equal(readModel(null), '');
});

test('content is passed through for the estimator to judge', () => {
	const content = [{type: 'text', text: 'x'}];
	assert.deepEqual(readContent({content}), content);
	assert.equal(readContent({}), undefined);
	assert.equal(readContent(null), undefined);
});

test('isRecord excludes arrays and null', () => {
	assert.equal(isRecord({}), true);
	assert.equal(isRecord({a: 1}), true);
	assert.equal(isRecord([]), false);
	assert.equal(isRecord(null), false);
	assert.equal(isRecord(undefined), false);
	assert.equal(isRecord('x'), false);
	assert.equal(isRecord(1), false);
});
