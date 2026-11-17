import assert from 'node:assert/strict';
import test from 'node:test';

import {copyFor, resolveLang, LANG_SET, DEFAULT_LANG, type Copy} from '../src/copy.ts';
import {
	clockOf,
	describe,
	formatRate,
	liveLabel,
	statusLabel,
	surfaceLabel,
} from '../src/format.ts';
import type {LastRequest} from '../src/measure.ts';

const EN: Copy = copyFor('en');
const ZH: Copy = copyFor('zh');

function request(overrides: Partial<LastRequest> = {}): LastRequest {
	return {
		rate: 42.5,
		output: 120,
		ms: 3000,
		decodeMs: 2500,
		ttftMs: 500,
		clamped: false,
		model: 'test/model',
		at: 0,
		...overrides,
	};
}

// ------------------------------------------------------------------ numbers

test('rates below 100 keep one decimal', () => {
	assert.equal(formatRate(9.7), '9.7');
	assert.equal(formatRate(42.54), '42.5');
});

test('rates at or above 100 round to whole numbers', () => {
	assert.equal(formatRate(100.4), '100');
	assert.equal(formatRate(271.7), '272');
	assert.equal(formatRate(1000.2), '1000');
});

test('a whole number never shows a trailing decimal', () => {
	// Regression: an earlier formatter printed "100" for 99.96 and "10.00" for
	// 9.999, so the same field flipped precision as it changed.
	assert.equal(formatRate(60), '60');
	assert.equal(formatRate(99.96), '100');
});

test('non-positive and non-finite rates degrade to zero', () => {
	assert.equal(formatRate(0), '0');
	assert.equal(formatRate(-5), '0');
	assert.equal(formatRate(Number.NaN), '0');
});

test('the clock is four digits plus a colon', () => {
	assert.match(clockOf(Date.now()), /^\d{2}:\d{2}$/);
});

// ------------------------------------------------------------------- labels

test('the live label reads as an estimate and names the phase', () => {
	const writing = liveLabel({rate: 52.3, phase: 'writing', stalledFor: null}, EN);
	assert.equal(writing.text, '⚡ ~52.3 tok/s · writing');
	assert.equal(writing.color, 'cyan');

	const thinking = liveLabel({rate: 12, phase: 'thinking', stalledFor: null}, EN);
	assert.equal(thinking.text, '⚡ ~12 tok/s · thinking');
});

test('the phase label is translated when the language is Chinese', () => {
	assert.equal(
		liveLabel({rate: 52.3, phase: 'writing', stalledFor: null}, ZH).text,
		'⚡ ~52.3 tok/s · 输出',
	);
	assert.equal(
		liveLabel({rate: 52.3, phase: 'thinking', stalledFor: null}, ZH).text,
		'⚡ ~52.3 tok/s · 思考',
	);
});

test('a stall replaces the rate instead of showing a decaying number', () => {
	// A falling number reads as "still generating, slowly"; a stall label does not.
	const stalled = liveLabel({rate: 3, phase: 'writing', stalledFor: 2300}, EN);
	assert.equal(stalled.text, '⚡ stalled 2.3s');
	assert.equal(stalled.color, 'yellow');
});

test('a stall is translated too', () => {
	assert.equal(
		liveLabel({rate: 3, phase: 'writing', stalledFor: 2300}, ZH).text,
		'⚡ 停滞 2.3s',
	);
});

test('the footer label is language-neutral so it never mixes scripts', () => {
	// `tok/s` and a clock read the same in both languages on purpose: this line
	// shares space with the host's own English status segments.
	const label = statusLabel(request({rate: 88.4}));
	assert.match(label, /^⚡ 88\.4 tok\/s · \d{2}:\d{2}$/);
	assert.equal(statusLabel(request()), statusLabel(request()));
});

// ------------------------------------------------------------------ surfaces

test('every user-facing string exists in both languages', () => {
	// A missing translation would otherwise surface as `undefined` in the TUI.
	for (const [name, copy] of [
		['en', EN],
		['zh', ZH],
	] as const) {
		for (const key of ['writing', 'thinking', 'measuring', 'nothingMeasured', 'usage', 'statusSurface', 'spinnerSurface', 'missingUsage'] as const) {
			const value = copy[key];
			assert.equal(typeof value, 'string', `${name}.${key}`);
			assert.ok(value.length > 0, `${name}.${key} is empty`);
		}
		assert.equal(typeof copy.stalled(1), 'string', `${name}.stalled`);
		assert.equal(typeof copy.firstToken(500), 'string', `${name}.firstToken`);
		assert.equal(typeof copy.durations(1, 2), 'string', `${name}.durations`);
		assert.equal(typeof copy.tokens(10), 'string', `${name}.tokens`);
		assert.equal(typeof copy.toggled('x', true), 'string', `${name}.toggled`);
		assert.equal(typeof copy.allToggled(true), 'string', `${name}.allToggled`);
	}
});

test('the two languages actually differ where they should', () => {
	for (const key of ['writing', 'thinking', 'measuring', 'nothingMeasured', 'usage'] as const) {
		assert.notEqual(EN[key], ZH[key], `${key} should be translated`);
	}
});

test('an unknown language value falls back instead of throwing', () => {
	assert.equal(resolveLang('fr'), DEFAULT_LANG);
	assert.equal(resolveLang(undefined), DEFAULT_LANG);
	assert.equal(resolveLang(42), DEFAULT_LANG);
	assert.equal(resolveLang(null), DEFAULT_LANG);
	assert.equal(resolveLang({}), DEFAULT_LANG);
});

test('the default is English so an international install is readable', () => {
	// Regression: a `zh` default meant the mods hub audience saw Chinese copy and
	// uninstalled, since /toks lang is only discoverable after that impression.
	assert.equal(DEFAULT_LANG, 'en');
});

test('language matching ignores case, whitespace and region', () => {
	// Regression: an exact `=== 'en'` check silently ignored every other spelling a
	// person would plausibly type.
	for (const value of ['en', 'EN', 'En', ' en ', 'en-US', 'en_US', 'en-GB']) {
		assert.equal(resolveLang(value), 'en', JSON.stringify(value));
	}
	for (const value of ['zh', 'ZH', ' zh ', 'zh-CN', 'zh_Hans', 'zh-TW']) {
		assert.equal(resolveLang(value), 'zh', JSON.stringify(value));
	}
});

test('a locale whose base is not supported falls back', () => {
	assert.equal(resolveLang('fr-FR'), DEFAULT_LANG);
	assert.equal(resolveLang('de'), DEFAULT_LANG);
	assert.equal(resolveLang('-'), DEFAULT_LANG);
	assert.equal(resolveLang(''), DEFAULT_LANG);
});

test('surface labels name the surface people actually see', () => {
	assert.equal(surfaceLabel('status', EN), 'footer');
	assert.equal(surfaceLabel('spinner', EN), 'live');
	assert.equal(surfaceLabel('status', ZH), '底栏');
	assert.equal(surfaceLabel('spinner', ZH), '实时');
});

// ------------------------------------------------------------------- report

test('the report is empty-state aware', () => {
	assert.equal(describe({last: null, measuring: false}, EN), EN.nothingMeasured);
	assert.equal(describe({last: null, measuring: true}, EN), EN.measuring);
	assert.equal(describe({last: null, measuring: false}, ZH), '还没有测到任何模型请求。');
});

test('the report separates total duration from decode duration', () => {
	// Regression: the summary printed total ms while the rate used decode ms, so
	// a reader dividing one by the other got a different number.
	const text = describe({last: request(), measuring: false}, EN);
	assert.match(text, /total 3\.0s \(decode 2\.5s\)/);
	assert.match(text, /test\/model/);
	assert.match(text, /120 tokens/);
	assert.match(text, /first token 500ms/);
});

test('the Chinese report uses the same figures with Chinese labels', () => {
	const text = describe({last: request(), measuring: false}, ZH);
	assert.match(text, /总 3\.0s（解码 2\.5s）/);
	assert.match(text, /首 token 500ms/);
	assert.match(text, /120 tokens/);
});

test('a clamped reading says so rather than hiding the fallback', () => {
	assert.match(describe({last: request({clamped: true}), measuring: false}, EN), /first token too late/);
	assert.match(describe({last: request({clamped: true}), measuring: false}, ZH), /首 token 过晚/);
});

test('an in-flight request still reports the previous result', () => {
	assert.match(describe({last: request(), measuring: true}, EN), /^measuring this request · previous: /);
	assert.match(describe({last: request(), measuring: true}, ZH), /^正在测量本次请求 · 上一次：/);
});

test('a missing first-token time is omitted rather than shown as zero', () => {
	for (const copy of [EN, ZH]) {
		assert.doesNotMatch(describe({last: request({ttftMs: null}), measuring: false}, copy), /token \d|token \d/);
	}
});

test('an unknown model does not leave a dangling separator', () => {
	const text = describe({last: request({model: ''}), measuring: false}, EN);
	assert.ok(!text.includes(' · 42.5'), text);
	assert.match(text, /42\.5 tok\/s/);
});

// ------------------------------------------------------------------- toggles

test('toggle messages name the surface that changed', () => {
	assert.equal(EN.toggled('footer', false), 'footer display off.');
	assert.equal(ZH.toggled('底栏', false), '底栏显示已关闭。');
	assert.equal(EN.allToggled(true), 'All displays on.');
	assert.equal(ZH.allToggled(true), '已开启全部显示。');
});

test('the usage line names every argument the handler accepts', () => {
	// Regression: `/toks lang` was added without updating either usage string, so
	// the option existed but was undiscoverable.
	for (const [name, copy] of [
		['en', EN],
		['zh', ZH],
	] as const) {
		for (const token of ['on', 'off', 'spinner', 'status', 'lang']) {
			assert.ok(copy.usage.includes(token), `${name} usage should mention ${token}: ${copy.usage}`);
		}
	}
});

test('formatters append their unit exactly once', () => {
	// These take raw numbers now, not pre-formatted strings, so "2.3ss" and
	// "abcms" are not expressible. A fractional input must still render one unit.
	assert.equal(EN.stalled(2.3), 'stalled 2.3s');
	assert.equal(EN.durations(4.123, 3.456), ' · total 4.1s (decode 3.5s)');
});

test('the first-token figure is rounded to whole milliseconds', () => {
	// Mutation testing caught this: dropping Math.round still passed every test,
	// because every fixture used an integer.
	assert.equal(EN.firstToken(812.4), ' · first token 812ms');
	assert.equal(EN.firstToken(812.6), ' · first token 813ms');
	assert.equal(ZH.firstToken(812.4), ' · 首 token 812ms');
});

test('the language confirmation names both options', () => {
	assert.match(LANG_SET, /\/toks lang en\|zh/);
});
