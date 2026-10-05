export function createWriter(db) {
  const insert = db.prepare('INSERT INTO samples (ts, metric, value) VALUES (?, ?, ?)');
  const purge = db.prepare('DELETE FROM samples WHERE ts < ?');
  const insertAlert = db.prepare('INSERT INTO alerts (ts, alertname, state, value) VALUES (?, ?, ?, ?)');
  const purgeAlerts = db.prepare('DELETE FROM alerts WHERE ts < ?');

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
    insertAlerts(rows) {
      const tx = db.transaction((batch) => {
        for (const row of batch) insertAlert.run(row.ts, row.alertname, row.state, row.value ?? null);
      });
      tx(rows);
    },
    purgeAlertsOlderThan(cutoffTs) {
      const info = purgeAlerts.run(cutoffTs);
      if (info.changes > 0) db.pragma('incremental_vacuum');
      return info.changes;
    },
  };
}
