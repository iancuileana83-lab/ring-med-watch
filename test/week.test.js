process.env.DASHBOARD_PASSWORD = 'test-pass';
process.env.STORAGE_BACKEND = '';
process.env.RING_HMAC_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateWeek, localDate } = require('../doses');
const { app, store } = require('../index');
const { UI } = require('../wording');

const TZ = 'Europe/Bucharest';
const NOW = Date.parse('2026-10-22T12:00:00Z'); // 15:00 in Bucharest
const base = { windowBeforeMinutes: 15, windowAfterMinutes: 45, cameraId: 'cam', timezone: TZ };
const auth = { Authorization: 'Basic ' + Buffer.from('x:test-pass').toString('base64') };
const statuses = (week, i = 0) => week.map((d) => `${d.date.slice(8)}:${d.doses[i].status}`);

test('days before the app had any data are "no_data", not "not_confirmed"', () => {
  const settings = { ...base, doses: [{ time: '10:20', label: '' }] };
  const events = [{ id: 'e', time: '2026-10-22T07:20:00.000Z', type: 'motion_detected', deviceId: 'cam' }];
  const week = evaluateWeek(settings, events, NOW, 7, { dataStartDate: '2026-10-21' });
  assert.deepStrictEqual(statuses(week), ['16:no_data', '17:no_data', '18:no_data', '19:no_data', '20:no_data', '21:not_confirmed', '22:likely_taken']);
});

test('days before a dose time existed are "no_data" for that dose only', () => {
  const settings = { ...base, doses: [{ time: '08:00', label: '', since: '2026-10-18' }, { time: '20:00', label: '', since: '2026-10-21' }] };
  const week = evaluateWeek(settings, [], NOW, 7, { dataStartDate: '2026-10-16' });
  assert.deepStrictEqual(statuses(week, 0), ['16:no_data', '17:no_data', '18:not_confirmed', '19:not_confirmed', '20:not_confirmed', '21:not_confirmed', '22:not_confirmed']);
  assert.deepStrictEqual(statuses(week, 1), ['16:no_data', '17:no_data', '18:no_data', '19:no_data', '20:no_data', '21:not_confirmed', '22:upcoming']);
});

test('today is never "no_data", and without any data information nothing changes', () => {
  const settings = { ...base, doses: [{ time: '10:20', label: '', since: '2026-10-25' }] };
  assert.strictEqual(evaluateWeek(settings, [], NOW, 7, { dataStartDate: '2026-10-30' })[6].doses[0].status, 'not_confirmed');
  const plain = { ...base, doses: [{ time: '10:20', label: '' }] };
  assert.ok(evaluateWeek(plain, [], NOW).slice(0, 6).every((d) => d.doses[0].status === 'not_confirmed'));
  assert.strictEqual(localDate(Date.parse('2026-10-21T22:30:00Z'), TZ), '2026-10-22');
});

test('the week API: only today has data, so earlier days say "No data"; PUT settings remembers when a dose first appeared', async () => {
  const server = app.listen(0);
  const base_ = `http://127.0.0.1:${server.address().port}`;
  const json = { ...auth, 'Content-Type': 'application/json' };
  try {
    await store.saveSettings({ doses: [], cameraId: 'cam', timezone: 'UTC' });
    const put = async (doses) => (await (await fetch(`${base_}/api/settings`, { method: 'PUT', headers: json, body: JSON.stringify({ doses }) })).json()).doses;

    const first = await put([{ time: '00:00', label: 'Early' }]);
    assert.match(first[0].since, /^\d{4}-\d{2}-\d{2}$/);
    // same time again: its original date is kept; a new time gets today's date
    await store.saveSettings({ doses: [{ time: '00:00', label: 'Early', since: '2020-01-01' }] });
    const second = await put([{ time: '00:00', label: 'Early' }, { time: '23:59', label: 'Late' }]);
    assert.strictEqual(second[0].since, '2020-01-01');
    assert.strictEqual(second[1].since, first[0].since);

    await store.saveSettings({ doses: [{ time: '00:00', label: 'Early' }] }); // no `since`: only the data start applies
    await store.addEvent({ id: 'wk-1', time: new Date().toISOString(), type: 'on_demand', deviceId: 'cam' });
    const week = await (await fetch(`${base_}/api/week`, { headers: auth })).json();
    const st = week.days.map((d) => d.doses[0].status);
    assert.ok(st.slice(0, 6).every((x) => x === 'no_data'), st.join(','));
    assert.notStrictEqual(st[6], 'no_data');
    assert.strictEqual(UI.weekLegend.no_data, 'No data');
  } finally {
    server.close();
  }
});
