import type { RequestHandler } from './$types';
import { json, redirect } from '@sveltejs/kit';
import { subscribe } from '$lib/server/events.js';

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.session) {
		redirect(302, '/auth/slack');
	}
	if (!locals.session.isAdmin) {
		return json({ error: 'unauthorized' }, { status: 403 });
	}

	let unsubscribe: () => void;
	let keepAlive: ReturnType<typeof setInterval>;

	const stream = new ReadableStream({
		start(controller) {
			const send = (data: string) => {
				try {
					controller.enqueue(`data: ${data}\n\n`);
				} catch (err) {
					// Controller already closed (e.g. client disconnected mid-broadcast)
					console.error('[events] enqueue failed, unsubscribing:', err instanceof Error ? err.message : err);
					clearInterval(keepAlive);
					unsubscribe?.();
				}
			};

			try {
				unsubscribe = subscribe(send);
			} catch (err) {
				console.error('[events] subscribe failed:', err instanceof Error ? err.message : err);
				controller.error(err);
				return;
			}

			// Keep-alive comment every 30s to prevent proxy timeouts
			keepAlive = setInterval(() => {
				try {
					controller.enqueue(': keep-alive\n\n');
				} catch {
					clearInterval(keepAlive);
					unsubscribe?.();
				}
			}, 30_000);
		},
		cancel() {
			clearInterval(keepAlive);
			unsubscribe?.();
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
};