// Reusable per-field autosave helper for NAV-3's editor primitives. Composed
// by every NAV-5..9 editor row. Owns the debounce, the single-flight save
// discipline (FR-015a), the 2s saved → idle auto-dismiss (FR-015b), the
// unload-time flush (FR-015c), and the no-auto-retry error policy (FR-017a).
//
// See specs/007-settings-shell-primitives/contracts/field-autosave.md for the
// full behavioral contract and specs/.../data-model.md#E5 for the return shape.

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface FieldAutosave<T> {
	get value(): T;
	set value(v: T);
	readonly status: AutosaveStatus;
	readonly error: string | null;
	/** Bind to `<input oninput={...}>`. Reads `event.target.value`, parses via opts.parse if provided. */
	oninput: (e: Event) => void;
	/** Manual retry — no-op unless status === 'error'. */
	retry: () => void;
	/** Synchronous flush invoked from the module-level beforeunload handler. Editors should rarely call this directly. */
	flush: () => void;
	/**
	 * Teardown — cancels the pending debounce + saved→idle timers and
	 * unregisters from the module-level unload set. The consuming component MUST
	 * call this from its `$effect` cleanup / `onDestroy` so a debounced save
	 * can't fire after the component is gone and the unload registry doesn't
	 * leak instances across `{#if}` toggles.
	 */
	destroy: () => void;
}

export interface CreateFieldAutosaveOptions<T> {
	initial: T;
	save: (value: T) => Promise<void>;
	/** Optional pre-save validator. Reject to surface as `error`; the save call is skipped. */
	validate?: (value: T) => Promise<void>;
	/** Coerce the raw input string into T. Default identity (works for T = string). */
	parse?: (raw: string) => T;
	/** Debounce window for save attempts. Defaults to 600 ms (FR-015). Tests may override. */
	debounceMs?: number;
	/** How long the `saved` status sticks before auto-dismissing to `idle` (FR-015b). Defaults to 2000 ms. */
	saveStateDismissMs?: number;
}

// --------------------------------------------------------------------------
// Module-level unload registry (R5).
//
// WeakSet would be ideal — instances would be GC'd when their consuming
// component dies — but WeakSet is non-iterable, and beforeunload must walk
// every live instance synchronously. So we use a plain Set and rely on the
// fact that NAV-3 editor instances live as long as the page does: when the
// page navigates away, the Set is torn down with everything else. There is
// no long-lived parent with churning autosave children in this feature.
// --------------------------------------------------------------------------

// Plain `Set` (not SvelteSet) is deliberate: this registry is pure
// bookkeeping walked synchronously inside a beforeunload handler. It is never
// read from a reactive context, so the reactivity overhead of SvelteSet would
// buy nothing and obscure the intent.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const liveInstances = new Set<{ flush: () => void }>();
let unloadHandlerRegistered = false;

function ensureUnloadHandler(): void {
	if (unloadHandlerRegistered) return;
	if (typeof window === 'undefined') return;
	window.addEventListener('beforeunload', () => {
		for (const inst of liveInstances) {
			try {
				inst.flush();
			} catch {
				// Unload-time errors are deliberately swallowed — the page is going
				// away and there's no UI surface left to render an error in.
			}
		}
	});
	unloadHandlerRegistered = true;
}

// --------------------------------------------------------------------------

export function createFieldAutosave<T>(opts: CreateFieldAutosaveOptions<T>): FieldAutosave<T> {
	const debounceMs = opts.debounceMs ?? 600;
	const dismissMs = opts.saveStateDismissMs ?? 2000;
	const parse = opts.parse ?? ((raw: string) => raw as unknown as T);

	let value = $state<T>(opts.initial);
	let status = $state<AutosaveStatus>('idle');
	let error = $state<string | null>(null);

	// Non-reactive bookkeeping.
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;
	let inflight = false;
	let dirty = false;
	// Set by destroy(). Guards the two timer-arming paths so an in-flight save
	// that resolves *after* teardown can't re-arm a trailing debounce (and thus
	// a late save) or a saved→idle dismiss timer on an unmounted instance.
	let destroyed = false;

	function clearDebounce(): void {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}
	function clearDismiss(): void {
		if (dismissTimer !== null) {
			clearTimeout(dismissTimer);
			dismissTimer = null;
		}
	}

	function scheduleDismiss(): void {
		if (destroyed) return;
		clearDismiss();
		dismissTimer = setTimeout(() => {
			dismissTimer = null;
			if (status === 'saved') status = 'idle';
		}, dismissMs);
	}

	async function runSave(v: T): Promise<void> {
		inflight = true;
		status = 'saving';
		error = null;
		try {
			if (opts.validate) await opts.validate(v);
			await opts.save(v);
			if (dirty) {
				// Single trailing save (FR-015a). Re-arm a fresh debounce so a
				// rapid-type burst still respects the quiet 600 ms window
				// rather than firing the trailing save instantly.
				dirty = false;
				inflight = false;
				status = 'pending';
				armDebounce();
				return;
			}
			status = 'saved';
			scheduleDismiss();
		} catch (e) {
			status = 'error';
			error = e instanceof Error ? e.message : String(e);
		} finally {
			inflight = false;
		}
	}

	function armDebounce(): void {
		if (destroyed) return;
		clearDebounce();
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void runSave(value);
		}, debounceMs);
	}

	function oninput(e: Event): void {
		const target = e.target as HTMLInputElement | null;
		const raw = target?.value ?? '';
		value = parse(raw);
		clearDismiss();
		error = null;

		if (inflight) {
			// FR-015a: while a save is in flight, buffer the new value and let
			// runSave's resolve branch arm the trailing save. Do NOT re-arm the
			// debounce here — we'd double-fire when the in-flight resolves.
			dirty = true;
			return;
		}
		status = 'pending';
		armDebounce();
	}

	function retry(): void {
		if (status !== 'error') return;
		clearDebounce();
		clearDismiss();
		void runSave(value);
	}

	function flush(): void {
		if (inflight) {
			if (dirty) {
				dirty = false;
				// Fire-and-forget; we are unloading and there is no UI to report errors to.
				void opts.save(value).catch(() => {});
			}
			return;
		}
		if (debounceTimer !== null) {
			clearDebounce();
			void opts.save(value).catch(() => {});
		}
		// idle / saved / error → no-op.
	}

	const instance = { flush };
	liveInstances.add(instance);
	ensureUnloadHandler();

	function destroy(): void {
		destroyed = true;
		clearDebounce();
		clearDismiss();
		liveInstances.delete(instance);
	}

	return {
		get value() {
			return value;
		},
		set value(v: T) {
			value = v;
		},
		get status() {
			return status;
		},
		get error() {
			return error;
		},
		oninput,
		retry,
		flush,
		destroy,
	};
}
