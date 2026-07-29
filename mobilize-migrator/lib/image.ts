// Copies a Solidarity event image into Mobilize so it can be used as an event's
// featured image.
//
// Mobilize only accepts image URLs it hosts itself, so the bytes have to be
// re-uploaded rather than linked. The v1 API does this in one multipart POST to
// /v1/images (a restricted endpoint), which returns the hosted URL to put in
// `featured_image_url`.
//
// The sync caches the result per source URL in the mobilize_synced_images
// ledger, so an image shared across events uploads once.

import { uploadImage, type MobilizeApiConfig } from './mobilize.js';

export interface UploadedImage {
	/** Mobilize-hosted URL to put in the event's `featured_image_url`. */
	publicUrl: string;
	bytes: number;
	contentType: string;
}

interface DownloadedImage {
	body: ArrayBuffer;
	contentType: string;
	extension: string;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
};

/**
 * Is a previously-recorded upload URL still usable as `featured_image_url`?
 *
 * The v1 API validates this field and answers
 * `{"featured_image_url":["Invalid featured image url"]}` for a URL on the raw
 * upload bucket — `mobilize-uploads-prod.s3.us-east-2.amazonaws.com`. Those URLs
 * are in the ledger because the pre-v1 dashboard code recorded what *it* was
 * given and the dashboard accepted them; every URL `POST /v1/images` returns is
 * on Mobilize's image CDN instead, and all 63 live events with an image use it.
 *
 * Written as a deny-list rather than an allow-list of the CDN host on purpose:
 * if Mobilize ever moves the CDN, an allow-list would reject every fresh upload
 * and re-upload the same image every night forever.
 */
export function isReusableImageUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).host.toLowerCase();
	} catch {
		return false;
	}
	return !(host.startsWith('mobilize-uploads-') && host.endsWith('.amazonaws.com'));
}

export function imageFilename(title: string, extension: string): string {
	const slug =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'event-image';
	return `${slug}.${extension}`;
}

async function downloadImage(url: string): Promise<DownloadedImage> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`image download returned ${res.status} for ${url}`);
	const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim() || 'image/jpeg';
	const extension =
		EXTENSION_BY_TYPE[contentType] ??
		// Fall back to the extension on the path, ignoring any query string.
		(/\.([a-z0-9]{3,4})(?:\?|$)/i.exec(url)?.[1]?.toLowerCase() || 'jpg');
	return { body: await res.arrayBuffer(), contentType, extension };
}

/** Download from Solidarity, upload to Mobilize, return the hosted URL. */
export async function copyImageToMobilize(
	sourceUrl: string,
	eventTitle: string,
	config: MobilizeApiConfig,
): Promise<UploadedImage> {
	const image = await downloadImage(sourceUrl);
	const filename = imageFilename(eventTitle, image.extension);
	const publicUrl = await uploadImage(config, image.body, filename, image.contentType);
	return { publicUrl, bytes: image.body.byteLength, contentType: image.contentType };
}
