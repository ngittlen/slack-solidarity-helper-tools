// Copies a Solidarity event image into Mobilize's own uploads bucket.
//
// Mobilize rejects any `image_url` that isn't already in its bucket — a
// Solidarity S3 link, and even Mobilize's own imgix CDN, both come back
// `400 Invalid URL.` — only `mobilize-uploads-prod.s3...` is accepted, verified
// against all four. So the bytes have to be re-hosted.
//
// The flow the dashboard uses, from the captured requests:
//   1. GET /_/api/s3/publicimage/?file_name=…&file_mimetype=…&resource=event
//      -> a presigned S3 PUT url (Mobilize holds the AWS credentials)
//   2. PUT the bytes to that url with `x-amz-acl: public-read`
//   3. send the SAME url minus its query string as `image_url` on the event
//
// Note step 1 is a GET with query parameters, not a POST body.

import { loadSession, type MobilizeSession } from './session.js';

export interface UploadedImage {
	/** Public URL to put in the event's `image_url`. */
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

/** Mobilize's key format: a slug of the filename, then a timestamp. */
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

/**
 * Pull the presigned S3 URL out of Mobilize's response without knowing the
 * field name: walk the JSON and take the first string that looks like an
 * AWS-signed URL. Keeps this working whatever the response shape turns out to
 * be.
 */
export function findSignedUrl(payload: unknown): string | null {
	const seen = new Set<unknown>();
	const walk = (node: unknown): string | null => {
		if (typeof node === 'string') {
			return node.includes('X-Amz-Signature') && node.startsWith('http') ? node : null;
		}
		if (!node || typeof node !== 'object' || seen.has(node)) return null;
		seen.add(node);
		for (const value of Object.values(node as Record<string, unknown>)) {
			const found = walk(value);
			if (found) return found;
		}
		return null;
	};
	return walk(payload);
}

/** Step 1: ask Mobilize to sign an upload for us. */
async function requestPresignedUpload(
	filename: string,
	contentType: string,
	session: MobilizeSession,
): Promise<string> {
	const query = new URLSearchParams({
		file_mimetype: contentType,
		file_name: filename,
		resource: 'event',
	});
	const res = await fetch(`https://www.mobilize.us/_/api/s3/publicimage/?${query}`, {
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'X-CSRFToken': session.csrfToken,
			Cookie: session.cookie,
			Referer: `https://www.mobilize.us/dashboard/${session.orgSlug}/event/create/`,
			'User-Agent': session.userAgent,
		},
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`presign returned ${res.status}${res.status === 403 ? ' (session likely expired)' : ''}: ${text.slice(0, 300)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`presign returned non-JSON: ${text.slice(0, 200)}`);
	}
	const signed = findSignedUrl(parsed);
	if (!signed) throw new Error(`no X-Amz-Signature URL in presign response: ${text.slice(0, 300)}`);
	return signed;
}

/** The object's public URL is the signed URL with its query string removed. */
export function publicUrlFor(signedUrl: string): string {
	return signedUrl.split('?')[0];
}

/** Steps 1-3: download from Solidarity, upload to Mobilize, return the URL. */
export async function copyImageToMobilize(
	sourceUrl: string,
	eventTitle: string,
	session = loadSession(),
): Promise<UploadedImage> {
	const image = await downloadImage(sourceUrl);
	const filename = imageFilename(eventTitle, image.extension);
	const signedUrl = await requestPresignedUpload(filename, image.contentType, session);

	const res = await fetch(signedUrl, {
		method: 'PUT',
		headers: {
			'x-amz-acl': 'public-read',
			'Content-Type': image.contentType,
			Origin: 'https://www.mobilize.us',
			Referer: 'https://www.mobilize.us/',
		},
		body: image.body,
	});
	if (!res.ok) {
		throw new Error(`S3 upload returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
	}
	return {
		publicUrl: publicUrlFor(signedUrl),
		bytes: image.body.byteLength,
		contentType: image.contentType,
	};
}
