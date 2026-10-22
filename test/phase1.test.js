process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.RING_HMAC_KEY = ''; // .env may hold a real key; empty means "do not verify"
process.env.STORAGE_BACKEND = ''; // always in-memory in tests

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { parseWebhook, verifySignature } = require('../ring');
const { createMemoryStore } = require('../store');
const { app, store } = require('../index');

const v11 = {
  meta: { version: '1.1', time: '2026-10-22T08:00:05Z', request_id: 'req-1', account_id: 'acc' },
  data: { id: 'evt-1', type: 'motion_detected', attributes: { source: 'cam-1', timestamp: Date.parse('2026-10-22T08:00:00Z') } }
};

test('parseWebhook reads the v1.1 payload', () => {
  assert.deepStrictEqual(parseWebhook(v11), {
    id: 'evt-1', time: '2026-10-22T08:00:00.000Z', type: 'motion_detected', deviceId: 'cam-1'
  });
});

test('parseWebhook accepts the flat legacy shape and rejects empty payloads', () => {
  assert.strictEqual(parseWebhook({ type: 'motion_detected' }).type, 'motion_detected');
  assert.strictEqual(parseWebhook({}), null);
});

test('store ignores duplicate event ids and filters by time', async () => {
  const s = createMemoryStore();
  assert.strictEqual(await s.addEvent({ id: 'a', time: '2026-10-22T08:00:00.000Z', type: 'motion_detected', deviceId: 'c' }), true);
  assert.strictEqual(await s.addEvent({ id: 'a', time: '2026-10-22T08:00:00.000Z', type: 'motion_detected', deviceId: 'c' }), false);
  assert.strictEqual((await s.listEvents('2026-10-22T00:00:00Z', '2026-10-23T00:00:00Z')).length, 1);
  assert.strictEqual((await s.listEvents('2026-10-23T00:00:00Z', '2026-10-24T00:00:00Z')).length, 0);
});

test('verifySignature accepts a correct sha256= HMAC and rejects others', () => {
  const body = Buffer.from('{"a":1}');
  const good = 'sha256=' + crypto.createHmac('sha256', 'k').update(body).digest('hex');
  assert.strictEqual(verifySignature(body, good, 'k'), true);
  assert.strictEqual(verifySignature(body, good, 'other'), false);
  assert.strictEqual(verifySignature(body, undefined, 'k'), false);
});

test('webhook stores the event, and /api/events requires the password', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = await fetch(`${base}/webhooks/ring`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v11)
    });
    assert.strictEqual(post.status, 200);

    const stored = await store.listEvents('2026-10-22T00:00:00Z', '2026-10-23T00:00:00Z');
    assert.strictEqual(stored.length, 1);
    assert.deepStrictEqual(Object.keys(stored[0]).sort(), ['deviceId', 'id', 'time', 'type']);

    const denied = await fetch(`${base}/api/events`);
    assert.strictEqual(denied.status, 401);

    const auth = 'Basic ' + Buffer.from('caregiver:test-pass').toString('base64');
    const ok = await fetch(`${base}/api/events?from=2026-10-22T00:00:00Z&to=2026-10-23T00:00:00Z`, { headers: { Authorization: auth } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).events.length, 1);
  } finally {
    server.close();
  }
});
