import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageFilename } from './image.js';
import { uploadImage, type MobilizeApiConfig } from './mobilize.js';

const API: MobilizeApiConfig = { apiKey: 'test-key', orgId: 44679 };
const HOSTED = 'https://mobilizeamerica.imgix.net/uploads/event/fist-image_20260727015915463491.png';

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
		stubResponse({ data: { url: HOSTED }, error: null, metadata: { url_name: 'public_image_uploads' } });
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
