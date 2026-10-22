process.env.DASHBOARD_PASSWORD = 'test-pass';

const test = require('node:test');
const assert = require('node:assert');
const { app, store } = require('../index');
const { STATUS_LABELS, FOOTER_LINES, missedPrompt } = require('../wording');

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
    assert.deepStrictEqual(Object.keys(today).sort(), ['alerts', 'cameraId', 'date', 'doses', 'events', 'footer', 'statusLabels', 'timezone']);
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
  assert.match(missedPrompt('08:00', '07:45', '08:45'), /Never suggest taking the dose late, taking a double dose or changing any medicine, and never name a medicine; only suggest checking in with the person\./);
});
