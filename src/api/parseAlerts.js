function extractValue(alert) {
  if (alert.values && typeof alert.values === 'object') {
    for (const v of Object.values(alert.values)) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  if (typeof alert.value === 'number' && Number.isFinite(alert.value)) return alert.value;
  return null;
}

export function parseAlerts(body, nowMs = Date.now()) {
  if (!body || !Array.isArray(body.alerts) || body.alerts.length === 0) return null;
  const nowSec = Math.floor(nowMs / 1000);
  const rows = [];
  for (const alert of body.alerts) {
    if (!alert || typeof alert !== 'object') continue;
    const alertname =
      alert.labels?.alertname ?? body?.commonLabels?.alertname ?? 'Alerta sem nome';
    const state = alert.status === 'resolved' ? 'resolved' : 'firing';
    const parsed = Date.parse(alert.startsAt);
    const ts = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : nowSec;
    rows.push({ ts, alertname: String(alertname), state, value: extractValue(alert) });
  }
  return rows.length > 0 ? rows : null;
}
