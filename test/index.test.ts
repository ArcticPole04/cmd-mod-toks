/**
 * Wiring tests for `index.ts`, the mod's entry point.
 *
 * The estimator, the window and the formatters have their own suites. What this
 * file covers is the seam between them and the host: which flags and
 * subscriptions the mod registers, how the event stream drives the window, what
 * the `/toks` command does, and what the two UI surfaces paint. A fake host
 * records every subscription and write, so the wiring itself is under test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {ModApi, ModUiOverrideProps, ModUiTextNode} from '@commandcode/harness';

import mod from '../index.ts';
import {copyFor, DEFAULT_LANG, LANG_SET} from '../src/copy.ts';
import {describe as describeText, liveLabel, statusLabel} from '../src/format.ts';
import type {LastRequest} from '../src/measure.ts';

/** A host API that records every subscription, command, flag and write. */
class FakeHost {
	readonly state = new Map<string, unknown>();
	readonly flags = new Map<string, boolean | string>();
	/**
	 * Values a test wants the flag to report. `addFlag` applies the host's
	 * default, so a pre-set value has to be declared here to survive init.
	 */
	readonly flagDefaults: Record<string, boolean | string>;

	constructor(flagDefaults: Record<string, boolean | string> = {}) {
		this.flagDefaults = flagDefaults;
	}
	readonly handlers = new Map<string, Array<(payload: unknown) => void>>();
	readonly commands: Array<{
		name: string;
		handler: (context: {args?: string}) => {message?: string} | undefined;
	}> = [];
	readonly overrides = new Map<
		string,
		(
			props: ModUiOverrideProps['spinner'],
			next: () => readonly ModUiTextNode[] | undefined,
		) => readonly ModUiTextNode[] | undefined
	>();
	readonly status: Array<string | null> = [];
	readonly notifications: Array<{message: string; level?: 'info' | 'warning' | 'error' | undefined}> = [];

	api(): ModApi {
		return {
			state: {
				get: <T>(key: string): T | undefined => this.state.get(key) as T | undefined,
				set: (key: string, value: unknown): void => {
					this.state.set(key, value);
				},
			},
			ui: {
				capabilities: {status: true, surface: true},
				setStatus: (text: string | null) => {
					this.status.push(text);
					return {dispose() {}};
				},
				notify: (message: string, level?: 'info' | 'warning' | 'error') => {
					this.notifications.push({message, level});
				},
				override: (component, render) => {
					this.overrides.set(component, render);
					return {dispose() {}};
				},
			},
			addFlag: (name, spec) => {
				this.flags.set(name, this.flagDefaults[name] ?? spec.default);
				return {dispose() {}};
			},
			getFlag: (name) => this.flags.get(name),
			on: (event, handler) => {
				const list = this.handlers.get(event) ?? [];
				list.push(handler);
				this.handlers.set(event, list);
				return {dispose() {}};
			},
			addCommand: (command) => {
				this.commands.push(command);
				return {dispose() {}};
			},
		};
	}

	emit(event: string, payload: unknown = {}): void {
		for (const handler of this.handlers.get(event) ?? []) handler(payload);
	}

	command(args?: string): {message?: string} | undefined {
		const command = this.commands.find(entry => entry.name === 'toks');
		assert.ok(command, 'the mod must register /toks');
		return command!.handler(args === undefined ? {} : {args});
	}

	spinner(
		next: () => readonly ModUiTextNode[] | undefined = () => [],
	): readonly ModUiTextNode[] | undefined {
		const render = this.overrides.get('spinner');
		assert.ok(render, 'the mod must override the spinner');
		return render!({status: 'working', elapsedMs: 0, tokens: 0}, next);
	}
}

/** A controllable clock, so time-dependent wiring does not depend on the wall. */
class Clock {
	private current = 1_000_000;
	private readonly real = Date.now;

	install(): void {
		Date.now = () => this.current;
	}

	restore(): void {
		Date.now = this.real;
	}

	set(value: number): void {
		this.current = value;
	}
}

// --------------------------------------------------------------- registration

test('registers the display flags, the event subscriptions and the /toks command', () => {
	const host = new FakeHost();
	mod(host.api());

	assert.equal(host.flags.get('status'), true);
	assert.equal(host.flags.get('spinner'), true);
	assert.equal(host.flags.get('lang'), DEFAULT_LANG);

	for (const event of [
		'run_start',
		'model_request_start',
		'message_update',
		'text_delta',
		'thinking_delta',
		'interrupted',
		'run_error',
		'model_request_end',
	]) {
		assert.ok(host.handlers.get(event)?.length, `expected a ${event} subscription`);
	}

	assert.equal(host.commands.length, 1);
	assert.equal(host.commands[0]!.name, 'toks');
	assert.ok(host.overrides.has('spinner'));
});

// ----------------------------------------------------------- /toks command

test('/toks reports the persisted reading before any new request', () => {
	const host = new FakeHost();
	const stored: LastRequest = {
		rate: 61.8,
		output: 120,
		ms: 4100,
		decodeMs: 3500,
		ttftMs: 812,
		clamped: false,
		model: 'vendor/model',
		at: 1_700_000_000_000,
	};
	host.state.set('lastRequest', stored);
	mod(host.api());

	assert.equal(
		host.command()?.message,
		describeText({last: stored, measuring: false}, copyFor('en')),
	);
});

test('/toks reports measuring while a request is in flight', t => {
	const clock = new Clock();
	clock.install();
	t.after(() => clock.restore());

	const host = new FakeHost();
	mod(host.api());
	host.emit('model_request_start');

	assert.equal(host.command()?.message, copyFor('en').measuring);
});

test('/toks lang switches the language and stores the choice', () => {
	const host = new FakeHost();
	mod(host.api());

	assert.equal(host.command('lang zh')?.message, LANG_SET);
	assert.equal(host.state.get('lang'), 'zh');
	assert.equal(host.command()?.message, copyFor('zh').nothingMeasured);

	assert.equal(host.command('lang en')?.message, LANG_SET);
	assert.equal(host.state.get('lang'), 'en');
	assert.equal(host.command()?.message, copyFor('en').nothingMeasured);
});

test('/toks only treats a real lang argument as a switch', () => {
	// Regression: a prefix match turned `langzh` into `zh` and read `language`
	// as `lang` plus a value, reporting a successful switch for both.
	const host = new FakeHost();
	mod(host.api());

	assert.equal(host.command('langzh')?.message, copyFor('en').usage);
	assert.equal(host.command('language')?.message, copyFor('en').usage);
	assert.equal(host.state.get('lang'), undefined, 'no switch should have been stored');

	// A bare `lang`, or a `lang` with an unsupported value, is still the switch
	// command, so it answers with the switch message rather than usage.
	assert.equal(host.command('lang')?.message, LANG_SET);
	assert.equal(host.command('lang zhish')?.message, LANG_SET);
	assert.equal(host.state.get('lang'), undefined, 'a rejected value is not stored');
});

test('/toks on and off toggle both displays and clear the footer', () => {
	const host = new FakeHost();
	mod(host.api());

	assert.equal(host.command('off')?.message, copyFor('en').allToggled(false));
	assert.equal(host.state.get('show.spinner'), false);
	assert.equal(host.state.get('show.status'), false);
	assert.deepEqual(host.status, [null]);

	assert.equal(host.command('on')?.message, copyFor('en').allToggled(true));
	assert.equal(host.state.get('show.spinner'), true);
	assert.equal(host.state.get('show.status'), true);
});

test('/toks spinner and status toggle their own surface', () => {
	const host = new FakeHost();
	mod(host.api());

	assert.equal(host.command('spinner')?.message, copyFor('en').toggled('live', false));
	assert.equal(host.state.get('show.spinner'), false);
	assert.equal(host.state.get('show.status'), undefined, 'only the named surface toggles');
	assert.deepEqual(host.status, [], 'the footer is untouched');

	assert.equal(host.command('status')?.message, copyFor('en').toggled('footer', false));
	assert.equal(host.state.get('show.status'), false);
	assert.deepEqual(host.status, [null]);
});

// ------------------------------------------------------- language resolution

test('a stored valid lang is honoured over the flag', () => {
	const host = new FakeHost({lang: 'en'});
	host.state.set('lang', 'zh-CN');
	mod(host.api());

	assert.equal(host.command()?.message, copyFor('zh').nothingMeasured);
});

test('a stored invalid lang does not shadow the flag', () => {
	// Regression: `resolveLang` folds an unrecognized stored string to the
	// default, which used to hide a deliberate flag choice behind a stale value.
	const host = new FakeHost({lang: 'zh'});
	host.state.set('lang', 'klingon');
	mod(host.api());

	assert.equal(host.command()?.message, copyFor('zh').nothingMeasured);
});

test('a stored non-string lang falls back to the flag', () => {
	const host = new FakeHost({lang: 'zh'});
	host.state.set('lang', 42);
	mod(host.api());

	assert.equal(host.command()?.message, copyFor('zh').nothingMeasured);
});

// ---------------------------------------------------------- request lifecycle

test('a finished request is persisted and painted on the status surface', t => {
	const clock = new Clock();
	clock.install();
	t.after(() => clock.restore());

	const host = new FakeHost();
	mod(host.api());

	clock.set(1_000_000);
	host.emit('model_request_start');
	host.emit('text_delta', {delta: 'x'.repeat(108)}); // 30 estimated tokens
	clock.set(1_004_000);
	host.emit('model_request_end', {usage: {outputTokens: 100}, model: 'vendor/model'});

	const stored = host.api().state.get<LastRequest>('lastRequest');
	assert.ok(stored, 'the reading should be persisted');
	assert.equal(stored.rate, 25);
	assert.equal(stored.output, 100);
	assert.equal(stored.decodeMs, 4000);
	assert.equal(stored.model, 'vendor/model');
	assert.equal(host.status.at(-1), statusLabel(stored));
});

test('the status surface is skipped when its flag is off', t => {
	const clock = new Clock();
	clock.install();
	t.after(() => clock.restore());

	const host = new FakeHost({status: false});
	mod(host.api());

	clock.set(1_000_000);
	host.emit('model_request_start');
	host.emit('text_delta', {delta: 'x'.repeat(108)});
	clock.set(1_004_000);
	host.emit('model_request_end', {usage: {outputTokens: 100}, model: 'vendor/model'});

	assert.equal(host.status.length, 0, 'no footer line when the flag is off');
});

test('a request without provider usage warns once, not on every request', t => {
	const clock = new Clock();
	clock.install();
	t.after(() => clock.restore());

	const host = new FakeHost();
	mod(host.api());

	clock.set(1_000_000);
	host.emit('model_request_start');
	host.emit('model_request_end', {});
	clock.set(1_004_000);
	host.emit('model_request_start');
	host.emit('model_request_end', {});

	assert.equal(host.notifications.length, 1);
	assert.equal(host.notifications[0]!.message, copyFor('en').missingUsage);
	assert.equal(host.notifications[0]!.level, 'warning');
});

// ------------------------------------------------------------------ spinner

test('the spinner reports a live reading once the window has filled', t => {
	const clock = new Clock();
	clock.install();
	t.after(() => clock.restore());

	const host = new FakeHost();
	mod(host.api());

	clock.set(1_000_000);
	host.emit('model_request_start');

	// Three frames of 10 estimated tokens, 300ms apart: a 33.3 tok/s stream.
	host.emit('text_delta', {delta: 'x'.repeat(36)});
	clock.set(1_000_300);
	host.emit('text_delta', {delta: 'x'.repeat(36)});
	clock.set(1_000_600);
	host.emit('text_delta', {delta: 'x'.repeat(36)});

	const nodes = host.spinner();
	assert.ok(nodes, 'the spinner should paint a live reading');
	const expected = liveLabel({rate: (10 / 300) * 1000, phase: 'writing', stalledFor: null}, copyFor('en'));
	assert.equal(nodes[0]!.text, expected.text);
	assert.equal(nodes[0]!.color, expected.color);
});

test('the spinner returns nothing before a request and before content', () => {
	const host = new FakeHost();
	mod(host.api());

	assert.equal(host.spinner(), undefined, 'no request yet');

	host.emit('model_request_start');
	assert.equal(host.spinner(), undefined, 'no content yet');
});

test('the spinner is silent while switched off and for a single frame', t => {
	const clock = new Clock();
	clock.install();
	t.after(() => clock.restore());

	const host = new FakeHost();
	mod(host.api());

	clock.set(1_000_000);
	host.emit('model_request_start');
	host.emit('text_delta', {delta: 'x'.repeat(108)});
	assert.equal(host.spinner(), undefined, 'a single frame is not a timeline');

	host.state.set('show.spinner', false);
	clock.set(1_000_600);
	host.emit('text_delta', {delta: 'x'.repeat(108)});
	assert.equal(host.spinner(), undefined, 'switched off');

	host.state.set('show.spinner', true);
	clock.set(1_000_900);
	host.emit('text_delta', {delta: 'x'.repeat(108)});
	assert.ok(host.spinner(), 'a full window paints again once re-enabled');
});

// ----------------------------------------------------------- window resets

test('a shrinking message_update resets the window instead of double-counting', t => {
	const clock = new Clock();
	clock.install();
	t.after(() => clock.restore());

	const host = new FakeHost();
	mod(host.api());

	clock.set(1_000_000);
	host.emit('model_request_start');
	host.emit('text_delta', {delta: 'x'.repeat(360)}); // 100 estimated tokens
	clock.set(1_000_300);
	host.emit('text_delta', {delta: 'x'.repeat(360)});
	clock.set(1_000_600);
	host.emit('text_delta', {delta: 'x'.repeat(360)});
	assert.ok(host.spinner(), 'a full window should paint a reading');

	// The provider restarts the stream and the absolute count shrinks.
	clock.set(1_000_900);
	host.emit('message_update', {content: [{type: 'text', text: ''}]});
	assert.equal(host.spinner(), undefined, 'the window must reset to the new stream');
});

test('interrupted abandons the in-flight window', t => {
	const clock = new Clock();
	clock.install();
	t.after(() => clock.restore());

	const host = new FakeHost();
	mod(host.api());

	clock.set(1_000_000);
	host.emit('model_request_start');
	host.emit('text_delta', {delta: 'x'.repeat(36)});
	clock.set(1_000_300);
	host.emit('text_delta', {delta: 'x'.repeat(36)});
	clock.set(1_000_600);
	host.emit('text_delta', {delta: 'x'.repeat(36)});
	assert.ok(host.spinner(), 'a reading before the interrupt');

	host.emit('interrupted');
	assert.equal(host.spinner(), undefined, 'the window is abandoned');
});
