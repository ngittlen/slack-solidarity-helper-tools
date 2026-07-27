// Solidarity ActionPages — the source of the *formatted* event description.
//
// /v1/events returns a flattened plain-text `description`; the linked page
// (event.event_page_id) holds the same content as HTML with the bold, links and
// lists intact. Fetched in one paginated sweep and indexed by id rather than
// one request per event, which keeps us well inside the 60-per-30s rate limit.

import { requireEnv } from './env.js';

interface ActionPage {
	id: number;
	description: string | null;
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 40;

export async function fetchPageDescriptions(apiToken?: string): Promise<Map<number, string>> {
	const token = apiToken || requireEnv('SOLIDARITY_API_TOKEN', 'set it in .env.local');
	const byId = new Map<number, string>();

	for (let page = 0; page < MAX_PAGES; page++) {
		const url = `https://api.solidarity.tech/v1/pages?_limit=${PAGE_LIMIT}&_offset=${page * PAGE_LIMIT}`;
		const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
		if (res.status === 429) {
			await new Promise((r) => setTimeout(r, 5000));
			page--;
			continue;
		}
		if (!res.ok) throw new Error(`Solidarity pages returned ${res.status}: ${await res.text()}`);
		const body = (await res.json()) as { data?: ActionPage[] };
		const items = body.data ?? [];
		for (const item of items) {
			if (item.description) byId.set(item.id, item.description);
		}
		if (items.length < PAGE_LIMIT) break;
	}
	return byId;
}
