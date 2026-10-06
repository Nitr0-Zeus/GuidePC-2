const EXPORT_SQL =
  'SELECT ts, metric, value FROM samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC';

export function createQueries(db) {
  const latestStmt = db.prepare(
    'SELECT metric, value, MAX(ts) AS ts FROM samples WHERE ts >= ? GROUP BY metric'
  );
  const rangeStmt = db.prepare(
    'SELECT ts, value FROM samples WHERE metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC'
  );
  const maxTsStmt = db.prepare('SELECT MAX(ts) AS t FROM samples');
  const countStmt = db.prepare(
    'SELECT COUNT(DISTINCT metric) AS c FROM samples WHERE ts >= ?'
  );
  const listAlertsStmt = db.prepare(
    'SELECT ts, alertname, state, value FROM alerts ORDER BY ts DESC, id DESC LIMIT ?'
  );

  return {
    latest(nowSec, windowSec = 120) {
      const rows = latestStmt.all(nowSec - windowSec);
      const values = {};
      let ts = null;
      for (const row of rows) {
        values[row.metric] = row.value;
        if (ts === null || row.ts > ts) ts = row.ts;
      }
      return { ts, values };
    },
    range(metric, fromSec, toSec) {
      return { metric, points: rangeStmt.all(metric, fromSec, toSec) };
    },
    maxTs() {
      return maxTsStmt.get().t ?? null;
    },
    countRecent(windowSec, nowSec = Math.floor(Date.now() / 1000)) {
      return countStmt.get(nowSec - windowSec).c;
    },
    listAlerts(limit = 20) {
      return listAlertsStmt.all(limit);
    },
    iterateRange(fromSec, toSec) {
      return db.prepare(EXPORT_SQL).iterate(fromSec, toSec);
    },
  };
}
