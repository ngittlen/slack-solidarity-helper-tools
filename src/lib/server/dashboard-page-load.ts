import { parseDaysParam, type DashboardDaysPreset } from '$lib/components/dashboard/days.js';
import {
	type DaySignups,
	loadSolidaritySignups,
	loadSlackSignups,
} from './dashboard-signups.js';
import { db } from './db.js';

export type SourceResult =
	| { ok: true; days: DaySignups[] }
	| { ok: false; error: string };

export interface DashboardPageData {
	days: DashboardDaysPreset;
	userName: string;
	isAdmin: boolean;
	solidarity: SourceResult;
	slack: SourceResult;
}

interface DashboardLoadEvent {
	url: URL;
	locals: App.Locals;
	depends: (...deps: string[]) => void;
}

const GENERIC_LOAD_ERROR = 'Failed to load signups. Please try again.';

function settledResult(
	label: string,
	settled: PromiseSettledResult<DaySignups[]>,
): SourceResult {
	if (settled.status === 'fulfilled') return { ok: true, days: settled.value };
	const err = settled.reason;
	console.error(`[dashboard] ${label} load failed:`, err instanceof Error ? err.message : err);
	return { ok: false, error: GENERIC_LOAD_ERROR };
}

// Shared load body for `/`, `/dashboard/solidarity`, and `/dashboard/slack`.
export async function loadDashboardPageData(
	event: DashboardLoadEvent,
): Promise<DashboardPageData> {
	event.depends('app:dashboard');

	const days = parseDaysParam(event.url.searchParams);

	const [solidaritySettled, slackSettled] = await Promise.allSettled([
		loadSolidaritySignups(db, { days }),
		loadSlackSignups(db, { days }),
	]);

	return {
		days,
		userName: event.locals.session!.slackUserName,
		isAdmin: event.locals.session!.isAdmin,
		solidarity: settledResult('solidarity', solidaritySettled),
		slack: settledResult('slack', slackSettled),
	};
}
