/**
 * Minimal ambient declarations for the host's mod API, so this package can be
 * typechecked standalone.
 *
 * `@commandcode/harness` is provided by Command Code at load time and is not
 * published as an installable package. Only the surface this mod touches is
 * declared; anything wider would drift from the host's real types.
 */

declare module '@commandcode/harness' {
	export interface Disposable {
		dispose(): void;
	}

	export interface ModFlagOptions {
		type: 'boolean' | 'string';
		default: boolean | string;
		description?: string;
	}

	/** The props the host passes when it draws its working spinner. */
	export interface ModUiOverrideProps {
		spinner: {
			status: string;
			elapsedMs: number;
			tokens: number;
		};
	}

	/** A node in a mod-drawn row. Only the shape this mod emits is declared. */
	export interface ModUiTextNode {
		type: 'text';
		text: string;
		color?: 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray';
		dim?: boolean;
		bold?: boolean;
	}

	export interface ModUiCapabilities {
		readonly status: boolean;
		readonly surface: boolean;
	}

	export interface ModStateApi {
		get<T>(key: string): T | undefined;
		set(key: string, value: unknown): void;
	}

	export interface ModUiApi {
		readonly capabilities: ModUiCapabilities;
		setStatus(text: string | null): Disposable;
		notify(message: string, level?: 'info' | 'warning' | 'error'): void;
		override(
			component: 'spinner',
			render: (
				props: ModUiOverrideProps['spinner'],
				next: () => readonly ModUiTextNode[] | undefined,
			) => readonly ModUiTextNode[] | undefined,
		): Disposable;
	}

	export interface ModCommandResult {
		message?: string;
		prompt?: string;
	}

	export interface ModApi {
		readonly state: ModStateApi;
		readonly ui: ModUiApi;
		addFlag(name: string, spec: ModFlagOptions): Disposable;
		getFlag(name: string): boolean | string | undefined;
		on(event: string, handler: (payload: unknown) => void): Disposable;
		addCommand(command: {
			name: string;
			description?: string;
			argumentHint?: string;
			handler: (context: {args?: string}) => ModCommandResult | undefined;
		}): Disposable;
	}
}
