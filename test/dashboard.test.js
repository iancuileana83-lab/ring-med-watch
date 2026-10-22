process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.STORAGE_BACKEND = ''; // always in-memory in tests
process.env.RING_HMAC_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const { app, store } = require('../index');
const { STATUS_LABELS, FOOTER_LINES, missedPrompt, missedFallback } = require('../wording');

const auth = { Authorization: 'Basic ' + Buffer.from('caregiver:test-pass').toString('base64') };

test('dashboard and /api/today need the password and return the approved wording', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.strictEqual((await fetch(`${base}/`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/today`)).status, 401);

    const page = await fetch(`${base}/`, { headers: auth });
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Ring Med Watch/);

    await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ doses: ['08:00'], cameraId: 'cam-pills', timezone: 'Europe/Bucharest' })
    });
    const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    assert.strictEqual(today.doses.length, 1);
    assert.deepStrictEqual(today.statusLabels, STATUS_LABELS);
    assert.deepStrictEqual(today.footer, FOOTER_LINES);
    assert.deepStrictEqual(Object.keys(today).sort(), ['alerts', 'app', 'cameraId', 'date', 'demoCamera', 'doses', 'events', 'footer', 'statusLabels', 'summary', 'timezone']);
  } finally {
    server.close();
  }
});

test('CRON_TOKEN opens only /internal/check-doses', async () => {
  process.env.CRON_TOKEN = 'cron-secret-for-tests';
  await store.saveSettings({ doses: [] }); // nothing due, so no real alert is attempted
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await fetch(`${base}/internal/check-doses`, { method: 'POST', headers: { 'X-Cron-Token': 'wrong' } });
    assert.strictEqual(bad.status, 401);
    const good = await fetch(`${base}/internal/check-doses`, { method: 'POST', headers: { 'X-Cron-Token': 'cron-secret-for-tests' } });
    assert.strictEqual(good.status, 200);
    const other = await fetch(`${base}/api/today`, { headers: { 'X-Cron-Token': 'cron-secret-for-tests' } });
    assert.strictEqual(other.status, 401);
  } finally {
    server.close();
    delete process.env.CRON_TOKEN;
  }
});

test('approved wording is exact', () => {
  assert.strictEqual(STATUS_LABELS.likely_taken, 'Activity seen near the pills (not a confirmation)');
  assert.strictEqual(STATUS_LABELS.not_confirmed, 'No activity seen near the pills - not confirmed');
  assert.strictEqual(FOOTER_LINES.length, 3);
  assert.strictEqual(missedFallback('08:00', '07:45', '08:45'),
    'No activity was seen near the pills between 07:45 and 08:45, so the 08:00 dose was possibly missed. This is only a motion sensor and cannot tell whether medicine was taken. Please check in with the person. - Ring Med Watch');
  assert.match(missedPrompt('08:00', '07:45', '08:45'), /Never suggest taking the dose late, taking a double dose or changing any medicine, and never name a medicine; only suggest checking in with the person\./);
});

test('week, alerts, wording, simulate and clear-simulated endpoints', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { ...auth, 'Content-Type': 'application/json' };
  try {
    await store.saveSettings({ doses: [{ time: '08:00', label: 'Morning pills' }], cameraId: null, timezone: 'Europe/Bucharest' });

    const noCamera = await fetch(`${base}/api/simulate-motion`, { method: 'POST', headers: json, body: '{}' });
    assert.strictEqual(noCamera.status, 400);

    await store.saveSettings({ cameraId: 'cam-pills' });
    assert.strictEqual((await fetch(`${base}/api/simulate-motion`, { method: 'POST', headers: json, body: '{}' })).status, 200);

    const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    const sim = today.events.find((e) => e.simulated);
    assert.ok(sim && sim.deviceId === 'cam-pills' && sim.type === 'motion_detected');
    assert.strictEqual(today.summary.house.level, 'normal');
    assert.match(today.summary.last, /at the camera near the pills$/);

    const week = await (await fetch(`${base}/api/week`, { headers: auth })).json();
    assert.strictEqual(week.days.length, 7);
    assert.strictEqual(week.days[6].doses[0].label, 'Morning pills');

    const removed = await (await fetch(`${base}/api/simulated-events`, { method: 'DELETE', headers: auth })).json();
    assert.ok(removed.removed >= 1);
    const after = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    assert.ok(!after.events.some((e) => e.simulated));

    await store.recordAlert('2026-10-22T08:00', { sentAt: new Date().toISOString(), doseTime: '08:00', subject: 'S', message: 'M' });
    const alerts = await (await fetch(`${base}/api/alerts`, { headers: auth })).json();
    assert.strictEqual(alerts.alerts[0].message, 'M');

    const wording = await (await fetch(`${base}/api/wording`, { headers: auth })).json();
    assert.deepStrictEqual(wording.nav, ['Today', 'Week', 'Alerts', 'Settings', 'Privacy']);
    for (const p of ['week', 'alerts', 'wording']) assert.strictEqual((await fetch(`${base}/api/${p}`)).status, 401);
  } finally {
    server.close();
  }
});

test('house status wording', () => {
  const { houseStatus, dosesSummary, lastActivitySummary } = require('../wording');
  assert.deepStrictEqual(houseStatus(2.4, 12), { level: 'normal', text: 'Motion seen 2 hours ago' });
  assert.strictEqual(houseStatus(0.3, 12).text, 'Motion seen less than an hour ago');
  assert.deepStrictEqual(houseStatus(13.2, 12), { level: 'quiet', text: 'No motion for 13 hours - maybe check in' });
  assert.deepStrictEqual(houseStatus(null, 12), { level: 'no_data', text: 'No motion data yet' });
  assert.strictEqual(dosesSummary(2, 1, 0), '2 scheduled · 1 activity seen · 0 not confirmed');
  assert.strictEqual(lastActivitySummary(null, true), 'No activity yet today');
  assert.strictEqual(lastActivitySummary('08:12', true), '08:12 at the camera near the pills');
});

test('demo camera: simulation is labelled on the dashboard (alert emails are covered in phase4.test.js)', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { ...auth, 'Content-Type': 'application/json' };
  try {
    await store.saveSettings({ doses: [{ time: '00:00', label: '' }], cameraId: 'demo-camera', windowBeforeMinutes: 0, windowAfterMinutes: 1 });
    assert.strictEqual((await fetch(`${base}/api/wording`, { headers: auth }).then((r) => r.json())).demoCameraId, 'demo-camera');
    assert.strictEqual((await fetch(`${base}/api/simulate-motion`, { method: 'POST', headers: json, body: '{}' })).status, 200);
    const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    assert.strictEqual(today.demoCamera, true);
    assert.ok(today.summary.last.endsWith('at the demo camera (simulation)'), today.summary.last);
    assert.strictEqual((await (await fetch(`${base}/api/week`, { headers: auth })).json()).demoCamera, true);
  } finally {
    await store.deleteSimulatedEvents();
    server.close();
  }
});
