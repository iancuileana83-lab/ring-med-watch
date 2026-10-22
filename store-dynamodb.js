// DynamoDB storage with the same interface as the in-memory store.
// Single table, keys pk/sk (strings), TTL attribute "ttl" (epoch seconds, 30 days).
// Only event time, type and device id are stored: no video, no images.
//
//   EVENTS#<UTC date> / <ISO time>#<event id>   motion and other Ring events
//   ALERT / <dose key>                          one record per alerted dose window
//   SETTINGS / CURRENT                          caregiver settings

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

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

    // Fill in the email text after sending; remove the reservation if sending failed.
    async updateAlert(key, fields) {
      const names = Object.keys(fields).filter((k) => ['subject', 'message', 'simulated'].includes(k) && fields[k] !== undefined);
      if (!names.length) return;
      await db.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: 'ALERT', sk: key },
        UpdateExpression: 'SET ' + names.map((n, i) => `#n${i} = :v${i}`).join(', '),
        ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#n${i}`, n])),
        ExpressionAttributeValues: Object.fromEntries(names.map((n, i) => [`:v${i}`, fields[n]])),
        ConditionExpression: 'attribute_exists(pk)'
      }));
    },

    async releaseAlert(key) {
      await db.send(new DeleteCommand({ TableName: tableName, Key: { pk: 'ALERT', sk: key } }));
    },

    async listAlerts(fromIso, toIso) {
      const items = await queryAll({
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: 'sentAt >= :a AND sentAt < :b',
        ExpressionAttributeValues: { ':pk': 'ALERT', ':a': fromIso, ':b': toIso }
      });
      return items
        .map(({ sk, sentAt, doseTime, subject, message, resolvedAt, simulated }) => ({
          key: sk, sentAt, doseTime,
          ...(subject ? { subject } : {}), ...(message ? { message } : {}),
          ...(resolvedAt ? { resolvedAt } : {}), ...(simulated ? { simulated: true } : {})
        }))
        .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    },

    async findAlertByHash(hash) {
      const [item] = await queryAll({
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: 'checkinHash = :h',
        ExpressionAttributeValues: { ':pk': 'ALERT', ':h': hash }
      });
      return item ? { key: item.sk, doseTime: item.doseTime, resolvedAt: item.resolvedAt || null } : null;
    },

    // The conditional update makes the token one-time even if two clicks arrive together.
    async resolveAlertByHash(hash, nowIso) {
      const found = await this.findAlertByHash(hash);
      if (!found) return { status: 'invalid' };
      if (found.resolvedAt) return { status: 'already', doseTime: found.doseTime };
      try {
        await db.send(new UpdateCommand({
          TableName: tableName,
          Key: { pk: 'ALERT', sk: found.key },
          UpdateExpression: 'SET resolvedAt = :t',
          ConditionExpression: 'attribute_not_exists(resolvedAt)',
          ExpressionAttributeValues: { ':t': nowIso }
        }));
        return { status: 'resolved', doseTime: found.doseTime };
      } catch (err) {
        if (isConditionFailure(err)) return { status: 'already', doseTime: found.doseTime };
        throw err;
      }
    },

    async claimDaily(dateKey) {
      try {
        await db.send(new PutCommand({
          TableName: tableName,
          Item: { pk: 'SUMMARY', sk: dateKey, ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS },
          ConditionExpression: 'attribute_not_exists(pk)'
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async releaseDaily(dateKey) {
      await db.send(new DeleteCommand({ TableName: tableName, Key: { pk: 'SUMMARY', sk: dateKey } }));
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
