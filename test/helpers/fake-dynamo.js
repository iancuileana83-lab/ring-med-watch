// Shared fake DynamoDB for tests (not a test file).
const assert = require('node:assert');

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
          if (i.UpdateExpression === 'SET resolvedAt = :t') { item.resolvedAt = i.ExpressionAttributeValues[':t']; return {}; }
          // generic "SET #n0 = :v0, #n1 = :v1"
          for (const part of i.UpdateExpression.replace(/^SET /, '').split(', ')) {
            const [name, val] = part.split(' = ');
            item[i.ExpressionAttributeNames[name]] = i.ExpressionAttributeValues[val];
          }
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

module.exports = { fakeDynamo };
