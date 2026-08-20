import { describe, it, expect } from 'vitest';
import { formatFolderIds, parseFolderIds } from './van-folder-ids.js';

const ok = (raw: string) => {
	const r = parseFolderIds(raw);
	if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
	return r.folderIds;
};

describe('parseFolderIds', () => {
	it('parses a plain comma-separated list', () => {
		expect(ok('1152, 1200')).toEqual([1152, 1200]);
	});

	// Admins paste from VAN, spreadsheets and chat, so separators vary.
	it('accepts spaces, newlines and trailing commas', () => {
		expect(ok('1152 1200')).toEqual([1152, 1200]);
		expect(ok('1152,\n1200,')).toEqual([1152, 1200]);
		expect(ok('  1152 ,, 1200  ')).toEqual([1152, 1200]);
	});

	it('treats an empty box as "no turf for this chapter"', () => {
		expect(ok('')).toEqual([]);
		expect(ok('   ')).toEqual([]);
		expect(ok(',,')).toEqual([]);
	});

	it('collapses duplicates and sorts ascending', () => {
		expect(ok('1200, 1152, 1200')).toEqual([1152, 1200]);
	});

	// Number() would quietly turn these into NaN or the wrong number.
	it('rejects non-numeric tokens by name', () => {
		const r = parseFolderIds('1152, 1200px');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('1200px');
	});

	it('rejects hex, decimals, negatives and zero', () => {
		for (const raw of ['0x12', '11.5', '-3', '0']) {
			expect(parseFolderIds(raw).ok).toBe(false);
		}
	});

	it('rejects an id too large to be a safe integer', () => {
		expect(parseFolderIds('99999999999999999999').ok).toBe(false);
	});

	it('names the offending token, not just "invalid"', () => {
		const r = parseFolderIds('1152, oops, 1200');
		if (!r.ok) {
			expect(r.error).toContain('oops');
			expect(r.error).not.toMatch(/^invalid$/i);
		}
	});
});

describe('formatFolderIds', () => {
	it('round-trips through parse', () => {
		expect(ok(formatFolderIds([1200, 1152]))).toEqual([1152, 1200]);
	});

	it('renders an empty list as an empty box', () => {
		expect(formatFolderIds([])).toBe('');
	});
});
