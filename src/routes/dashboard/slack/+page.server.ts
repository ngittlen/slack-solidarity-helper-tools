import type { PageServerLoad } from './$types';
import { loadDashboardPageData } from '$lib/server/dashboard-page-load.js';

export const load: PageServerLoad = (event) => loadDashboardPageData(event);
