import type { PageServerLoad } from './$types';
import { loadDashboardPageData } from '$lib/server/dashboard-page-load.js';

export const load: PageServerLoad = async (event) => {
	const base = await loadDashboardPageData(event);
	return { ...base, pageTitle: `Hi, ${base.userName}` };
};
