import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { getDashboardSignups } from '$lib/server/dashboard-signups.js';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session) {
		return json({ error: 'unauthorized' }, { status: 401 });
	}
	const raw = parseInt(url.searchParams.get('days') ?? '', 10);
	const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_DAYS) : DEFAULT_DAYS;
	const data = await getDashboardSignups(db, { days });
	return json(data);
};
