import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// `/privacy` is the conventional URL, and the one that ends up pasted into a
// Slack app listing or a footer somewhere we do not control — so it is a
// permanent redirect to the section on the combined page rather than a second
// copy of the document. Same for `/security`.
export const GET: RequestHandler = () => redirect(308, '/policies#privacy');
