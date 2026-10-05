export function createWriter(db) {
  const insert = db.prepare('INSERT INTO samples (ts, metric, value) VALUES (?, ?, ?)');
  const purge = db.prepare('DELETE FROM samples WHERE ts < ?');

  return {
    insertBatch(rows) {
      const tx = db.transaction((batch) => {
        for (const row of batch) insert.run(row.ts, row.metric, row.value);
      });
      tx(rows);
    },
    purgeOlderThan(cutoffTs) {
      const info = purge.run(cutoffTs);
      if (info.changes > 0) db.pragma('incremental_vacuum');
      return info.changes;
    },
  };
}
