// Temporary: samples write-lock wait and app locks every 3s for 3 minutes. Delete after.
import { createClient } from '@libsql/client';
import { dbConfig } from '../bin/db-config.js';
const c = createClient(dbConfig);
const end = Date.now() + 3 * 60_000;
let last = '';
while (Date.now() < end) {
	const locks = (await c.execute('select * from sync_locks where expires_at > ?', [new Date().toISOString()])).rows
		.map((r) => String(r.name ?? r.key ?? Object.values(r)[0])).sort().join(', ');
	const q = (await c.execute(`select status, count(*) n from van_geometry_queue group by status`)).rows
		.map((r) => `${r.status}=${r.n}`).join(' ');
	const t = performance.now();
	await c.batch(['select 1'], 'write');
	const w = Math.round(performance.now() - t);
	const line = `locks[${locks}] ${q}`;
	console.log(new Date().toISOString().slice(11, 19), `wait ${String(w).padStart(6)}ms`, line === last ? '' : line);
	last = line;
	await new Promise((r) => setTimeout(r, 3000));
}
c.close();
