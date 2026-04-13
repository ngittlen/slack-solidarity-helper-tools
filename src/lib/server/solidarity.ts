import { SOLIDARITY_API_TOKEN } from './env.js';

export interface SolidarityUser {
	chapter_id: number | null;
	chapter_ids: number[];
	address: {
		city: string | null;
		state: string | null;
	} | null;
}

export async function getUserByEmail(email: string): Promise<SolidarityUser | null> {
	const url = `https://api.solidarity.tech/v1/users?email=${encodeURIComponent(email)}&_limit=1`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: `Bearer ${SOLIDARITY_API_TOKEN}` },
		});
	} catch (err) {
		console.error('[solidarity] network error during user lookup:', err instanceof Error ? err.message : err);
		return null;
	}
	if (!response.ok) {
		console.error(`[solidarity] user lookup failed with status ${response.status} for ${email}`);
		return null;
	}
	const data = (await response.json()) as { data?: SolidarityUser[] };
	if (!data.data?.length) return null;
	return data.data[0]!;
}