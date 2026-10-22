process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.STORAGE_BACKEND = '';
process.env.RING_HMAC_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const { checkDoses, isTestAlert } = require('../doses');
const { createMemoryStore } = require('../store');
const { createDynamoStore } = require('../store-dynamodb');
const { fakeDynamo } = require('./helpers/fake-dynamo');
const { app, store: appStore } = require('../index');

const SETTINGS = { doses: [{ time: '10:20', label: '' }], windowBeforeMinutes: 15, windowAfterMinutes: 45, cameraId: 'cam', timezone: 'Europe/Bucharest' };
const NOW = Date.parse('2026-10-22T08:35:00Z'); // 11:35 Bucharest: the 10:20 window (ends 11:05) is over
const auth = { Authorization: 'Basic ' + Buffer.from('x:test-pass').toString('base64') };

const dynamo = (client) => createDynamoStore({ tableName: 'test-table', client, defaultTimezone: 'Europe/Bucharest' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('at most one alert per dose window, even after a restart or redeploy (state lives in DynamoDB)', async () => {
  const client = fakeDynamo(); // the table outlives every app instance
  const sent = [];
  const notify = async (dose) => { sent.push(dose.key); return { subject: 'S', message: 'M' }; };

  const first = dynamo(client);
  await first.saveSettings(SETTINGS);
  assert.deepStrictEqual((await checkDoses({ store: first, notify, nowMs: NOW })).alerted, ['2026-10-22T10:20']);

  // "restart" or "redeploy": a brand-new store object over the same table, at several later times
  for (const later of [NOW + 5 * 60000, NOW + 70 * 60000, NOW + 3 * 3600000]) {
    const fresh = dynamo(client);
    assert.deepStrictEqual((await checkDoses({ store: fresh, notify, nowMs: later })).alerted, []);
  }
  assert.strictEqual(sent.length, 1);

  // the stored alert has its email text, and no leftover reservation
  const [a] = await dynamo(client).listAlerts('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
  assert.strictEqual(a.message, 'M');
  assert.strictEqual(a.subject, 'S');
});

for (const [name, make] of [['memory store', () => createMemoryStore()], ['DynamoDB store', () => dynamo(fakeDynamo())]]) {
  test(`overlapping checks cannot both send (${name})`, async () => {
    const store = make();
    await store.saveSettings(SETTINGS);
    let sent = 0;
    const slowNotify = async () => { await sleep(30); sent++; return { subject: 'S', message: 'M' }; };
    const results = await Promise.all([
      checkDoses({ store, notify: slowNotify, nowMs: NOW }),
      checkDoses({ store, notify: slowNotify, nowMs: NOW }),
      checkDoses({ store, notify: slowNotify, nowMs: NOW + 1000 })
    ]);
    assert.strictEqual(sent, 1, 'only one email for the dose window');
    assert.strictEqual(results.flatMap((r) => r.alerted).length, 1);
  });

  test(`a failed send releases the reservation so the next check retries (${name})`, async () => {
    const store = make();
    await store.saveSettings(SETTINGS);
    await assert.rejects(checkDoses({ store, notify: async () => { throw new Error('ses down'); }, nowMs: NOW }), /ses down/);
    assert.deepStrictEqual(await store.listAlerts('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z'), []);
    let sent = 0;
    const r = await checkDoses({ store, notify: async () => { sent++; return {}; }, nowMs: NOW + 60000 });
    assert.deepStrictEqual(r.alerted, ['2026-10-22T10:20']);
    assert.strictEqual(sent, 1);
  });
}

test('test emails are recognised by their key and do not count as alerts sent', async () => {
  assert.strictEqual(isTestAlert({ key: '2026-10-22T10:20#test-1792662522497' }), true);
  assert.strictEqual(isTestAlert({ key: '2026-10-22T10:20' }), false);

  await appStore.saveSettings({ ...SETTINGS, doses: [{ time: '00:00', label: '' }], timezone: 'UTC' });
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  await appStore.recordAlert(`${day}T00:00`, { sentAt: now, doseTime: '00:00', checkinHash: 'h-real' });
  await appStore.recordAlert(`${day}T00:00#test-1`, { sentAt: now, doseTime: '00:00', checkinHash: 'h-test' });

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    assert.strictEqual(today.summary.alerts, '1 today · 0 checked in', 'the test email is not counted');
    assert.strictEqual(today.alerts.length, 2, 'but it still appears in the timeline data');
    assert.strictEqual(typeof today.app, 'string');
    assert.strictEqual((await (await fetch(`${base}/api/wording`, { headers: auth })).json()).app, today.app, 'both report the same version');
  } finally {
    server.close();
  }
});
