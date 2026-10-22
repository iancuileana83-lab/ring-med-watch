process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.STORAGE_BACKEND = '';
process.env.RING_REFRESH_TOKEN = '';
process.env.RING_HMAC_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const { app, store } = require('../index');
const { setPlaygroundToken } = require('../ring');
const { PRIVACY_LINES, UI } = require('../wording');

const SECRET = 'LIVE-VIEW-TOKEN-0123456789-abcdefghijklmnop';
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=recvonly\r\n';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 10.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=sendonly\r\n';
const DEVICE = 'ava1.ring.device.LIVETEST';
const auth = { Authorization: 'Basic ' + Buffer.from('x:test-pass').toString('base64') };
const json = { ...auth, 'Content-Type': 'application/json' };

// Fake Ring: records calls to api.amazonvision.com, passes everything else through.
const realFetch = globalThis.fetch;
const ringCalls = [];
let ringHandler = () => ({ status: 500 });
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('amazonvision.com')) {
    ringCalls.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    const r = ringHandler(String(url), options);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.text || '', json: async () => r.json || {}, headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null } };
  }
  return realFetch(url, options);
};
const withServer = async (fn) => {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
};
async function captureConsole(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join('\n');
}
const start = (base, body = { sdp: OFFER }, headers = json) => fetch(`${base}/api/ring/live/start`, { method: 'POST', headers, body: JSON.stringify(body) });

test('live view needs the password, a connected token, and a real Ring camera', async () => {
  await withServer(async (base) => {
    assert.strictEqual((await start(base, { sdp: OFFER }, { 'Content-Type': 'application/json' })).status, 401);

    await store.saveSettings({ cameraId: DEVICE });
    const noToken = await start(base);
    assert.strictEqual(noToken.status, 400);
    assert.ok((await noToken.text()).includes('Connect a Ring Playground token first'));

    setPlaygroundToken(SECRET);
    await store.saveSettings({ cameraId: null });
    assert.ok((await (await start(base)).text()).includes('Choose a Ring camera in Settings first'));
    await store.saveSettings({ cameraId: 'demo-camera' });
    assert.strictEqual((await start(base)).status, 400);

    await store.saveSettings({ cameraId: DEVICE });
    assert.strictEqual((await start(base, { sdp: 'not sdp' })).status, 400);
    assert.strictEqual((await start(base, { sdp: 'v=0' + 'x'.repeat(61000) })).status, 400);
    assert.strictEqual(ringCalls.length, 0, 'nothing reached Ring for invalid requests');
  });
});

test('start relays the SDP to the Ring WHEP endpoint with the documented request, and returns only the answer', async () => {
  setPlaygroundToken(SECRET);
  await store.saveSettings({ cameraId: DEVICE });
  ringCalls.length = 0;
  ringHandler = () => ({ status: 201, text: ANSWER, headers: { location: `https://api.amazonvision.com/v1/devices/${DEVICE}/media/streaming/whep/sessions/sess-1` } });
  await withServer(async (base) => {
    const logs = await captureConsole(async () => {
      const r = await start(base);
      assert.strictEqual(r.status, 200);
      const body = await r.json();
      assert.strictEqual(body.sdp, ANSWER);
      assert.match(body.session, /^[0-9a-f]{32}$/);
      assert.ok(!JSON.stringify(body).includes('sess-1'), 'the Ring session URL is not exposed to the browser');
      assert.ok(!JSON.stringify(body).includes(SECRET));
    });
    assert.ok(!logs.includes(SECRET) && !logs.includes('o=- 1 2 IN'), 'neither token nor SDP is logged');
  });
  const call = ringCalls[0];
  assert.strictEqual(call.method, 'POST');
  assert.strictEqual(call.url, `https://api.amazonvision.com/v1/devices/${encodeURIComponent(DEVICE)}/media/streaming/whep/sessions`);
  assert.strictEqual(call.headers['Content-Type'], 'application/sdp');
  assert.strictEqual(call.headers.Authorization, `Bearer ${SECRET}`);
  assert.ok(call.headers['User-Agent'] && call.headers.Hardware_Id);
  assert.strictEqual(call.body, OFFER, 'raw SDP offer, unchanged');
});

test('stop sends DELETE to the Ring session URL once; unknown sessions do nothing', async () => {
  setPlaygroundToken(SECRET);
  await store.saveSettings({ cameraId: DEVICE });
  ringHandler = (url, o) => (o.method === 'DELETE' ? { status: 204 } : { status: 201, text: ANSWER, headers: { location: `/v1/devices/${DEVICE}/media/streaming/whep/sessions/sess-2` } });
  await withServer(async (base) => {
    const { session } = await (await start(base)).json();
    ringCalls.length = 0;
    const stop = () => fetch(`${base}/api/ring/live/stop`, { method: 'POST', headers: json, body: JSON.stringify({ session }) }).then((r) => r.json());
    assert.deepStrictEqual(await stop(), { stopped: true });
    assert.deepStrictEqual(await stop(), { stopped: false });
    const del = ringCalls.filter((c) => c.method === 'DELETE');
    assert.strictEqual(del.length, 1);
    assert.strictEqual(del[0].url, `https://api.amazonvision.com/v1/devices/${DEVICE}/media/streaming/whep/sessions/sess-2`);
    assert.strictEqual(del[0].headers.Authorization, `Bearer ${SECRET}`);

    ringCalls.length = 0;
    const bogus = await (await fetch(`${base}/api/ring/live/stop`, { method: 'POST', headers: json, body: JSON.stringify({ session: 'https://evil.example/x' }) })).json();
    assert.deepStrictEqual(bogus, { stopped: false });
    assert.strictEqual(ringCalls.length, 0, 'a client can never make the server call an address of its choosing');
  });
});

test('a session URL on another host is refused, and Ring errors become clear messages', async () => {
  setPlaygroundToken(SECRET);
  await store.saveSettings({ cameraId: DEVICE });
  await withServer(async (base) => {
    ringHandler = () => ({ status: 201, text: ANSWER, headers: { location: 'https://evil.example/whep/sessions/x' } });
    assert.strictEqual((await start(base)).status, 502);

    for (const [ringStatus, httpStatus, message] of [[503, 503, 'The camera is offline'], [404, 404, 'The camera was not found'], [401, 401, 'Ring rejected the token'], [500, 502, 'Live view could not start: HTTP 500']]) {
      ringHandler = () => ({ status: ringStatus });
      const r = await start(base);
      assert.strictEqual(r.status, httpStatus, String(ringStatus));
      const text = await r.text();
      assert.ok(text.includes(message) && !text.includes(SECRET));
    }
  });
});

test('live view wording and the corrected privacy statement', () => {
  assert.strictEqual(UI.live.button, 'Look in now');
  assert.strictEqual(UI.live.note, 'Live view goes straight from Ring to your browser. Nothing is recorded or stored.');
  assert.ok(PRIVACY_LINES[0].includes('never records or downloads camera footage'));
  assert.ok(PRIVACY_LINES[0].includes('never recorded or stored'));
  assert.ok(!PRIVACY_LINES.join(' ').includes('never requests'), 'the old claim that no footage is ever requested is gone');
});
