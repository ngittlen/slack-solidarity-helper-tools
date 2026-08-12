import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './+server.js';

const mockSaveInfoCommand = vi.hoisted(() => vi.fn());
const mockDeleteInfoCommand = vi.hoisted(() => vi.fn());
const mockFindInfoCommand = vi.hoisted(() => vi.fn());
const mockGetSlackChannels = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/slack', () => ({ slack: {} }));
vi.mock('$lib/server/settings', () => ({
	saveInfoCommand: mockSaveInfoCommand,
	deleteInfoCommand: mockDeleteInfoCommand,
	findInfoCommand: mockFindInfoCommand,
}));
vi.mock('$lib/server/autocomplete-sources', () => ({ getSlackChannels: mockGetSlackChannels }));

const ADMIN = { slackUserId: 'U_ADMIN', slackUserName: 'Admin', isAdmin: true };

function call(body: unknown, session: unknown = ADMIN) {
	const request = new Request('http://localhost/api/settings/info-commands', {
		method: 'POST',
		body: typeof body === 'string' ? body : JSON.stringify(body),
		headers: { 'Content-Type': 'application/json' },
	});
	return POST({ request, locals: { session } } as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFindInfoCommand.mockResolvedValue(null);
	mockSaveInfoCommand.mockResolvedValue(undefined);
	mockDeleteInfoCommand.mockResolvedValue(undefined);
	mockGetSlackChannels.mockResolvedValue({
		items: [
			{ id: 'C_PHONE', name: 'phone-bank', isPrivate: false },
			{ id: 'C_TEXT', name: 'text-bank', isPrivate: false },
		],
	});
});

describe('authorization', () => {
	it('rejects an unauthenticated request', async () => {
		const res = await call({ action: 'save', command: '/x', message: 'hi' }, null);
		expect(res.status).toBe(401);
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
	});

	it('rejects a non-admin', async () => {
		const res = await call(
			{ action: 'save', command: '/x', message: 'hi' },
			{
				...ADMIN,
				isAdmin: false,
			},
		);
		expect(res.status).toBe(403);
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
	});
});

describe('validation', () => {
	it('rejects a malformed body', async () => {
		const res = await call('not json');
		expect(res.status).toBe(400);
	});

	it('rejects an unknown action', async () => {
		const res = await call({ action: 'frobnicate', command: '/x' });
		expect(res.status).toBe(400);
	});

	it('rejects an invalid command name', async () => {
		const res = await call({ action: 'save', command: '/has spaces', message: 'hi' });
		expect(res.status).toBe(400);
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
	});

	it('rejects a blank message', async () => {
		const res = await call({ action: 'save', command: '/info-phone', message: '   ' });
		expect(res.status).toBe(400);
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
	});

	it('refuses to shadow a command the app already handles', async () => {
		const res = await call({ action: 'save', command: '/member-note', message: 'hi' });
		expect(res.status).toBe(400);
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
	});
});

describe('channel checking', () => {
	it('rejects a message naming a channel that does not exist', async () => {
		// A typo would otherwise post as literal text to a whole channel.
		const res = await call({
			action: 'save',
			command: '/info-phone',
			message: 'Join #phone-bank and #nope',
		});

		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain('#nope');
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
	});

	it('reports a Slack outage as transient rather than storing unchecked names', async () => {
		mockGetSlackChannels.mockRejectedValue(new Error('slack down'));

		const res = await call({
			action: 'save',
			command: '/info-phone',
			message: 'Join #phone-bank',
		});

		expect(res.status).toBe(503);
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
	});

	it('skips the Slack call entirely when the message names no channels', async () => {
		const res = await call({ action: 'save', command: '/info-phone', message: 'No channels.' });

		expect(res.status).toBe(200);
		expect(mockGetSlackChannels).not.toHaveBeenCalled();
	});
});

describe('save', () => {
	it('stores the normalized command and trimmed message', async () => {
		const res = await call({
			action: 'save',
			command: 'Info-Phone',
			message: '  Join #phone-bank  ',
		});

		expect(res.status).toBe(200);
		expect(mockSaveInfoCommand).toHaveBeenCalledWith(
			expect.anything(),
			{ command: '/info-phone', message: 'Join #phone-bank' },
			{ id: 'U_ADMIN', name: 'Admin' },
		);
	});

	it('refuses to create a command that already exists', async () => {
		mockFindInfoCommand.mockResolvedValue({ command: '/info-phone', message: 'existing' });

		const res = await call({ action: 'save', command: '/info-phone', message: 'new' });

		expect(res.status).toBe(409);
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
	});

	it('allows editing an existing command in place', async () => {
		// previousCommand equal to the new name means "this is my own row" — the
		// existence check must not fire, or no command could ever be edited.
		mockFindInfoCommand.mockResolvedValue({ command: '/info-phone', message: 'old' });

		const res = await call({
			action: 'save',
			command: '/info-phone',
			previousCommand: '/info-phone',
			message: 'updated',
		});

		expect(res.status).toBe(200);
		expect(mockSaveInfoCommand).toHaveBeenCalled();
		expect(mockDeleteInfoCommand).not.toHaveBeenCalled();
	});

	it('renaming writes the new row and removes the old one', async () => {
		const res = await call({
			action: 'save',
			command: '/info-text',
			previousCommand: '/info-phone',
			message: 'Join #text-bank',
		});

		expect(res.status).toBe(200);
		expect(mockSaveInfoCommand).toHaveBeenCalledWith(
			expect.anything(),
			{ command: '/info-text', message: 'Join #text-bank' },
			expect.anything(),
		);
		expect(mockDeleteInfoCommand).toHaveBeenCalledWith(
			expect.anything(),
			'/info-phone',
			expect.anything(),
		);
	});

	it('refuses a rename onto a name that is already taken', async () => {
		mockFindInfoCommand.mockResolvedValue({ command: '/info-text', message: 'existing' });

		const res = await call({
			action: 'save',
			command: '/info-text',
			previousCommand: '/info-phone',
			message: 'new',
		});

		expect(res.status).toBe(409);
		expect(mockSaveInfoCommand).not.toHaveBeenCalled();
		// Critically, the old row survives a refused rename.
		expect(mockDeleteInfoCommand).not.toHaveBeenCalled();
	});
});

describe('delete', () => {
	it('deletes by normalized name', async () => {
		const res = await call({ action: 'delete', command: 'Info-Phone' });

		expect(res.status).toBe(200);
		expect(mockDeleteInfoCommand).toHaveBeenCalledWith(expect.anything(), '/info-phone', {
			id: 'U_ADMIN',
			name: 'Admin',
		});
	});

	it('deletes a row whose name would no longer validate', async () => {
		// The reserved list can grow; an existing row must stay removable.
		const res = await call({ action: 'delete', command: '/member-note' });

		expect(res.status).toBe(200);
		expect(mockDeleteInfoCommand).toHaveBeenCalled();
	});

	it('rejects an empty command', async () => {
		const res = await call({ action: 'delete', command: '   ' });
		expect(res.status).toBe(400);
		expect(mockDeleteInfoCommand).not.toHaveBeenCalled();
	});
});
