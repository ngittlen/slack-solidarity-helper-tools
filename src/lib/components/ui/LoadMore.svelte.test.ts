import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import LoadMore from './LoadMore.svelte';

/** The observers LoadMore creates, so a test can report the sentinel in view. */
let observers: { callback: IntersectionObserverCallback; disconnected: boolean }[];

class FakeIntersectionObserver {
	readonly entry: (typeof observers)[number];
	constructor(callback: IntersectionObserverCallback) {
		this.entry = { callback, disconnected: false };
		observers.push(this.entry);
	}
	observe() {}
	disconnect() {
		this.entry.disconnected = true;
	}
}

function sentinelInView() {
	for (const { callback, disconnected } of observers) {
		if (!disconnected) {
			callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
		}
	}
}

/** A table of `count` rows with LoadMore after it, as the organizer board has
 *  it. `more()` adds `pageSize` rows and, once `total` are on screen, marks
 *  the list done, the way RowWindow does. */
function setup({ count = 2, pageSize = 2, total = 6 } = {}) {
	const target = document.createElement('div');
	document.body.append(target);
	const tbody = document.createElement('tbody');
	const table = document.createElement('table');
	table.append(tbody);
	target.append(table);

	const addRows = (n: number) => {
		for (let i = 0; i < n; i++) {
			const tr = document.createElement('tr');
			tr.textContent = `row ${tbody.rows.length + 1}`;
			tbody.append(tr);
		}
	};
	addRows(count);

	const props = $state({
		onnear: vi.fn(() => {
			addRows(pageSize);
			props.disabled = tbody.rows.length >= total;
		}),
		disabled: false,
	});
	const component = mount(LoadMore, { target, props });
	flushSync();

	const button = () => target.querySelector('button');
	return { target, tbody, props, button, cleanup: () => unmount(component) };
}

beforeEach(() => {
	observers = [];
	vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
	// The re-check after a load measures layout, which jsdom does not have.
	vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe('LoadMore', () => {
	it('loads when the sentinel comes into view', () => {
		const { props, tbody, cleanup } = setup();
		sentinelInView();
		expect(props.onnear).toHaveBeenCalledTimes(1);
		expect(tbody.rows).toHaveLength(4);
		cleanup();
	});

	it('loads when the button is pressed', () => {
		const { props, button, cleanup } = setup();
		button()!.click();
		expect(props.onnear).toHaveBeenCalledTimes(1);
		cleanup();
	});

	it('renders nothing, and stops watching, once there is no more', () => {
		const { props, target, cleanup } = setup();
		props.disabled = true;
		flushSync();
		expect(target.querySelector('.sentinel')).toBeNull();
		expect(target.querySelector('button')).toBeNull();
		expect(observers.every((o) => o.disconnected)).toBe(true);
		cleanup();
	});

	it('keeps focus on the button while there is more to load', async () => {
		const { button, cleanup } = setup();
		button()!.focus();
		button()!.click();
		flushSync();
		await tick();
		expect(document.activeElement).toBe(button());
		cleanup();
	});

	it('moves focus to the first new row when a press loads the last page', async () => {
		const { button, tbody, cleanup } = setup({ count: 2, pageSize: 2, total: 4 });
		button()!.focus();
		button()!.click();
		flushSync();
		await tick();
		expect(button()).toBeNull();
		expect(document.activeElement).toBe(tbody.rows[2]);
		expect(tbody.rows[2].tabIndex).toBe(-1);
		cleanup();
	});

	it('counts rows from the last press, not from when the button took focus', async () => {
		const { button, tbody, cleanup } = setup({ count: 2, pageSize: 2, total: 6 });
		button()!.focus();
		button()!.click();
		flushSync();
		await tick();
		button()!.click();
		flushSync();
		await tick();
		expect(document.activeElement).toBe(tbody.rows[4]);
		cleanup();
	});

	it('falls back to the last row when the last load added none', async () => {
		const { button, tbody, props, cleanup } = setup();
		props.onnear = vi.fn(() => {
			props.disabled = true;
		});
		flushSync();
		button()!.focus();
		button()!.click();
		flushSync();
		await tick();
		expect(document.activeElement).toBe(tbody.rows[1]);
		cleanup();
	});
});
