import { describe, expect, it } from 'vitest';

import { findSignedUrl, imageFilename, publicUrlFor } from './image.js';

const SIGNED =
	'https://mobilize-uploads-prod.s3.us-east-2.amazonaws.com/uploads/event/fist-image_20260727015915463491.jpg' +
	'?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260727%2Fus-east-2%2Fs3%2Faws4_request' +
	'&X-Amz-Date=20260727T015915Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host%3Bx-amz-acl&X-Amz-Signature=980b5433';

describe('publicUrlFor', () => {
	it('strips the signature query string, matching what the create payload carries', () => {
		expect(publicUrlFor(SIGNED)).toBe(
			'https://mobilize-uploads-prod.s3.us-east-2.amazonaws.com/uploads/event/fist-image_20260727015915463491.jpg',
		);
	});
});

describe('findSignedUrl', () => {
	// The presign response shape is unknown, so the URL is located by content
	// rather than by key name.
	it('finds the url at the top level', () => {
		expect(findSignedUrl({ url: SIGNED })).toBe(SIGNED);
	});

	it('finds it under any key name', () => {
		expect(findSignedUrl({ data: { presigned_put_url: SIGNED } })).toBe(SIGNED);
		expect(findSignedUrl({ data: { upload: { signedUrl: SIGNED } } })).toBe(SIGNED);
	});

	it('ignores unsigned urls', () => {
		expect(findSignedUrl({ data: { url: 'https://example.com/plain.jpg' } })).toBeNull();
	});

	it('returns null when there is nothing to find', () => {
		expect(findSignedUrl({})).toBeNull();
		expect(findSignedUrl(null)).toBeNull();
	});

	it('does not hang on a circular structure', () => {
		const node: Record<string, unknown> = {};
		node.self = node;
		expect(findSignedUrl(node)).toBeNull();
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
