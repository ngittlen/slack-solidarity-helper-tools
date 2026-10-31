import { describe, afterEach, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

vi.mock('./env.js', () => ({
	APP_URL: 'https://app.example',
	VAPID_PUBLIC_KEY: '',
	VAPID_PRIVATE_KEY: '',
}));

import {
	claimPushDevice,
	disablePushDevice,
	enablePushDevice,
	MAX_PUSH_DEVICES,
	MAX_PUSH_FAILURES,
	parseSubscription,
	pushConfigured,
	pushRecipient,
	releasePushDevice,
	sendPush,
	type SendFn,
} from './push.js';

let db: ReturnType<typeof drizzle>;
let client: ReturnType<typeof createClient>;

const NOW = new Date('2026-10-13T18:00:00.000Z');
const MESSAGE = { title: 'Your turf expires soon', body: 'Soon.', url: '/turfs', tag: 'expiry' };
const device = (n: number) => ({
	endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
	keys: { p256dh: `key${n}`, auth: `auth${n}` },
});

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client);
	await migrate(db, { migrationsFolder: 'drizzle' });
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	client.close();
	vi.restoreAllMocks();
});

/** Each device, with who is using it and who is opted in on it. */
async function devices() {
	const res = await client.execute(
		`SELECT d.endpoint, d.current_user_id, d.failures, d.last_sent_at,
		        (SELECT group_concat(o.user_id, ',') FROM
		           (SELECT user_id FROM push_opt_ins WHERE device_id = d.id ORDER BY user_id) o
		        ) AS opted_in
		 FROM push_devices d ORDER BY d.id`,
	);
	return res.rows.map((r) => ({ ...r }));
}

async function optIns() {
	const res = await client.execute('SELECT device_id, user_id FROM push_opt_ins');
	return res.rows.map((r) => ({ ...r }));
}

function failing(statusCode: number): SendFn {
	return async () => {
		throw Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
	};
}

describe('parseSubscription', () => {
	it('takes what PushSubscription.toJSON() gives', () => {
		expect(parseSubscription({ ...device(1), expirationTime: null })).toEqual(device(1));
	});

	// Otherwise a client could have the server POST anywhere it liked.
	it('refuses an endpoint that is not https', () => {
		expect(
			parseSubscription({ ...device(1), endpoint: 'http://fcm.googleapis.com/fcm/send/1' }),
		).toBeNull();
		expect(parseSubscription({ ...device(1), endpoint: 'not a url' })).toBeNull();
	});

	it("takes each browser's push service", () => {
		for (const endpoint of [
			'https://fcm.googleapis.com/fcm/send/abc',
			'https://updates.push.services.mozilla.com/wpush/v2/abc',
			'https://wns2-by3p.notify.windows.com/w/?token=abc',
			'https://web.push.apple.com/abc',
		]) {
			expect(parseSubscription({ ...device(1), endpoint })).not.toBeNull();
		}
	});

	it('refuses any other host, a look-alike, or a port', () => {
		for (const endpoint of [
			'https://push.example/1',
			'https://fcm.googleapis.com.evil.example/1',
			'https://evilpush.services.mozilla.com.example/1',
			'https://notify.windows.com.evil.example/1',
			'https://fcm.googleapis.com:8443/fcm/send/1',
			'https://169.254.169.254/latest',
		]) {
			expect(parseSubscription({ ...device(1), endpoint })).toBeNull();
		}
	});

	it('refuses anything missing its keys', () => {
		expect(parseSubscription({ endpoint: device(1).endpoint })).toBeNull();
		expect(parseSubscription({ ...device(1), keys: { p256dh: 'x' } })).toBeNull();
		expect(parseSubscription(null)).toBeNull();
		expect(parseSubscription('x')).toBeNull();
	});
});

describe('pushRecipient', () => {
	// The worker compares it; the payload never carries an account id.
	it('is stable per person, differs between people, and is not the id', () => {
		expect(pushRecipient('U1')).toBe(pushRecipient('U1'));
		expect(pushRecipient('U1')).not.toBe(pushRecipient('U2'));
		expect(pushRecipient('google:123')).not.toContain('123');
	});
});

describe('enablePushDevice', () => {
	it('records the device as theirs and opts them in', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		expect(await devices()).toEqual([
			expect.objectContaining({
				endpoint: device(1).endpoint,
				current_user_id: 'U1',
				opted_in: 'U1',
			}),
		]);
	});

	// Two people on one phone: one device, a setting each.
	it('adds a second person on the same browser without dropping the first', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		await enablePushDevice(db, 'U2', device(1), NOW);
		expect(await devices()).toEqual([
			expect.objectContaining({ current_user_id: 'U2', opted_in: 'U1,U2' }),
		]);
	});

	it("keeps a user's newest devices and drops the oldest past the cap", async () => {
		for (let n = 1; n <= MAX_PUSH_DEVICES + 2; n++) {
			await enablePushDevice(db, 'U1', device(n), new Date(NOW.getTime() + n * 1000));
		}
		await enablePushDevice(db, 'U2', device(99), NOW);
		const rows = await devices();
		expect(rows.filter((r) => r.opted_in === 'U1').map((r) => r.endpoint)).toEqual(
			Array.from({ length: MAX_PUSH_DEVICES }, (_, i) => device(i + 3).endpoint),
		);
		expect(rows.filter((r) => r.opted_in === 'U2')).toHaveLength(1);
	});

	// The cap is per person: someone else opted in on a dropped device keeps it.
	it('keeps a device the cap took from one person while someone else wants it', async () => {
		await enablePushDevice(db, 'U2', device(1), NOW);
		for (let n = 1; n <= MAX_PUSH_DEVICES + 1; n++) {
			await enablePushDevice(db, 'U1', device(n), new Date(NOW.getTime() + n * 1000));
		}
		expect((await devices())[0]).toMatchObject({ endpoint: device(1).endpoint, opted_in: 'U2' });
	});
});

describe('claimPushDevice', () => {
	it('makes the browser theirs, and says whether they have it on', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		expect(await claimPushDevice(db, 'U2', device(1))).toEqual({
			enabled: false,
			recipient: pushRecipient('U2'),
		});
		expect((await devices())[0]).toMatchObject({ current_user_id: 'U2', opted_in: 'U1' });
		expect(await claimPushDevice(db, 'U1', device(1))).toEqual({
			enabled: true,
			recipient: pushRecipient('U1'),
		});
		expect((await devices())[0]).toMatchObject({ current_user_id: 'U1' });
	});

	it('records nothing for a browser nobody turned notifications on in', async () => {
		expect(await claimPushDevice(db, 'U1', device(1))).toMatchObject({ enabled: false });
		expect(await devices()).toEqual([]);
	});
});

describe('disablePushDevice', () => {
	it("turns off the caller's setting and leaves someone else's", async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		await enablePushDevice(db, 'U2', device(1), NOW);
		expect(await disablePushDevice(db, 'U2', device(1).endpoint)).toEqual({
			othersEnabled: true,
		});
		expect((await devices())[0]).toMatchObject({ opted_in: 'U1' });
	});

	it('deletes the device once nobody wants it', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		expect(await disablePushDevice(db, 'U1', device(1).endpoint)).toEqual({
			othersEnabled: false,
		});
		expect(await devices()).toEqual([]);
		expect(await optIns()).toEqual([]);
	});

	it('changes nothing for someone who never turned it on there', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		expect(await disablePushDevice(db, 'U2', device(1).endpoint)).toEqual({
			othersEnabled: true,
		});
		expect(await devices()).toHaveLength(1);
	});
});

describe('releasePushDevice', () => {
	it('leaves the browser to nobody when its current user logs out', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		await releasePushDevice(db, 'U1', device(1).endpoint);
		expect((await devices())[0]).toMatchObject({ current_user_id: null, opted_in: 'U1' });
	});

	// Logging out of a browser someone else has used since is not yours to give up.
	it('leaves a browser someone else has since claimed', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		await claimPushDevice(db, 'U2', device(1));
		await releasePushDevice(db, 'U1', device(1).endpoint);
		expect((await devices())[0]).toMatchObject({ current_user_id: 'U2' });
	});
});

describe('sendPush', () => {
	it('is off without VAPID keys', async () => {
		expect(pushConfigured()).toBe(false);
		await enablePushDevice(db, 'U1', device(1), NOW);
		expect(await sendPush(db, 'U1', MESSAGE)).toBe('no-devices');
	});

	it("sends to every one of the holder's devices and nobody else's", async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		await enablePushDevice(db, 'U1', device(2), NOW);
		await enablePushDevice(db, 'U2', device(3), NOW);
		const send = vi.fn<SendFn>(async () => ({}));

		expect(await sendPush(db, 'U1', MESSAGE, { send, now: NOW })).toBe('sent');

		expect(send.mock.calls.map((c) => c[0].endpoint)).toEqual([
			device(1).endpoint,
			device(2).endpoint,
		]);
		// Says who it is for, so the service worker can tell (service-worker.ts).
		expect(JSON.parse(send.mock.calls[0]![1])).toEqual({ ...MESSAGE, for: pushRecipient('U1') });
		// A host that hangs must not hold the sync with it.
		expect(send.mock.calls[0]![2]).toMatchObject({ topic: 'expiry', timeout: 10_000 });
		expect((await devices())[0]).toMatchObject({ last_sent_at: NOW.toISOString() });
	});

	// Two people on one phone, both opted in: only whoever used it last hears
	// about their turf there, so neither sees the other's.
	it('sends only to devices the holder is the current user of', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		await enablePushDevice(db, 'U2', device(1), NOW);
		const send = vi.fn<SendFn>(async () => ({}));
		expect(await sendPush(db, 'U1', MESSAGE, { send })).toBe('no-devices');
		expect(send).not.toHaveBeenCalled();

		await claimPushDevice(db, 'U1', device(1));
		expect(await sendPush(db, 'U1', MESSAGE, { send })).toBe('sent');
		expect(await sendPush(db, 'U2', MESSAGE, { send })).toBe('no-devices');
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('sends nothing to a browser its user logged out of', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		await releasePushDevice(db, 'U1', device(1).endpoint);
		expect(await sendPush(db, 'U1', MESSAGE, { send: async () => ({}) })).toBe('no-devices');
	});

	it('says when someone has no devices, so the caller falls back', async () => {
		expect(await sendPush(db, 'U1', MESSAGE, { send: async () => ({}) })).toBe('no-devices');
	});

	// The browser unsubscribed or the app was removed: it will never work again.
	it('drops a device the push service says is gone', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		expect(await sendPush(db, 'U1', MESSAGE, { send: failing(410) })).toBe('failed');
		expect(await devices()).toEqual([]);
		expect(await optIns()).toEqual([]);
	});

	it('keeps a device through a few failures, then drops it', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		for (let i = 1; i < MAX_PUSH_FAILURES; i++) {
			await sendPush(db, 'U1', MESSAGE, { send: failing(500) });
			expect(await devices()).toEqual([expect.objectContaining({ failures: i })]);
		}
		await sendPush(db, 'U1', MESSAGE, { send: failing(500) });
		expect(await devices()).toEqual([]);
	});

	it('is sent when any device took it', async () => {
		await enablePushDevice(db, 'U1', device(1), NOW);
		await enablePushDevice(db, 'U1', device(2), NOW);
		const send: SendFn = async (sub) => {
			if (sub.endpoint === device(1).endpoint)
				throw Object.assign(new Error(), { statusCode: 404 });
			return {};
		};
		expect(await sendPush(db, 'U1', MESSAGE, { send })).toBe('sent');
		expect((await devices()).map((d) => d.endpoint)).toEqual([device(2).endpoint]);
	});

	it('never throws, even when the database does', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		client.close();
		expect(await sendPush(db, 'U1', MESSAGE, { send: async () => ({}) })).toBe('failed');
	});
});
