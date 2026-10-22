process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.STORAGE_BACKEND = '';
process.env.RING_HMAC_KEY = '';
process.env.CRON_TOKEN = 'cron-secret-for-tests';
process.env.PUBLIC_BASE_URL = 'https://example.test';

const test = require('node:test');
const assert = require('node:assert');
const { app, store, deps } = require('../index');
const { hashToken, newToken, TOKEN_RE } = require('../checkin');
const { runDailySummary } = require('../summary');
const { createMemoryStore } = require('../store');
const { CHECKIN, FOOTER_LINES, SUMMARY_SUBJECT, summaryPrompt } = require('../wording');

const cron = { 'X-Cron-Token': 'cron-secret-for-tests', 'Content-Type': 'application/json' };
const auth = { Authorization: 'Basic ' + Buffer.from('x:test-pass').toString('base64') };
const withServer = async (fn) => {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
};
// A dose whose window ended long ago, so check-doses will alert for it.
const dueSettings = (cameraId) => ({ doses: [{ time: '00:00', label: '' }], windowBeforeMinutes: 0, windowAfterMinutes: 1, cameraId, timezone: 'UTC' });

test('tokens are 43-char base64url and only the hash is stored', () => {
  const t = newToken();
  assert.match(t, TOKEN_RE);
  assert.notStrictEqual(t, newToken());
  assert.strictEqual(hashToken(t).length, 64);
});

test('check-doses with the DEMO camera sends a real alert marked as a simulation, with a check-in link', async () => {
  const sent = [];
  const saved = { g: deps.generateText, s: deps.sendAlertEmail };
  deps.generateText = async () => 'AI text';
  deps.sendAlertEmail = async (message, subject, extra) => sent.push({ message, subject, extra });
  try {
    await store.saveSettings(dueSettings('demo-camera'));
    await withServer(async (base) => {
      const r = await (await fetch(`${base}/internal/check-doses`, { method: 'POST', headers: cron, body: '{}' })).json();
      assert.strictEqual(r.alerted.length, 1);
      assert.strictEqual(sent.length, 1);
      assert.match(sent[0].subject, /dose possibly missed \(simulation\)$/);
      assert.ok(sent[0].extra.includes('Note: this alert is based on the demo camera, so the data is simulated.'));
      const link = sent[0].extra.find((l) => l.startsWith('Checked in with them?'));
      assert.match(link, /^Checked in with them\? Let the dashboard know: https:\/\/example\.test\/checkin\?t=[A-Za-z0-9_-]{43}$/);

      const alerts = (await (await fetch(`${base}/api/alerts`, { headers: auth })).json()).alerts;
      assert.strictEqual(alerts[0].simulated, true);
      assert.ok(alerts[0].message.includes('simulated'));
      assert.ok(!JSON.stringify(alerts).includes('checkinHash'), 'token hash must not be exposed');
      assert.ok(!alerts[0].message.includes('/checkin?t='), 'link must not be stored in the preview text');

      // second run: no duplicate
      const again = await (await fetch(`${base}/internal/check-doses`, { method: 'POST', headers: cron, body: '{}' })).json();
      assert.deepStrictEqual(again.alerted, []);
      assert.strictEqual(sent.length, 1);

      // the link works: GET shows a button and changes nothing, POST resolves once
      const token = link.split('t=')[1];
      const page = await fetch(`${base}/checkin?t=${token}`);
      assert.strictEqual(page.status, 200);
      assert.strictEqual(page.headers.get('cache-control'), 'no-store');
      assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
      const html = await page.text();
      assert.ok(html.includes(CHECKIN.question('00:00')) && html.includes(CHECKIN.button) && html.includes(CHECKIN.disclaimer));
      FOOTER_LINES.forEach((l) => assert.ok(html.includes(l.replace(/'/g, '&#39;'))));
      assert.strictEqual((await (await fetch(`${base}/api/alerts`, { headers: auth })).json()).alerts[0].resolvedAt, undefined);

      const post = (t) => fetch(`${base}/checkin`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `t=${t}` });
      const first = await post(token);
      assert.strictEqual(first.status, 200);
      assert.ok((await first.text()).includes(CHECKIN.thanks));
      assert.ok((await (await post(token)).text()).includes(CHECKIN.already));
      assert.ok((await (await fetch(`${base}/checkin?t=${token}`)).text()).includes(CHECKIN.already));
      const after = (await (await fetch(`${base}/api/alerts`, { headers: auth })).json()).alerts[0];
      assert.ok(after.resolvedAt);

      const today = await (await fetch(`${base}/api/today`, { headers: auth })).json();
      assert.ok(today.summary.alerts.endsWith('1 checked in'), today.summary.alerts);
      assert.strictEqual(today.doses[0].checkedIn, true);
      assert.strictEqual(today.doses[0].status, 'not_confirmed'); // checking in never changes the dose status
    });
  } finally {
    deps.generateText = saved.g; deps.sendAlertEmail = saved.s;
  }
});

test('check-in rejects malformed and unknown tokens without needing a login', async () => {
  await withServer(async (base) => {
    for (const t of ['', 'short', 'x'.repeat(43), '<script>'.padEnd(43, 'a')]) {
      const r = await fetch(`${base}/checkin?t=${encodeURIComponent(t)}`);
      assert.strictEqual(r.status, 404, t);
      assert.ok((await r.text()).includes(CHECKIN.invalid));
    }
    const unknown = await fetch(`${base}/checkin`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `t=${newToken()}` });
    assert.strictEqual(unknown.status, 404);
  });
});

test('daily summary: skips with no doses, sends once, notes simulated events, falls back, retries after failure', async () => {
  const now = Date.parse('2026-10-22T17:30:00Z'); // 20:30 in Bucharest
  const settings = { doses: [{ time: '08:00', label: 'Morning pills' }, { time: '20:00', label: '' }], windowBeforeMinutes: 15, windowAfterMinutes: 45, cameraId: 'cam', timezone: 'Europe/Bucharest' };
  const mk = async () => { const s = createMemoryStore(); await s.saveSettings(settings); return s; };
  const out = [];
  const ok = { generate: async (p) => { out.push(p); return 'AI summary'; }, send: async (m, extra) => out.push([m, extra]) };

  const empty = createMemoryStore();
  assert.deepStrictEqual(await runDailySummary({ store: empty, ...ok, nowMs: now }), { skipped: 'no doses' });

  const s = await mk();
  await s.addEvent({ id: 'm1', time: '2026-10-22T05:10:00.000Z', type: 'motion_detected', deviceId: 'cam' });
  const r1 = await runDailySummary({ store: s, ...ok, nowMs: now });
  assert.strictEqual(r1.sent, true);
  assert.strictEqual(r1.simulated, false);
  assert.ok(out[0].includes('Dose 08:00: activity seen near the pills; Dose 20:00: dose window still open. 0 alert emails sent, 0 checked in'));
  assert.ok(!out[0].includes('Morning pills'), 'dose names are not sent to the AI');
  assert.deepStrictEqual(out[1], ['AI summary', []]);
  assert.deepStrictEqual(await runDailySummary({ store: s, ...ok, nowMs: now }), { skipped: 'already sent' });

  const sim = await mk();
  await sim.addEvent({ id: 's1', time: '2026-10-22T05:10:00.000Z', type: 'motion_detected', deviceId: 'cam', simulated: true });
  out.length = 0;
  assert.strictEqual((await runDailySummary({ store: sim, ...ok, nowMs: now })).simulated, true);
  assert.deepStrictEqual(out[1][1], ["Note: today's data includes simulated events."]);

  const fb = await mk();
  out.length = 0;
  await runDailySummary({ store: fb, generate: async () => { throw new Error('bedrock down'); }, send: async (m) => out.push(m), nowMs: now });
  assert.ok(out[0].startsWith('Today: 2 doses scheduled, 0 with activity seen near the pills, 1 not confirmed. 0 alert emails sent, 0 checked in.'));

  const flaky = await mk();
  await assert.rejects(runDailySummary({ store: flaky, generate: async () => 'x', send: async () => { throw new Error('ses down'); }, nowMs: now }), /ses down/);
  assert.strictEqual((await runDailySummary({ store: flaky, ...ok, nowMs: now })).sent, true);
});

test('daily-summary endpoint needs the cron token or password, and uses the approved subject', async () => {
  const sent = [];
  const saved = { g: deps.generateText, s: deps.sendAlertEmail };
  deps.generateText = async (p, max) => { sent.push(['gen', max]); return 'AI summary'; };
  deps.sendAlertEmail = async (m, subject, extra) => sent.push([subject, extra]);
  try {
    await store.saveSettings({ ...dueSettings('cam'), timezone: 'UTC' });
    await withServer(async (base) => {
      assert.strictEqual((await fetch(`${base}/internal/daily-summary`, { method: 'POST' })).status, 401);
      const r = await (await fetch(`${base}/internal/daily-summary`, { method: 'POST', headers: cron, body: '{}' })).json();
      assert.strictEqual(r.sent, true);
      assert.deepStrictEqual(sent[1][0], SUMMARY_SUBJECT);
      assert.strictEqual((await (await fetch(`${base}/internal/daily-summary`, { method: 'POST', headers: cron, body: '{}' })).json()).skipped, 'already sent');
    });
  } finally {
    deps.generateText = saved.g; deps.sendAlertEmail = saved.s;
  }
});

test('summary prompt is exactly the approved text', () => {
  const p = summaryPrompt({ doses: [{ time: '08:00', status: 'likely_taken' }], alertsSent: 1, checkedIn: 0 });
  assert.strictEqual(p, 'Write a short, calm daily summary (max 500 characters) for a family caregiver, using only these facts: Dose 08:00: activity seen near the pills. 1 alert emails sent, 0 checked in. For each dose say whether activity was seen near the pills or was not confirmed, or whether the dose window is still open. Mention how many alert emails were sent and how many were checked in. Never say a dose was definitely taken or definitely missed. Do not give medical advice. Never suggest taking a dose late, taking a double dose or changing any medicine, and never name a medicine. Sign it "- Ring Med Watch".');
});
