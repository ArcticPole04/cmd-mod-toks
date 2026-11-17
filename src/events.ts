/**
 * Readers for the event payloads this mod consumes.
 *
 * Event payloads cross a system boundary: the host types them as `unknown`, so
 * every field is read defensively here, in one place. Tests can then feed
 * half-populated payloads without the rest of the mod caring.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `text_delta` / `thinking_delta` carry the streamed chunk. */
export function readDelta(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	const delta = payload.delta;
	return typeof delta === 'string' && delta.length > 0 ? delta : null;
}

/** `message_update` carries the whole partial message as a content block array. */
export function readContent(payload: unknown): unknown {
	return isRecord(payload) ? payload.content : undefined;
}

/** `model_request_end.usage.outputTokens`: the provider's own count for the request. */
export function readOutputTokens(payload: unknown): number | null {
	const usage = isRecord(payload) ? payload.usage : undefined;
	if (!isRecord(usage)) return null;

	const value = usage.outputTokens;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
		return null;
	return value;
}

/** `model_request_start` / `model_request_end` name the model that ran the call. */
export function readModel(payload: unknown): string {
	if (!isRecord(payload)) return '';
	const value = payload.model;
	return typeof value === 'string' ? value : '';
}
