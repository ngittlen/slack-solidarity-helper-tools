// How much of a long list is on screen.
//
// A table renders the first page of its rows and grows a page at a time as the
// reader scrolls toward its end (see LoadMore.svelte). Rows already rendered
// never move, so growing the list cannot shift what the reader is looking at.

/** Rows a list shows at first, and adds each time it grows. */
export const ROWS_PER_PAGE = 50;

/**
 * A growing prefix of `items()`.
 *
 * Starts over when `resetKey()` changes — pass the page's query string, so a
 * new filter shows its first page. Deliberately not when the array itself is
 * replaced: a page that reloads its data in place (the organizer board does,
 * when a "Sync VAN now" press finishes) would otherwise shrink a table the
 * reader has scrolled deep into back to one page, right under them.
 */
export class RowWindow<T> {
	readonly #items: () => readonly T[];
	readonly #resetKey: () => string;
	readonly #pageSize: number;
	/** How far the list has grown, and under which key. A stale key reads as
	 *  one page — the reset, without an effect to perform it. */
	#grown = $state<{ key: string; limit: number } | null>(null);

	constructor(items: () => readonly T[], resetKey: () => string, pageSize = ROWS_PER_PAGE) {
		this.#items = items;
		this.#resetKey = resetKey;
		this.#pageSize = pageSize;
	}

	get #limit(): number {
		const grown = this.#grown;
		return grown && grown.key === this.#resetKey() ? grown.limit : this.#pageSize;
	}

	get visible(): T[] {
		return this.#items().slice(0, this.#limit);
	}

	get hasMore(): boolean {
		return this.#items().length > this.#limit;
	}

	/** Show the next page. */
	more(): void {
		this.#grown = { key: this.#resetKey(), limit: this.#limit + this.#pageSize };
	}
}
