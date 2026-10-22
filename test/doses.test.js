const test = require('node:test');
const assert = require('node:assert');
const { zonedToUtcMs, dayBounds, validateSettings, evaluateDoses, checkDoses } = require('../doses');
const { createMemoryStore } = require('../store');

const TZ = 'Europe/Bucharest';
const base = { doses: [{ time: '08:00' }, { time: '20:00' }], windowBeforeMinutes: 15, windowAfterMinutes: 45, cameraId: 'cam-pills', timezone: TZ };
const at = (iso) => Date.parse(iso);
const motion = (iso, deviceId = 'cam-pills') => ({ id: iso + deviceId, time: iso, type: 'motion_detected', deviceId });

test('zonedToUtcMs handles summer (UTC+3) and winter (UTC+2) time', () => {
  assert.strictEqual(new Date(zonedToUtcMs('2026-10-22', '08:00', TZ)).toISOString(), '2026-10-22T05:00:00.000Z');
  assert.strictEqual(new Date(zonedToUtcMs('2026-11-02', '08:00', TZ)).toISOString(), '2026-11-02T06:00:00.000Z');
});

test('dayBounds covers the local day, including the 25-hour DST change day', () => {
  const b = dayBounds(at('2026-10-25T12:00:00Z'), TZ);
  assert.strictEqual(b.date, '2026-10-25');
  assert.strictEqual((Date.parse(b.to) - Date.parse(b.from)) / 3600000, 25);
});

test('status: upcoming, in_window, likely_taken, not_confirmed', () => {
  const win = (now, events = []) => evaluateDoses(base, events, at(now)).map((d) => d.status);
  assert.deepStrictEqual(win('2026-10-22T04:00:00Z'), ['upcoming', 'upcoming']);
  assert.deepStrictEqual(win('2026-10-22T05:10:00Z'), ['in_window', 'upcoming']);
  assert.deepStrictEqual(win('2026-10-22T05:10:00Z', [motion('2026-10-22T05:05:00Z')]), ['likely_taken', 'upcoming']);
  assert.deepStrictEqual(win('2026-10-22T06:00:00Z'), ['not_confirmed', 'upcoming']);
});

test('motion at another camera or outside the window does not count', () => {
  const events = [motion('2026-10-22T05:05:00Z', 'cam-door'), motion('2026-10-22T03:00:00Z')];
  assert.strictEqual(evaluateDoses(base, events, at('2026-10-22T06:00:00Z'))[0].status, 'not_confirmed');
});

test('no camera chosen gives no_camera, never a missed status', () => {
  const s = evaluateDoses({ ...base, cameraId: null }, [], at('2026-10-22T06:00:00Z'));
  assert.ok(s.every((d) => d.status === 'no_camera'));
});

test('checkDoses alerts once per missed window and retries after a failure', async () => {
  const store = createMemoryStore();
  await store.saveSettings(base);
  const sent = [];
  const now = at('2026-10-22T06:00:00Z');

  let first = await checkDoses({ store, notify: async (d) => sent.push(d.key), nowMs: now });
  assert.deepStrictEqual(first.alerted, ['2026-10-22T08:00']);
  let second = await checkDoses({ store, notify: async (d) => sent.push(d.key), nowMs: now + 60000 });
  assert.deepStrictEqual(second.alerted, []);
  assert.strictEqual(sent.length, 1);

  const store2 = createMemoryStore();
  await store2.saveSettings(base);
  await assert.rejects(checkDoses({ store: store2, notify: async () => { throw new Error('ses down'); }, nowMs: now }));
  const retry = await checkDoses({ store: store2, notify: async () => {}, nowMs: now + 60000 });
  assert.deepStrictEqual(retry.alerted, ['2026-10-22T08:00']);
});

test('no alert when motion was seen in the window', async () => {
  const store = createMemoryStore();
  await store.saveSettings(base);
  await store.addEvent(motion('2026-10-22T05:20:00Z'));
  const r = await checkDoses({ store, notify: async () => assert.fail('should not notify'), nowMs: at('2026-10-22T06:00:00Z') });
  assert.deepStrictEqual(r.alerted, []);
});

test('validateSettings accepts good input and rejects bad input', () => {
  assert.deepStrictEqual(validateSettings({ doses: ['20:00', '08:00', '08:00'] }).doses, [{ time: '08:00' }, { time: '20:00' }]);
  assert.throws(() => validateSettings({ doses: ['8:00'] }));
  assert.throws(() => validateSettings({ doses: new Array(7).fill('08:00') }));
  assert.throws(() => validateSettings({ windowAfterMinutes: 999 }));
  assert.throws(() => validateSettings({ timezone: 'Mars/Base' }));
});
