process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.STORAGE_BACKEND = '';
process.env.RING_REFRESH_TOKEN = ''; // only the pasted Playground token is used
process.env.RING_HMAC_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const { app, store } = require('../index');
const { setPlaygroundToken, playgroundStatus, fetchHistoryEvents } = require('../ring');
const { UI } = require('../wording');

const SECRET = 'PLAYGROUND-TOKEN-0123456789-abcdefghijklmnop';
const auth = { Authorization: 'Basic ' + Buffer.from('x:test-pass').toString('base64') };
const json = { ...auth, 'Content-Type': 'application/json' };

// Fake Ring API: routes api.amazonvision.com calls to handlers, passes local calls through.
const realFetch = globalThis.fetch;
const ringCalls = [];
let ringHandler = () => ({ status: 500, body: {} });
globalThis.fetch = async (url, options) => {
  if (String(url).includes('amazonvision.com')) {
    ringCalls.push({ url: String(url), headers: options?.headers || {} });
    const r = ringHandler(String(url));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }
  return realFetch(url, options);
};

const withServer = async (fn) => {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
};
// Collect everything written to the console while `fn` runs.
async function captureConsole(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join('\n');
}

const DEVICE = 'ava1.ring.device.TESTPLAYGROUND';
const historyEvent = (id, type, startIso) => ({ type: 'history-events', id, attributes: { event_type: type, is_third_party_reviewed: false, start: Date.parse(startIso), end: Date.parse(startIso) + 5000 }, relationships: { source: { data: { type: 'devices', id: DEVICE } } } });

test('token is validated, expires after 30 minutes, and status never contains it', () => {
  assert.throws(() => setPlaygroundToken('short'));
  assert.throws(() => setPlaygroundToken('has spaces in it so it is not a token at all'));
  const t0 = Date.parse('2026-10-22T10:00:00Z');
  setPlaygroundToken(SECRET, t0);
  assert.deepStrictEqual(playgroundStatus(t0 + 60000), { state: 'connected', until: '2026-10-22T10:30:00.000Z' });
  assert.strictEqual(playgroundStatus(t0 + 30 * 60000).state, 'expired');
  assert.ok(!JSON.stringify(playgroundStatus(t0)).includes(SECRET));
});

test('PUT /api/ring/token needs the password, rejects junk, and never echoes or logs the token', async () => {
  await withServer(async (base) => {
    assert.strictEqual((await fetch(`${base}/api/ring/token`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: SECRET }) })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/ring/token`, { method: 'PUT', headers: json, body: JSON.stringify({ token: 'x' }) })).status, 400);

    const logs = await captureConsole(async () => {
      const r = await fetch(`${base}/api/ring/token`, { method: 'PUT', headers: json, body: JSON.stringify({ token: SECRET }) });
      assert.strictEqual(r.status, 200);
      const body = await r.json();
      assert.strictEqual(body.state, 'connected');
      assert.ok(!JSON.stringify(body).includes(SECRET));
      const status = await (await fetch(`${base}/api/ring/status`, { headers: auth })).text();
      assert.ok(!status.includes(SECRET));
      for (const p of ['settings', 'today', 'week', 'alerts', 'wording', 'devices']) {
        ringHandler = () => ({ status: 200, body: { data: [] } });
        assert.ok(!(await (await fetch(`${base}/api/${p}`, { headers: auth })).text()).includes(SECRET), p);
      }
    });
    assert.ok(!logs.includes(SECRET), 'token must not appear in logs');
  });
});

test('camera list uses the real Device List call with the required headers', async () => {
  setPlaygroundToken(SECRET);
  ringCalls.length = 0;
  ringHandler = () => ({ status: 200, body: { data: [{ type: 'devices', id: DEVICE, attributes: { name: 'Playground Camera' }, relationships: {} }] } });
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/devices`, { headers: auth })).json();
    assert.strictEqual(r.ringApi, 'ok');
    assert.deepStrictEqual(r.devices, [{ id: DEVICE, name: 'Playground Camera', source: 'ring-api' }]);
  });
  const call = ringCalls[0];
  assert.strictEqual(call.url, 'https://api.amazonvision.com/v1/devices');
  assert.strictEqual(call.headers.Authorization, `Bearer ${SECRET}`);
  assert.match(call.headers['User-Agent'], /^[\w-]+\/[\d.]+$/);
  assert.match(call.headers.Hardware_Id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
});

test('fetch-events: needs a token and a Ring camera, then adds motion events once (dedup by id)', async () => {
  await store.saveSettings({ doses: [{ time: '12:00', label: '' }], cameraId: null, windowBeforeMinutes: 60, windowAfterMinutes: 60, timezone: 'UTC' });
  const motionTime = new Date(Date.now() - 5 * 60000).toISOString();
  ringHandler = (url) => {
    if (url.endsWith('/events')) {
      return { status: 200, body: { data: [historyEvent('h1', 'motion.human', motionTime), historyEvent('h2', 'doorbell.press', motionTime)], links: { next: `/v1/history/devices/${DEVICE}/events?page%5Bkey%5D=abc` } } };
    }
    return { status: 200, body: { data: [historyEvent('h3', 'motion', new Date(Date.now() - 3600000).toISOString())] } };
  };
  await withServer(async (base) => {
    const post = () => fetch(`${base}/api/ring/fetch-events`, { method: 'POST', headers: auth });
    assert.strictEqual((await post()).status, 400); // no camera chosen
    await store.saveSettings({ cameraId: 'demo-camera' });
    assert.strictEqual((await post()).status, 400); // demo camera is not a Ring camera
    await store.saveSettings({ cameraId: DEVICE });

    const first = await (await post()).json();
    // h1 and h3 are motion, h2 is another Ring event type; two pages followed
    assert.deepStrictEqual(first, { fetched: 3, added: 3, motion: 2, liveView: 0, other: 1, message: '3 new Ring events added (2 motion, 1 not counted as motion).' });
    const second = await (await post()).json();
    assert.deepStrictEqual(second, { fetched: 3, added: 0, motion: 0, liveView: 0, other: 0, message: 'No new events.' });

    const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    const ring = today.events.filter((e) => e.deviceId === DEVICE);
    assert.ok(ring.length >= 1);
    assert.ok(ring.every((e) => e.simulated === undefined)); // real Ring events, not simulation
    assert.deepStrictEqual(ring.map((e) => e.type).sort(), ['doorbell.press', 'motion_detected', 'motion_detected']);
    assert.strictEqual(UI.ringEventBadge, 'Ring Playground event');
  });
  assert.ok(ringCalls.some((c) => c.url === `https://api.amazonvision.com/v1/history/devices/${encodeURIComponent(DEVICE)}/events`));
  assert.ok(ringCalls.some((c) => c.url.endsWith('page%5Bkey%5D=abc')), 'follows links.next');
});

test('fetched events count as activity in the dose check', async () => {
  const start = new Date(); start.setUTCMinutes(0, 0, 0);
  const doseTime = `${String(start.getUTCHours()).padStart(2, '0')}:00`;
  await store.saveSettings({ doses: [{ time: doseTime, label: '' }], cameraId: DEVICE, windowBeforeMinutes: 60, windowAfterMinutes: 60, timezone: 'UTC' });
  await store.addEvent({ id: 'dose-h', time: new Date().toISOString(), type: 'motion_detected', deviceId: DEVICE });
  await withServer(async (base) => {
    const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    assert.strictEqual(today.doses[0].status, 'likely_taken');
  });
});

test('Ring errors: rejected token, blocked request; messages never contain the token', async () => {
  setPlaygroundToken(SECRET);
  await store.saveSettings({ cameraId: DEVICE });
  await withServer(async (base) => {
    ringHandler = () => ({ status: 401, body: { error: SECRET } });
    const r401 = await fetch(`${base}/api/ring/fetch-events`, { method: 'POST', headers: auth });
    assert.strictEqual(r401.status, 401);
    const t401 = await r401.text();
    assert.ok(t401.includes('Ring rejected the token') && !t401.includes(SECRET));

    ringHandler = () => ({ status: 406, body: {} });
    const r406 = await fetch(`${base}/api/ring/fetch-events`, { method: 'POST', headers: auth });
    assert.strictEqual(r406.status, 502);
    assert.ok((await r406.text()).includes('HTTP 406'));
  });
});

test('after 30 minutes the token expires: status says expired and the camera list falls back', async () => {
  setPlaygroundToken(SECRET);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31 * 60000;
    ringHandler = () => ({ status: 200, body: { data: [] } });
    await withServer(async (base) => {
      assert.strictEqual((await (await fetch(`${base}/api/ring/status`, { headers: auth })).json()).state, 'expired');
      assert.strictEqual((await (await fetch(`${base}/api/devices`, { headers: auth })).json()).ringApi, 'token_expired');
      const fetchRes = await fetch(`${base}/api/ring/fetch-events`, { method: 'POST', headers: auth });
      assert.strictEqual(fetchRes.status, 400);
      assert.ok((await fetchRes.text()).includes('Connect a Ring Playground token first'));
    });
  } finally { Date.now = realNow; }
});

test('fetchHistoryEvents ignores malformed items and stops after maxPages', async () => {
  setPlaygroundToken(SECRET);
  let pages = 0;
  ringHandler = () => { pages++; return { status: 200, body: { data: [{ id: 'bad' }, historyEvent(`ok${pages}`, 'motion', '2026-10-22T10:00:00Z')], links: { next: '/v1/more' } } }; };
  const events = await fetchHistoryEvents(DEVICE, { maxPages: 2 });
  assert.strictEqual(pages, 2);
  assert.deepStrictEqual(events.map((e) => e.id), ['ok1', 'ok2']);
});

test('camera list tells apart a rejected token and a failed request', async () => {
  setPlaygroundToken(SECRET);
  await withServer(async (base) => {
    ringHandler = () => ({ status: 401, body: {} });
    assert.strictEqual((await (await fetch(`${base}/api/devices`, { headers: auth })).json()).ringApi, 'token_rejected');
    ringHandler = () => ({ status: 406, body: {} });
    assert.strictEqual((await (await fetch(`${base}/api/devices`, { headers: auth })).json()).ringApi, 'error');
  });
});

test('Playground on_demand (live view) events are shown with their own label but never count as motion', async () => {
  const startOfHour = new Date(); startOfHour.setUTCMinutes(0, 0, 0);
  const doseTime = `${String(startOfHour.getUTCHours()).padStart(2, '0')}:00`;
  const t = new Date(Date.now() - 60000).toISOString();
  const LIVE_VIEW_DEVICE = 'ava1.ring.device.LIVEVIEWONLY'; // a camera with no motion events at all
  await store.saveSettings({ doses: [{ time: doseTime, label: '' }], cameraId: LIVE_VIEW_DEVICE, windowBeforeMinutes: 60, windowAfterMinutes: 60, timezone: 'UTC' });
  setPlaygroundToken(SECRET);
  ringHandler = () => ({ status: 200, body: { data: [historyEvent('ondemand-1', 'on_demand', t)] } });
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/ring/fetch-events`, { method: 'POST', headers: auth })).json();
    assert.deepStrictEqual(r, { fetched: 1, added: 1, motion: 0, liveView: 1, other: 0, message: '1 new Ring event added (live view, not counted as motion).' });

    const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
    assert.ok(today.events.some((e) => e.id === 'ondemand-1' && e.type === 'on_demand'), 'shown in the timeline data');
    assert.notStrictEqual(today.doses[0].status, 'likely_taken', 'a live view is not activity near the pills');
    assert.ok(!today.summary.last.startsWith(new Date(t).toISOString().slice(11, 16) + ' at'), 'not the last activity');
    const week = await (await fetch(`${base}/api/week`, { headers: auth })).json();
    assert.notStrictEqual(week.days[6].doses[0].status, 'likely_taken');

    const wording = await (await fetch(`${base}/api/wording`, { headers: auth })).json();
    assert.strictEqual(wording.eventLabels.on_demand, 'Live view opened (Ring Playground)');
    assert.strictEqual(wording.otherEventPrefix, 'Ring event');
  });
});

test('fetch messages for each mix of event kinds', () => {
  const { fetchResultText } = require('../wording');
  assert.strictEqual(fetchResultText({}), 'No new events.');
  assert.strictEqual(fetchResultText({ motion: 1 }), '1 new Ring event added.');
  assert.strictEqual(fetchResultText({ motion: 2 }), '2 new Ring events added.');
  assert.strictEqual(fetchResultText({ liveView: 1 }), '1 new Ring event added (live view, not counted as motion).');
  assert.strictEqual(fetchResultText({ other: 2 }), '2 new Ring events added (not counted as motion).');
  assert.strictEqual(fetchResultText({ motion: 1, liveView: 2 }), '3 new Ring events added (1 motion, 2 not counted as motion).');
});
