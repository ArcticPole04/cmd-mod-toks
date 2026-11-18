/**
 * User-facing strings, keyed by language.
 *
 * The footer line stays language-neutral (`tok/s` plus a clock) because it shares
 * a row with the host's own segments; the phase label, the `/toks` report and
 * notices are localized.
 *
 * Every formatter takes raw numbers, never pre-formatted strings, so the unit is
 * appended once in one place (`2.3ss` and `abcms` are not expressible).
 */

export type Lang = 'en' | 'zh';

export interface Copy {
	/** Spinner suffix while text is streaming. */
	writing: string;
	/** Spinner suffix while reasoning is streaming. */
	thinking: string;
	/** Spinner suffix once content has stopped arriving. */
	stalled(seconds: number): string;
	/** `/toks` while a request is in flight and none has finished. */
	measuring: string;
	/** `/toks` before any request has been observed. */
	nothingMeasured: string;
	/** Prefix on `/toks` when a request is running. */
	previousPrefix: string;
	/** Label for the wait before the first token. */
	firstToken(ms: number): string;
	/** Trailing note when the decode span was too short to trust. */
	clampedNote: string;
	/** `总 4.1s（解码 3.5s）` */
	durations(totalSeconds: number, decodeSeconds: number): string;
	/** Output-token count in the report. */
	tokens(count: number): string;
	usage: string;
	toggled(label: string, enabled: boolean): string;
	allToggled(enabled: boolean): string;
	statusSurface: string;
	spinnerSurface: string;
	/** One-time notice when the provider reports no output tokens. */
	missingUsage: string;
}

/** Shown after switching language, so it names both options in either tongue. */
export const LANG_SET = 'Language / 语言: /toks lang en|zh';

/** Thrown by nothing; used to prove at type level that every language has copy. */
const EN: Copy = {
	writing: 'writing',
	thinking: 'thinking',
	stalled: seconds => `stalled ${seconds.toFixed(1)}s`,
	measuring: 'measuring this request…',
	nothingMeasured: 'No model request measured yet.',
	previousPrefix: 'measuring this request · previous: ',
	firstToken: ms => ` · first token ${Math.round(ms)}ms`,
	clampedNote: ' · first token too late, timed the whole request',
	durations: (total, decode) =>
		` · total ${total.toFixed(1)}s (decode ${decode.toFixed(1)}s)`,
	tokens: count => ` · ${count} tokens`,
	usage: 'Usage: /toks [on|off|spinner|status|lang en|zh]',
	toggled: (label, enabled) => `${label} display ${enabled ? 'on' : 'off'}.`,
	allToggled: enabled => (enabled ? 'All displays on.' : 'All displays off.'),
	statusSurface: 'footer',
	spinnerSurface: 'live',
	missingUsage:
		'This model reported no output tokens; the live rate stays an uncalibrated estimate.',
};

const ZH: Copy = {
	writing: '输出',
	thinking: '思考',
	stalled: seconds => `停滞 ${seconds.toFixed(1)}s`,
	measuring: '正在测量本次请求…',
	nothingMeasured: '还没有测到任何模型请求。',
	previousPrefix: '正在测量本次请求 · 上一次：',
	firstToken: ms => ` · 首 token ${Math.round(ms)}ms`,
	clampedNote: ' · 首 token 过晚，按整段耗时估算',
	durations: (total, decode) =>
		` · 总 ${total.toFixed(1)}s（解码 ${decode.toFixed(1)}s）`,
	tokens: count => ` · ${count} tokens`,
	usage: '用法：/toks [on|off|spinner|status|lang en|zh]',
	toggled: (label, enabled) => `${label}显示已${enabled ? '开启' : '关闭'}。`,
	allToggled: enabled => (enabled ? '已开启全部显示。' : '已关闭全部显示。'),
	statusSurface: '底栏',
	spinnerSurface: '实时',
	missingUsage: '测量提示：本模型未输出 token 数，实时速率只能保持估算值。',
};

/**
 * One table, so adding a language is a change in two places — the union above and
 * this record — rather than a new branch in every lookup.
 */
const COPY: Record<Lang, Copy> = {en: EN, zh: ZH};

/**
 * English is the default because the mods hub audience is international: a
 * Chinese-first default reads as broken to most people who install it, and
 * `/toks lang zh` is one command away for those who want it.
 */
export const DEFAULT_LANG: Lang = 'en';

/**
 * Resolve an option or stored value to a language.
 *
 * Accepts what people actually type: case is ignored, surrounding whitespace is
 * trimmed, and a region suffix (`en-US`, `zh-CN`, `zh_Hans`) folds to its base.
 * Anything unrecognized falls back to the default rather than throwing, because
 * a bad `--mod-option` should not break the session.
 */
export function resolveLang(value: unknown): Lang {
	if (typeof value !== 'string') return DEFAULT_LANG;

	const base = value.trim().toLowerCase().split(/[-_]/)[0];
	if (base !== undefined && Object.hasOwn(COPY, base)) return base as Lang;
	return DEFAULT_LANG;
}

/**
 * Whether a raw value names one of the supported languages.
 *
 * `resolveLang` folds an unrecognized value to the default, so it cannot tell a
 * deliberate `en` from a stale string that fell back to it. A caller that needs
 * to know whether a stored value was a real choice uses this predicate first.
 */
export function isLang(value: unknown): value is Lang {
	if (typeof value !== 'string') return false;
	const base = value.trim().toLowerCase().split(/[-_]/)[0];
	return base !== undefined && Object.hasOwn(COPY, base);
}

export function copyFor(lang: Lang): Copy {
	return COPY[lang];
}
