// Run a function once calls to it stop: the filter boxes apply what was typed
// when typing pauses, not on every key.

export interface Debounced<A extends unknown[]> {
	/** Run `fn` once calls stop for the delay. Each call restarts the wait. */
	call(...args: A): void;
	/** Run `fn` now, dropping any call still waiting. */
	now(...args: A): void;
	/** Drop any call still waiting. Call on teardown, so nothing runs after. */
	cancel(): void;
}

export function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		call(...args) {
			clearTimeout(timer);
			timer = setTimeout(() => fn(...args), ms);
		},
		now(...args) {
			clearTimeout(timer);
			fn(...args);
		},
		cancel() {
			clearTimeout(timer);
		},
	};
}
