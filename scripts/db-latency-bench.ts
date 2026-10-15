// Temporary: replays a turf's write batch with identical data and times it. Delete after.
import { createClient, type InStatement } from '@libsql/client';
import { dbConfig } from '../bin/db-config.js';
const c = createClient(dbConfig);
await c.execute('select 1');
const turfs = (
	await c.execute(
		`select r.turf_id, count(*) n from van_turf_roster r join van_geometry_queue q on q.turf_id = r.turf_id and q.status = 'done' where r.turf_id % 89 = 7 group by r.turf_id having n between 120 and 200 limit 6`,
	)
).rows;
for (const { turf_id: id, n } of turfs) {
	const roster = (
		await c.execute({ sql: 'select person_hash, door_hash from van_turf_roster where turf_id = ?', args: [id] })
	).rows;
	const placeholders = roster.map(() => '(?, ?, ?)').join(', ');
	const insert = {
		sql: `insert into van_turf_roster (turf_id, person_hash, door_hash) values ${placeholders} on conflict do nothing`,
		args: roster.flatMap((r) => [id, r.person_hash, r.door_hash]),
	};
	const parts: Record<string, InStatement[]> = {
		'turf updates only': [
			{ sql: 'update van_turfs set hull_json = hull_json, centroid_lat = centroid_lat where turf_id = ?', args: [id] },
			{ sql: 'update van_turfs set roster_saved_list_id = roster_saved_list_id where turf_id = ?', args: [id] },
			{ sql: 'update van_geometry_queue set status = status where turf_id = ?', args: [id] },
		],
		'full batch': [
			{ sql: 'update van_turfs set hull_json = hull_json, centroid_lat = centroid_lat where turf_id = ?', args: [id] },
			{ sql: 'delete from van_turf_roster where turf_id = ?', args: [id] },
			insert,
			{ sql: 'update van_turfs set roster_saved_list_id = roster_saved_list_id where turf_id = ?', args: [id] },
			{ sql: 'update van_geometry_queue set status = status where turf_id = ?', args: [id] },
		],
	};
	const out: string[] = [];
	for (const [label, stmts] of Object.entries(parts)) {
		const t = performance.now();
		await c.batch(stmts, 'write');
		out.push(`${label} ${Math.round(performance.now() - t)}ms`);
	}
	const check = (await c.execute({ sql: 'select count(*) n from van_turf_roster where turf_id = ?', args: [id] }))
		.rows[0]!.n;
	console.log(`turf ${id} (${n} rows, now ${check}): ${out.join(' · ')}`);
}
c.close();
