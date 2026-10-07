import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// The URL Google's and Apple's sign-in consent screens link to as the terms of
// service, so
// it is short, stable and outside our page structure. A permanent redirect to
// the section on the combined page, like /privacy and /security, rather than a
// second copy of the document.
export const GET: RequestHandler = () => redirect(308, '/policies#terms');
