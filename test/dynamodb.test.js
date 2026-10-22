const test = require('node:test');
const assert = require('node:assert');
const { createDynamoStore } = require('../store-dynamodb');

// Minimal in-memory stand-in for DynamoDB: supports the Get/Put/Query calls the store uses,
// including conditional puts, BETWEEN sort-key ranges, filters and pagination.
function fakeDynamo({ pageSize = 1000 } = {}) {
  const table = new Map();
  const calls = [];
  const k = (pk, sk) => `${pk}\u0000${sk}`;
  return {
    calls,
    table,
    async send(cmd) {
      const i = cmd.input;
      calls.push({ type: cmd.constructor.name, input: i });
      assert.ok(i.TableName === 'test-table', 'wrong table name');
      switch (cmd.constructor.name) {
        case 'PutCommand': {
          if (i.ConditionExpression === 'attribute_not_exists(pk)' && table.has(k(i.Item.pk, i.Item.sk))) {
            const e = new Error('exists'); e.name = 'ConditionalCheckFailedException'; throw e;
          }
          table.set(k(i.Item.pk, i.Item.sk), { ...i.Item });
          return {};
        }
        case 'DeleteCommand':
          table.delete(k(i.Key.pk, i.Key.sk));
          return {};
        case 'UpdateCommand': {
          const item = table.get(k(i.Key.pk, i.Key.sk));
          if (!item) { const e = new Error('missing'); e.name = 'ConditionalCheckFailedException'; throw e; }
          if (i.ConditionExpression === 'attribute_not_exists(resolvedAt)' && item.resolvedAt) {
            const e = new Error('resolved'); e.name = 'ConditionalCheckFailedException'; throw e;
          }
          item.resolvedAt = i.ExpressionAttributeValues[':t'];
          return {};
        }
        case 'GetCommand':
          return { Item: table.get(k(i.Key.pk, i.Key.sk)) };
        case 'QueryCommand': {
          const v = i.ExpressionAttributeValues;
          let items = [...table.values()].filter((x) => x.pk === v[':pk']);
          if (i.KeyConditionExpression.includes('BETWEEN')) items = items.filter((x) => x.sk >= v[':a'] && x.sk <= v[':b']);
          items.sort((a, b) => a.sk.localeCompare(b.sk));
          const start = i.ExclusiveStartKey ? items.findIndex((x) => x.sk === i.ExclusiveStartKey.sk) + 1 : 0;
          const page = items.slice(start, start + pageSize);
          const more = start + pageSize < items.length;
          const result = { Items: page, ...(more ? { LastEvaluatedKey: { pk: v[':pk'], sk: page[page.length - 1].sk } } : {}) };
          if (i.FilterExpression === 'checkinHash = :h') result.Items = result.Items.filter((x) => x.checkinHash === v[':h']);
          else if (i.FilterExpression === 'simulated = :t') result.Items = result.Items.filter((x) => x.simulated === true);
          else if (i.FilterExpression) result.Items = result.Items.filter((x) => x.sentAt >= v[':a'] && x.sentAt < v[':b']);
          return result;
        }
        default:
          throw new Error(`unexpected command ${cmd.constructor.name}`);
      }
    }
  };
}

const ev = (id, time, type = 'motion_detected', deviceId = 'cam') => ({ id, time, type, deviceId });
const make = (opts) => { const client = fakeDynamo(opts); return { client, store: createDynamoStore({ tableName: 'test-table', client, defaultTimezone: 'Europe/Bucharest' }) }; };

test('addEvent stores only time, type, device and a 30-day ttl; duplicates are ignored', async () => {
  const { client, store } = make();
  assert.strictEqual(await store.addEvent(ev('a', '2026-10-22T08:00:00.000Z')), true);
  assert.strictEqual(await store.addEvent(ev('a', '2026-10-22T08:00:00.000Z')), false);
  const item = [...client.table.values()][0];
  assert.deepStrictEqual(Object.keys(item).sort(), ['deviceId', 'id', 'pk', 'sk', 'time', 'ttl', 'type']);
  assert.strictEqual(item.ttl, Math.floor(Date.parse('2026-10-22T08:00:00Z') / 1000) + 30 * 24 * 3600);
});

test('listEvents spans UTC days, respects the exclusive end, and paginates', async () => {
  const { store } = make({ pageSize: 2 });
  for (const [id, t] of [['1', '2026-10-21T22:30:00.000Z'], ['2', '2026-10-22T05:00:00.000Z'], ['3', '2026-10-22T05:01:00.000Z'],
    ['4', '2026-10-22T05:02:00.000Z'], ['5', '2026-10-22T21:00:00.000Z'], ['6', '2026-10-23T09:00:00.000Z']]) await store.addEvent(ev(id, t));
  const got = await store.listEvents('2026-10-21T21:00:00.000Z', '2026-10-22T21:00:00.000Z');
  assert.deepStrictEqual(got.map((e) => e.id), ['1', '2', '3', '4']);
  assert.deepStrictEqual(Object.keys(got[0]).sort(), ['deviceId', 'id', 'time', 'type']);
});

test('recordAlert is once per key; listAlerts filters by sentAt', async () => {
  const { store } = make();
  assert.strictEqual(await store.recordAlert('2026-10-22T08:00', { sentAt: '2026-10-22T06:00:00.000Z', doseTime: '08:00' }), true);
  assert.strictEqual(await store.recordAlert('2026-10-22T08:00', { sentAt: '2026-10-22T06:05:00.000Z', doseTime: '08:00' }), false);
  await store.recordAlert('2026-10-21T20:00', { sentAt: '2026-10-21T18:00:00.000Z', doseTime: '20:00' });
  const today = await store.listAlerts('2026-10-21T21:00:00.000Z', '2026-10-22T21:00:00.000Z');
  assert.deepStrictEqual(today, [{ key: '2026-10-22T08:00', sentAt: '2026-10-22T06:00:00.000Z', doseTime: '08:00' }]);
});

test('settings: defaults first, then saved values merge over them', async () => {
  const { store } = make();
  const first = await store.getSettings();
  assert.strictEqual(first.timezone, 'Europe/Bucharest');
  assert.deepStrictEqual(first.doses, []);
  await store.saveSettings({ doses: [{ time: '08:00' }], cameraId: 'cam-pills' });
  await store.saveSettings({ windowAfterMinutes: 30 });
  const s = await store.getSettings();
  assert.deepStrictEqual(s.doses, [{ time: '08:00' }]);
  assert.strictEqual(s.cameraId, 'cam-pills');
  assert.strictEqual(s.windowAfterMinutes, 30);
  assert.strictEqual(s.windowBeforeMinutes, 15);
  assert.ok(!('pk' in s) && !('sk' in s));
});

test('other errors are not swallowed', async () => {
  const store = createDynamoStore({ tableName: 'test-table', client: { send: async () => { const e = new Error('denied'); e.name = 'AccessDeniedException'; throw e; } } });
  await assert.rejects(store.addEvent(ev('x', '2026-10-22T08:00:00.000Z')), /denied/);
});

test('simulated events are flagged, listed, and removed without touching real ones', async () => {
  const { client, store } = make();
  const now = new Date().toISOString();
  await store.addEvent({ ...ev('real', now) });
  await store.addEvent({ ...ev('sim', now), simulated: true });
  const before = await store.listEvents(new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  assert.deepStrictEqual(before.map((e) => [e.id, !!e.simulated]), [['real', false], ['sim', true]].sort());
  assert.strictEqual(await store.deleteSimulatedEvents(), 1);
  const after = await store.listEvents(new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  assert.deepStrictEqual(after.map((e) => e.id), ['real']);
  assert.ok(client.calls.some((c) => c.type === 'DeleteCommand'));
});

test('alert email text is stored and returned', async () => {
  const { store } = make();
  await store.recordAlert('2026-10-22T08:00', { sentAt: '2026-10-22T06:00:00.000Z', doseTime: '08:00', subject: 'S', message: 'M' });
  const [a] = await store.listAlerts('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
  assert.strictEqual(a.subject, 'S');
  assert.strictEqual(a.message, 'M');
});

test('check-in: lookup by token hash, one-time resolve, hash never listed', async () => {
  const { client, store } = make();
  await store.recordAlert('2026-10-22T08:00', { sentAt: '2026-10-22T06:00:00.000Z', doseTime: '08:00', checkinHash: 'h1', simulated: true });
  await store.recordAlert('2026-10-22T20:00', { sentAt: '2026-10-22T18:00:00.000Z', doseTime: '20:00', checkinHash: 'h2' });
  assert.deepStrictEqual(await store.findAlertByHash('h1'), { key: '2026-10-22T08:00', doseTime: '08:00', resolvedAt: null });
  assert.strictEqual(await store.findAlertByHash('nope'), null);
  assert.deepStrictEqual(await store.resolveAlertByHash('nope', 'now'), { status: 'invalid' });
  assert.deepStrictEqual(await store.resolveAlertByHash('h1', '2026-10-22T07:00:00.000Z'), { status: 'resolved', doseTime: '08:00' });
  assert.deepStrictEqual(await store.resolveAlertByHash('h1', '2026-10-22T07:05:00.000Z'), { status: 'already', doseTime: '08:00' });
  const listed = await store.listAlerts('2026-10-22T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
  assert.strictEqual(listed[0].resolvedAt, '2026-10-22T07:00:00.000Z');
  assert.strictEqual(listed[0].simulated, true);
  assert.strictEqual(listed[1].resolvedAt, undefined);
  assert.ok(!JSON.stringify(listed).includes('checkinHash'));
  assert.ok(client.calls.some((c) => c.type === 'UpdateCommand'));
});

test('a racing second click loses the conditional update', async () => {
  const { client, store } = make();
  await store.recordAlert('k', { sentAt: '2026-10-22T06:00:00.000Z', doseTime: '08:00', checkinHash: 'h' });
  // Simulate another request resolving it between our read and our write.
  const realSend = client.send.bind(client);
  client.send = async (cmd) => {
    if (cmd.constructor.name === 'UpdateCommand') client.table.get('ALERT\u0000k').resolvedAt = 'someone-else';
    return realSend(cmd);
  };
  assert.deepStrictEqual(await store.resolveAlertByHash('h', 'now'), { status: 'already', doseTime: '08:00' });
});

test('daily summary marker: claim once, release to retry', async () => {
  const { store } = make();
  assert.strictEqual(await store.claimDaily('2026-10-22'), true);
  assert.strictEqual(await store.claimDaily('2026-10-22'), false);
  await store.releaseDaily('2026-10-22');
  assert.strictEqual(await store.claimDaily('2026-10-22'), true);
});
