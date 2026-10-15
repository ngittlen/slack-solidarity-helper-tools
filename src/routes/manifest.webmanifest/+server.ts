import type { RequestHandler } from './$types';
import { db } from '$lib/server/db.js';
import { getSiteName } from '$lib/server/site.js';

// The web app manifest. An iPhone only lets a site send push notifications
// once it has been added to the Home Screen and opens standalone, which is
// what `display` asks for. Served without a session (public-paths.ts): it
// says nothing but the site's name, which /signin shows anyway.

export const GET: RequestHandler = async () => {
	const name = await getSiteName(db);
	return new Response(
		JSON.stringify({
			name,
			short_name: name.length > 12 ? 'Turf' : name,
			start_url: '/turfs',
			scope: '/',
			display: 'standalone',
			// The toolkit's neutral colours, as static/icon.svg: not any one
			// campaign's brand.
			background_color: '#b9cdf2',
			theme_color: '#1b2a49',
			// static/icon.svg, and PNGs of it for browsers that want one. The
			// pin sits inside the middle 80%, so Android may crop it to a circle.
			icons: [
				{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
				{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
				{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
			],
		}),
		{
			headers: {
				'Content-Type': 'application/manifest+json',
				'Cache-Control': 'public, max-age=3600',
			},
		},
	);
};
