/**
 * toks — an honest tokens-per-second meter for Command Code.
 *
 * Layout: `src/events.ts` reads the host payloads, `src/measure.ts` owns every
 * calculation, `src/format.ts` owns every string, and this file only wires the
 * two to the event stream and the UI surfaces.
 *
 * Sampling note: the live rate is driven by `message_update`, which carries the
 * whole partial message rather than a delta. That makes the count invariant to
 * how the provider fragments the stream, lets a mid-stream retry resurface as a
 * shrinking absolute count, and includes tool-call arguments that never arrive
 * as a text delta.
 */

import type {ModApi, ModUiOverrideProps} from '@commandcode/harness';
import {resolveLang, copyFor, LANG_SET, type Copy, type Lang} from './src/copy.ts';
import {
	readContent,
	readDelta,
	readModel,
	readOutputTokens,
} from './src/events.ts';
import {
	applyCalibration,
	estimateContent,
	estimateTokens,
	finalizeRequest,
	nextEma,
	pickCalibration,
	pruneSamples,
	stalledFor,
	type LastRequest,
	type Phase,
	type Sample,
} from './src/measure.ts';
import {
	describe,
	liveLabel,
	statusLabel,
	surfaceLabel,
} from './src/format.ts';
import {readStoredRequest} from './src/persisted.ts';

type DisplayFlag = 'status' | 'spinner';

export default function (cmd: ModApi): void {
	cmd.addFlag('status', {type: 'boolean', default: true});
	cmd.addFlag('spinner', {type: 'boolean', default: true});
	cmd.addFlag('lang', {type: 'string', default: 'zh'});

	// Both values come back from `cmd.state`, which outlives the process that wrote
	// them, so neither is trusted until it has been validated.
	let lang: Lang = resolveLang(cmd.state.get<unknown>('lang') ?? cmd.getFlag('lang'));
	let copy: Copy = copyFor(lang);

	let samples: Sample[] = [];
	let totalTokens = 0;
	let billedTokens = 0;
	let correction = 1;
	let sawAbsolute = false;

	let phase: Phase = 'writing';
	let thinkingSeen = 0;
	let textSeen = 0;

	let startedAt: number | null = null;
	let firstContentAt: number | null = null;
	let lastContentAt = 0;
	let ema: number | null = null;
	let lastEmaAt = 0;

	let lastRequest: LastRequest | null = readStoredRequest(
		cmd.state.get<unknown>('lastRequest'),
	);
	let warnedMissingUsage = false;

	const isShown = (name: DisplayFlag): boolean => {
		const stored = cmd.state.get<unknown>(`show.${name}`);
		if (typeof stored === 'boolean') return stored;
		return cmd.getFlag(name) !== false;
	};

	const resetWindow = (): void => {
		samples = [];
		totalTokens = 0;
		billedTokens = 0;
		sawAbsolute = false;
		thinkingSeen = 0;
		textSeen = 0;
		phase = 'writing';
		ema = null;
		lastEmaAt = 0;
		firstContentAt = null;
		lastContentAt = 0;
	};

	const abandonRequest = (): void => {
		resetWindow();
		startedAt = null;
	};

	const pushSample = (total: number, billed: number): void => {
		const now = Date.now();
		totalTokens = total;
		billedTokens = billed;
		firstContentAt ??= now;
		lastContentAt = now;
		samples.push({at: now, total, billed});
		samples = pruneSamples(samples, now);
	};

	const countDelta = (kind: Phase, delta: string): void => {
		phase = kind;
		if (sawAbsolute) return;

		const add = estimateTokens(delta);
		if (kind === 'thinking') thinkingSeen += add;
		else textSeen += add;
		pushSample(thinkingSeen + textSeen, textSeen);
	};

	cmd.on('run_start', abandonRequest);

	cmd.on('model_request_start', () => {
		resetWindow();
		startedAt = Date.now();
	});

	// The absolute count makes a retry self-correcting: a restarted stream
	// shrinks, which resets the window instead of double-counting the text.
	cmd.on('message_update', event => {
		const estimate = estimateContent(readContent(event));
		if (estimate === null) return;

		sawAbsolute = true;
		if (estimate.total + 1 < totalTokens) {
			resetWindow();
			sawAbsolute = true;
		}

		if (estimate.text > textSeen) phase = 'writing';
		else if (estimate.thinking > thinkingSeen) phase = 'thinking';
		thinkingSeen = Math.max(thinkingSeen, estimate.thinking);
		textSeen = Math.max(textSeen, estimate.text);

		pushSample(estimate.total, estimate.billed);
	});

	cmd.on('text_delta', event => {
		const delta = readDelta(event);
		if (delta !== null) countDelta('writing', delta);
	});

	cmd.on('thinking_delta', event => {
		const delta = readDelta(event);
		if (delta !== null) countDelta('thinking', delta);
	});

	cmd.on('interrupted', abandonRequest);
	cmd.on('run_error', abandonRequest);

	cmd.on('model_request_end', event => {
		const beganAt = startedAt;
		const tokenAtFirstContent =
			firstContentAt === null || beganAt === null
				? null
				: Math.max(firstContentAt - beganAt, 0);
		const output = readOutputTokens(event);
		const measuredTotal = totalTokens;
		const measuredBilled = billedTokens;
		resetWindow();
		startedAt = null;
		if (beganAt === null) return;

		if (output === null) {
			if (!warnedMissingUsage) {
				warnedMissingUsage = true;
				cmd.ui.notify(copy.missingUsage, 'warning');
			}
			return;
		}

		const ratio = pickCalibration(output, measuredTotal, measuredBilled);
		if (ratio !== null) correction = applyCalibration(correction, ratio);

		const measured = finalizeRequest({
			output,
			ms: Date.now() - beganAt,
			ttftMs: tokenAtFirstContent,
			model: readModel(event),
			at: Date.now(),
		});
		if (measured === null) return;

		lastRequest = measured;
		cmd.state.set('lastRequest', measured);

		if (!isShown('status')) return;
		cmd.ui.setStatus(statusLabel(measured));
	});

	cmd.ui.override('spinner', (_props: ModUiOverrideProps['spinner'], next) => {
		if (!isShown('spinner')) return undefined;
		if (startedAt === null || totalTokens <= 0) return undefined;

		const now = Date.now();
		ema = nextEma(samples, now, ema, lastEmaAt);
		if (ema !== null) lastEmaAt = now;
		if (ema === null) return undefined;

		const reading = {
			rate: Math.max(ema, 0) * correction,
			phase,
			stalledFor: stalledFor(lastContentAt, now),
		};
		const label = liveLabel(reading, copy);

		return [{type: 'text', text: label.text, color: label.color}, ...(next() ?? [])];
	});

	cmd.addCommand({
		name: 'toks',
		description: 'Report or toggle the tokens-per-second display (/toks lang en|zh)',
		handler: ({args}: {args?: string}) => {
			const action = (args ?? '').trim().toLowerCase();
			const measuring = startedAt !== null;

			if (action === '') {
				return {message: describe({last: lastRequest, measuring}, copy)};
			}

			// The language switch applies at runtime, like the display toggles, so a
			// terminal that renders one script better does not need a restart.
			if (action.startsWith('lang')) {
				const value = action.slice(4).trim();
				if (value !== 'en' && value !== 'zh') {
					return {message: LANG_SET};
				}
				lang = value;
				copy = copyFor(lang);
				cmd.state.set('lang', lang);
				return {message: LANG_SET};
			}

			if (action === 'on' || action === 'off') {
				const enabled = action === 'on';
				cmd.state.set('show.spinner', enabled);
				cmd.state.set('show.status', enabled);
				if (!enabled) cmd.ui.setStatus(null);
				return {message: copy.allToggled(enabled)};
			}

			if (action === 'spinner' || action === 'status') {
				const name: DisplayFlag = action;
				const enabled = !isShown(name);
				cmd.state.set(`show.${name}`, enabled);
				if (name === 'status' && !enabled) cmd.ui.setStatus(null);
				return {message: copy.toggled(surfaceLabel(name, copy), enabled)};
			}

			return {message: copy.usage};
		},
	});
}
