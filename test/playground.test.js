process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.STORAGE_BACKEND = '';
process.env.RING_REFRESH_TOKEN = ''; // no account linking: the camera list must still work
process.env.RING_HMAC_KEY = 'playground-test-key';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { app, store } = require('../index');
const { parseWebhook } = require('../ring');
const { seenDeviceName, UI } = require('../wording');

const auth = { Authorization: 'Basic ' + Buffer.from('x:test-pass').toString('base64') };
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', process.env.RING_HMAC_KEY).update(body).digest('hex');
const withServer = async (fn) => {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
};

const playgroundEvent = (id, device) => JSON.stringify({
  meta: { version: '1.1', time: new Date().toISOString(), request_id: `req-${id}`, account_id: 'acc' },
  data: { id, type: 'motion_detected', attributes: { source: device, source_type: 'device', sub_type: 'human', timestamp: Date.now() } }
});

test('parseWebhook finds the device in attributes.source or in relationships', () => {
  const base = { data: { id: 'e', type: 'motion_detected', attributes: { timestamp: 1 } } };
  assert.strictEqual(parseWebhook({ data: { ...base.data, attributes: { source: 'cam-1', timestamp: 1 } } }).deviceId, 'cam-1');
  assert.strictEqual(parseWebhook({ data: { ...base.data, relationships: { devices: { data: [{ id: 'cam-2', type: 'devices' }] } } } }).deviceId, 'cam-2');
  assert.strictEqual(parseWebhook({ data: { ...base.data, relationships: { devices: { links: { related: '/v1/devices/cam-3' } } } } }).deviceId, 'cam-3');
  assert.strictEqual(parseWebhook(base).deviceId, null);
});

test('signed Playground events are accepted and shown as real (not simulated) events; unsigned ones are not', async () => {
  await withServer(async (base) => {
    const body = playgroundEvent('pg-1', 'playground-cam-abcdef');
    const post = (b, headers) => fetch(`${base}/webhooks/ring`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: b });

    assert.strictEqual((await post(body, {})).status, 401);
    assert.strictEqual((await post(body, { 'X-Signature': 'sha256=00' })).status, 401);
    assert.strictEqual((await post(body, { 'X-Signature': sign(body) + 'x' })).status, 401);
    assert.strictEqual((await post(body.replace('human', 'pet'), { 'X-Signature': sign(body) })).status, 401); // body tampered after signing
    assert.strictEqual((await post(body, { 'X-Signature': sign(body) })).status, 200);
    assert.strictEqual((await post(body, { 'X-Signature': sign(body) })).status, 200); // retry: stored once

    const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    const real = today.events.filter((e) => e.deviceId === 'playground-cam-abcdef');
    assert.strictEqual(real.length, 1);
    assert.strictEqual(real[0].simulated, undefined);
    assert.strictEqual(real[0].type, 'motion_detected');
  });
});

test('camera list works without a Ring refresh token and offers devices seen in Ring events', async () => {
  await store.addEvent({ id: 'sim-x', time: new Date().toISOString(), type: 'motion_detected', deviceId: 'demo-camera', simulated: true });
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/devices`, { headers: auth });
    assert.strictEqual(r.status, 200); // not the old 502
    const body = await r.json();
    assert.strictEqual(body.ringApi, 'not_linked');
    assert.deepStrictEqual(body.devices, [{ id: 'playground-cam-abcdef', name: seenDeviceName('playground-cam-abcdef'), source: 'ring-events' }]);
    assert.strictEqual(body.devices[0].name, 'Ring Playground device (abcdef)');
    assert.ok(!body.devices.some((d) => d.id === 'demo-camera'), 'simulated devices are not listed as Ring devices');
  });
});

test('approved-pending wording for Playground events is in place', () => {
  assert.strictEqual(UI.ringEventBadge, 'Ring Playground event');
  assert.strictEqual(UI.cameraHintNotLinked, 'The Ring camera list is not linked. Devices seen in Ring Playground events are listed instead.');
  assert.strictEqual(UI.cameraHintNoneSeen, 'No Ring Playground device seen yet. Send a test motion event from the Playground, then reload this page.');
});
