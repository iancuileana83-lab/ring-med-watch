// DynamoDB storage with the same interface as the in-memory store.
// Single table, keys pk/sk (strings), TTL attribute "ttl" (epoch seconds, 30 days).
// Only event time, type and device id are stored: no video, no images.
//
//   EVENTS#<UTC date> / <ISO time>#<event id>   motion and other Ring events
//   ALERT / <dose key>                          one record per alerted dose window
//   SETTINGS / CURRENT                          caregiver settings

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const TTL_SECONDS = 30 * 24 * 3600;
const DEFAULT_SETTINGS = {
  doses: [],
  windowBeforeMinutes: 15,
  windowAfterMinutes: 45,
  cameraId: null
};

const ttlFrom = (iso) => Math.floor(Date.parse(iso) / 1000) + TTL_SECONDS;

function isConditionFailure(err) {
  return err && err.name === 'ConditionalCheckFailedException';
}

// `client` is injectable for tests; it only needs a send(command) method.
function createDynamoStore({ tableName, region, client, defaultTimezone = 'UTC' }) {
  const db = client || DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  async function queryAll(input) {
    const items = [];
    let key;
    do {
      const out = await db.send(new QueryCommand({ ...input, TableName: tableName, ExclusiveStartKey: key }));
      items.push(...(out.Items || []));
      key = out.LastEvaluatedKey;
    } while (key);
    return items;
  }

  return {
    async addEvent(event) {
      try {
        await db.send(new PutCommand({
          TableName: tableName,
          Item: {
            pk: `EVENTS#${event.time.slice(0, 10)}`,
            sk: `${event.time}#${event.id}`,
            id: event.id, time: event.time, type: event.type, deviceId: event.deviceId,
            ...(event.simulated ? { simulated: true } : {}),
            ttl: ttlFrom(event.time)
          },
          ConditionExpression: 'attribute_not_exists(pk)'
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async listEvents(fromIso, toIso) {
      const events = [];
      for (let d = Date.parse(fromIso.slice(0, 10)); d <= Date.parse(toIso.slice(0, 10)); d += 86400000) {
        const items = await queryAll({
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
          ExpressionAttributeValues: { ':pk': `EVENTS#${new Date(d).toISOString().slice(0, 10)}`, ':a': fromIso, ':b': `${toIso}~` }
        });
        events.push(...items);
      }
      return events
        .filter((e) => e.time >= fromIso && e.time < toIso)
        .map(({ id, time, type, deviceId, simulated }) => ({ id, time, type, deviceId, ...(simulated ? { simulated: true } : {}) }))
        .sort((a, b) => a.time.localeCompare(b.time));
    },

    // Removes only demo events (last 30 days, the TTL window); returns how many were removed.
    async deleteSimulatedEvents() {
      let removed = 0;
      const today = Date.parse(new Date().toISOString().slice(0, 10));
      for (let d = today - 30 * 86400000; d <= today + 86400000; d += 86400000) {
        const items = await queryAll({
          KeyConditionExpression: 'pk = :pk',
          FilterExpression: 'simulated = :t',
          ExpressionAttributeValues: { ':pk': `EVENTS#${new Date(d).toISOString().slice(0, 10)}`, ':t': true }
        });
        for (const item of items) {
          await db.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
          removed++;
        }
      }
      return removed;
    },

    async recordAlert(key, alert) {
      try {
        await db.send(new PutCommand({
          TableName: tableName,
          Item: { pk: 'ALERT', sk: key, ...alert, ttl: ttlFrom(alert.sentAt) },
          ConditionExpression: 'attribute_not_exists(pk)'
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async listAlerts(fromIso, toIso) {
      const items = await queryAll({
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: 'sentAt >= :a AND sentAt < :b',
        ExpressionAttributeValues: { ':pk': 'ALERT', ':a': fromIso, ':b': toIso }
      });
      return items
        .map(({ sk, sentAt, doseTime, subject, message }) => ({ key: sk, sentAt, doseTime, ...(subject ? { subject } : {}), ...(message ? { message } : {}) }))
        .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    },

    async getSettings() {
      const out = await db.send(new GetCommand({ TableName: tableName, Key: { pk: 'SETTINGS', sk: 'CURRENT' } }));
      const { pk, sk, ...saved } = out.Item || {};
      return { ...DEFAULT_SETTINGS, timezone: defaultTimezone, ...saved };
    },

    async saveSettings(patch) {
      const next = { ...(await this.getSettings()), ...patch };
      await db.send(new PutCommand({ TableName: tableName, Item: { pk: 'SETTINGS', sk: 'CURRENT', ...next } }));
      return next;
    }
  };
}

module.exports = { createDynamoStore };
