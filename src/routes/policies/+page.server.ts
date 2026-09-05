import type { PageServerLoad } from './$types';
import { POLICY_DOCS } from '$lib/server/policy-docs.js';

// Public — see server/public-paths.ts. Nothing here reads the session or the
// database: the documents are build-time constants, already parsed, so this
// load is a return statement and the page cannot leak anything it does not
// have.
export const load: PageServerLoad = () => ({
	docs: POLICY_DOCS,
	pageTitle: 'Privacy & security',
});
