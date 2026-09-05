import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// See src/routes/privacy/+server.ts.
export const GET: RequestHandler = () => redirect(308, '/policies#security');
