import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageFilename, isReusableImageUrl } from './image.js';
import { uploadImage, type MobilizeApiConfig } from './mobilize.js';

const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 44679 };
const HOSTED =
	'https://mobilizeamerica.imgix.net/uploads/event/fist-image_20260727015915463491.png';

function stubResponse(body: unknown) {
	vi.stubGlobal('fetch', async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('uploadImage', () => {
	it('returns the hosted URL from data.url', async () => {
		stubResponse({
			data: { url: HOSTED },
			error: null,
			metadata: { url_name: 'public_image_uploads' },
		});
		expect(await uploadImage(API, new ArrayBuffer(8), 'x.png', 'image/png')).toBe(HOSTED);
	});

	it('throws rather than putting an unknown URL on a public event', async () => {
		// A silent fallback here would attach whatever URL-ish string happened to
		// be in the response to a live event. Fail loudly instead.
		stubResponse({ data: {}, error: null, metadata: { url_name: 'public_image_uploads' } });
		await expect(uploadImage(API, new ArrayBuffer(8), 'x.png', 'image/png')).rejects.toThrow(
			/no data\.url/,
		);
	});
});

describe('imageFilename', () => {
	it('slugifies the event title', () => {
		expect(imageFilename('Operation Get Out the Vote: Flint', 'png')).toBe(
			'operation-get-out-the-vote-flint.png',
		);
	});

	it('falls back when a title slugifies to nothing', () => {
		expect(imageFilename('🗳️', 'jpg')).toBe('event-image.jpg');
	});
});

describe('isReusableImageUrl', () => {
	it('keeps a URL from POST /v1/images', () => {
		expect(isReusableImageUrl(HOSTED)).toBe(true);
	});

	it('rejects a dashboard-era raw upload bucket URL', () => {
		// The exact shape sitting in 38 ledger rows, and what v1 answers
		// "Invalid featured image url" for.
		expect(
			isReusableImageUrl(
				'https://mobilize-uploads-prod.s3.us-east-2.amazonaws.com/uploads/event/operation-get-out-the-vote-flint_20260727020913704660.png',
			),
		).toBe(false);
	});

	it('rejects anything that is not a URL at all', () => {
		expect(isReusableImageUrl('')).toBe(false);
		expect(isReusableImageUrl('not a url')).toBe(false);
	});

	it('accepts a CDN host it has never seen, rather than re-uploading forever', () => {
		// Deny-list, not allow-list: an allow-list pinned to today's CDN would
		// reject every fresh upload the day Mobilize moves it.
		expect(isReusableImageUrl('https://images.mobilize.us/uploads/event/x.png')).toBe(true);
	});
});
