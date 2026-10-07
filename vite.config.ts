import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
	// Extra hostnames the dev server answers to, comma-separated — an HTTPS
	// tunnel (ngrok, Cloudflare) in front of `npm run dev`, which Sign in with
	// Apple needs because it will not return to localhost. Vite refuses any
	// Host it does not know, so without this the tunnel gets "Blocked request".
	// Read from .env.local like the app's other settings; dev only.
	const env = loadEnv(mode, process.cwd(), '');
	const allowedHosts = (env.DEV_ALLOWED_HOSTS ?? '')
		.split(',')
		.map((host) => host.trim())
		.filter((host) => host !== '');

	return {
		plugins: [sveltekit()],
		server: { allowedHosts },
		test: {
			include: [
				'src/**/*.{test,spec}.{js,ts}',
				'mobilize-migrator/**/*.{test,spec}.{js,ts}',
				'scripts/**/*.{test,spec}.{js,ts}',
			],
			environment: 'node',
		},
	};
});
