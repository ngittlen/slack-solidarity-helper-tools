import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFieldAutosave } from './use-field-autosave.svelte.js';

/** A controllable promise for `save`/`validate` mocks. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Trigger an `oninput`-style event with a string value. */
function inputEvent(value: string): Event {
	const target = { value } as unknown as EventTarget;
	return { target } as unknown as Event;
}

beforeEach(() => {
	// Default to fake timers; the two `flush()` tests opt back to real timers.
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('initial state', () => {
	it('starts at value=initial, status=idle, error=null', () => {
		const save = vi.fn();
		const f = createFieldAutosave<string>({ initial: 'foo', save });
		expect(f.value).toBe('foo');
		expect(f.status).toBe('idle');
		expect(f.error).toBeNull();
		expect(save).not.toHaveBeenCalled();
	});
});

describe('debounce', () => {
	it('coalesces a burst of typing into one save call after the quiet window', async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const f = createFieldAutosave<string>({ initial: '', save });

		f.oninput(inputEvent('a'));
		await vi.advanceTimersByTimeAsync(500);
		f.oninput(inputEvent('ab'));
		await vi.advanceTimersByTimeAsync(600);

		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith('ab');
	});
});


describe('FR-015a single-flight serialization', () => {
	it('holds new input while a save is in flight and fires one trailing save with the latest value after the in-flight resolves', async () => {
		const first = deferred<void>();
		const second = deferred<void>();
		const save = vi
			.fn<(v: string) => Promise<void>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);

		const f = createFieldAutosave<string>({ initial: '', save });
		f.oninput(inputEvent('a'));
		await vi.advanceTimersByTimeAsync(600);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith('a');
		expect(f.status).toBe('saving');

		// While in flight, type more.
		f.oninput(inputEvent('ab'));
		f.oninput(inputEvent('abc'));
		// Still only the first call — second is buffered.
		expect(save).toHaveBeenCalledTimes(1);

		// Resolve the in-flight; helper should re-arm a fresh debounce, not fire immediately.
		first.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(save).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(600);
		expect(save).toHaveBeenCalledTimes(2);
		expect(save).toHaveBeenLastCalledWith('abc');

		second.resolve();
		await vi.advanceTimersByTimeAsync(0);
	});
});

describe('FR-015b saved auto-dismiss', () => {
	it('moves pending → saving → saved on success; auto-dismisses to idle after ~2s', async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const f = createFieldAutosave<string>({ initial: '', save });

		f.oninput(inputEvent('a'));
		expect(f.status).toBe('pending');

		await vi.advanceTimersByTimeAsync(600);
		// save() resolved synchronously via the mock; advance microtasks
		await vi.advanceTimersByTimeAsync(0);
		expect(f.status).toBe('saved');

		await vi.advanceTimersByTimeAsync(2000);
		expect(f.status).toBe('idle');
	});
});

describe('input during saved window', () => {
	it('typing while saved cancels the auto-dismiss and moves directly to pending', async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const f = createFieldAutosave<string>({ initial: '', save });

		f.oninput(inputEvent('a'));
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.status).toBe('saved');

		f.oninput(inputEvent('ab'));
		// Immediate transition to pending — the saved-dismiss timer was canceled.
		// (A fresh save cycle will eventually land back at saved → idle; that's
		// the new cycle, not the original dismiss firing through.)
		expect(f.status).toBe('pending');
		expect(f.value).toBe('ab');
	});
});

describe('save rejection', () => {
	it('moves to error with the rejection message; no further calls', async () => {
		const save = vi.fn().mockRejectedValue(new Error('nope'));
		const f = createFieldAutosave<string>({ initial: '', save });

		f.oninput(inputEvent('a'));
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(0);

		expect(f.status).toBe('error');
		expect(f.error).toBe('nope');
		expect(save).toHaveBeenCalledTimes(1);
	});
});

describe('retry()', () => {
	it('re-fires save with the buffered value and transitions through saving', async () => {
		const saveErr = vi.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValueOnce(undefined);
		const f = createFieldAutosave<string>({ initial: '', save: saveErr });

		f.oninput(inputEvent('x'));
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.status).toBe('error');

		f.retry();
		expect(f.status).toBe('saving');
		await vi.advanceTimersByTimeAsync(0);
		expect(saveErr).toHaveBeenCalledTimes(2);
		expect(saveErr).toHaveBeenLastCalledWith('x');
		expect(f.status).toBe('saved');
		expect(f.error).toBeNull();
	});
});

describe('input while error', () => {
	it('typing while error moves to pending and arms a fresh debounce', async () => {
		const save = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
		const f = createFieldAutosave<string>({ initial: '', save });

		f.oninput(inputEvent('a'));
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.status).toBe('error');

		f.oninput(inputEvent('ab'));
		expect(f.status).toBe('pending');
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(0);

		expect(save).toHaveBeenCalledTimes(2);
		expect(save).toHaveBeenLastCalledWith('ab');
	});
});

describe('validate rejects', () => {
	it('does not call save; surfaces validate rejection message as error', async () => {
		const save = vi.fn();
		const validate = vi.fn().mockRejectedValue(new Error('bad'));
		const f = createFieldAutosave<string>({ initial: '', save, validate });

		f.oninput(inputEvent('a'));
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(0);

		expect(validate).toHaveBeenCalledTimes(1);
		expect(save).not.toHaveBeenCalled();
		expect(f.status).toBe('error');
		expect(f.error).toBe('bad');
	});
});

describe('validate resolves', () => {
	it('calls validate before save in order', async () => {
		const callOrder: string[] = [];
		const save = vi.fn(async () => {
			callOrder.push('save');
		});
		const validate = vi.fn(async () => {
			callOrder.push('validate');
		});
		const f = createFieldAutosave<string>({ initial: '', save, validate });

		f.oninput(inputEvent('a'));
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(0);

		expect(callOrder).toEqual(['validate', 'save']);
	});
});

describe('flush()', () => {
	it('from pending: cancels debounce and dispatches save synchronously with the buffered value', async () => {
		vi.useRealTimers();
		const save = vi.fn().mockResolvedValue(undefined);
		const f = createFieldAutosave<string>({ initial: '', save });

		f.oninput(inputEvent('hello'));
		expect(f.status).toBe('pending');
		f.flush();
		// flush is sync — save was called before any timer could elapse.
		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith('hello');
	});
    
	it('from saving-with-dirty: also dispatches the buffered trailing save', async () => {
		vi.useRealTimers();
		const first = deferred<void>();
		const save = vi
			.fn<(v: string) => Promise<void>>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(undefined);

		const f = createFieldAutosave<string>({
			initial: '',
			save,
			debounceMs: 10,
		});
		f.oninput(inputEvent('a'));
		// Wait the short debounce so save() is called.
		await new Promise((r) => setTimeout(r, 20));
		expect(save).toHaveBeenCalledTimes(1);
		expect(f.status).toBe('saving');

		// Type more while in-flight (buffered).
		f.oninput(inputEvent('ab'));

		// Flush. Should dispatch the trailing buffered save immediately.
		f.flush();
		expect(save).toHaveBeenCalledTimes(2);
		expect(save).toHaveBeenLastCalledWith('ab');

		first.resolve();
		await new Promise((r) => setTimeout(r, 0));
	});

	// 13 — flush() while idle is a no-op
	it('from idle: no save call', () => {
		vi.useRealTimers();
		const save = vi.fn();
		const f = createFieldAutosave<string>({ initial: '', save });
		f.flush();
		expect(save).not.toHaveBeenCalled();
	});
});

describe('destroy()', () => {
	it('cancels a pending debounce so save never fires after teardown', async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const f = createFieldAutosave<string>({ initial: '', save });

		f.oninput(inputEvent('a'));
		expect(f.status).toBe('pending');

		f.destroy();
		await vi.advanceTimersByTimeAsync(600);

		expect(save).not.toHaveBeenCalled();
	});

	it('does not fire a trailing save after destroy() when input was buffered during an in-flight save', async () => {
		const first = deferred<void>();
		const save = vi
			.fn<(v: string) => Promise<void>>()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue(undefined);
		const f = createFieldAutosave<string>({ initial: '', save });

		f.oninput(inputEvent('a'));
		await vi.advanceTimersByTimeAsync(600);
		expect(save).toHaveBeenCalledTimes(1);
		expect(f.status).toBe('saving');

		// Buffer more input while the save is in flight, then tear down.
		f.oninput(inputEvent('ab'));
		f.destroy();

		// Resolving the in-flight save must NOT re-arm a trailing debounce.
		first.resolve();
		await vi.advanceTimersByTimeAsync(600);
		expect(save).toHaveBeenCalledTimes(1);
	});

	// The unregistration half of destroy() — removal from the beforeunload set —
	// only has an observable effect when `window` exists. The project has no DOM
	// test environment (all suites run under node), so rather than pull in jsdom
	// we stub a minimal window to capture the registered unload handler and
	// invoke it directly.
	it('unregisters from the beforeunload set so a destroyed instance does not flush on unload', () => {
		vi.useRealTimers();
		let unloadHandler: (() => void) | null = null;
		vi.stubGlobal('window', {
			addEventListener: (type: string, handler: () => void) => {
				if (type === 'beforeunload') unloadHandler = handler;
			},
		});

		const saveA = vi.fn().mockResolvedValue(undefined);
		const saveB = vi.fn().mockResolvedValue(undefined);
		const a = createFieldAutosave<string>({ initial: '', save: saveA });
		const b = createFieldAutosave<string>({ initial: '', save: saveB });

		// Both hold buffered, pending input (a live debounce timer to flush).
		a.oninput(inputEvent('a'));
		b.oninput(inputEvent('b'));

		// Tear down `a`, then fire the captured beforeunload handler.
		a.destroy();
		expect(unloadHandler).not.toBeNull();
		unloadHandler!();

		// Only the surviving instance flushed its pending value.
		expect(saveA).not.toHaveBeenCalled();
		expect(saveB).toHaveBeenCalledWith('b');

		b.destroy(); // tidy the survivor's debounce timer
	});
});
