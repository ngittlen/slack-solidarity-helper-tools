import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess({ script: true }),
	kit: {
		adapter: adapter(),
		// Kit's built-in origin check rejects any form-encoded POST without an
		// `Origin` header — which is exactly what Slack sends for slash commands
		// and interactivity payloads, and it only bites in production. `['*']`
		// compiles to `csrf_check_origin: false`; the equivalent check is
		// re-implemented in hooks.server.ts with a carve-out for the
		// signature-verified /api/slack/* routes. See src/lib/server/csrf.ts.
		csrf: { trustedOrigins: ['*'] },
	},
};

export default config;
