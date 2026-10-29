import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounced } from './debounce.js';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('debounced', () => {
	it('runs once calls stop, with the last arguments', () => {
		const fn = vi.fn();
		const d = debounced(fn, 500);
		d.call('k');
		vi.advanceTimersByTime(300);
		d.call('ke');
		vi.advanceTimersByTime(300);
		d.call('ken');
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(500);
		expect(fn).toHaveBeenCalledOnce();
		expect(fn).toHaveBeenCalledWith('ken');
	});

	// Enter applies at once; the wait already running must not apply again.
	it('runs now and drops the waiting call', () => {
		const fn = vi.fn();
		const d = debounced(fn, 500);
		d.call('ke');
		d.now('kent');
		vi.advanceTimersByTime(1000);
		expect(fn.mock.calls).toEqual([['kent']]);
	});

	it('runs nothing once cancelled', () => {
		const fn = vi.fn();
		const d = debounced(fn, 500);
		d.call('kent');
		d.cancel();
		vi.advanceTimersByTime(1000);
		expect(fn).not.toHaveBeenCalled();
	});
});
