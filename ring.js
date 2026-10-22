const crypto = require('crypto');

const API_BASE = 'https://api.amazonvision.com';
const TOKEN_URL = 'https://oauth.ring.com/oauth/token';

let cachedToken = null;

// Exchanges the refresh token for a short-lived access token (Ring Partner API).
// Ring may rotate the refresh token; the new one is kept in memory only.
let refreshToken = process.env.RING_REFRESH_TOKEN;

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;
  if (!process.env.RING_CLIENT_ID || !process.env.RING_CLIENT_SECRET || !refreshToken) {
    throw new Error('Ring credentials are not configured (RING_CLIENT_ID, RING_CLIENT_SECRET, RING_REFRESH_TOKEN)');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.RING_CLIENT_ID,
      client_secret: process.env.RING_CLIENT_SECRET,
      refresh_token: refreshToken
    })
  });
  if (!res.ok) throw new Error(`Ring token refresh failed: HTTP ${res.status}`);
  const body = await res.json();
  if (body.refresh_token) refreshToken = body.refresh_token;
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function ringGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${await getAccessToken()}`, Accept: 'application/vnd.api+json' }
  });
  if (!res.ok) throw new Error(`Ring API ${path} failed: HTTP ${res.status}`);
  return res.json();
}

// Lists the Ring cameras linked to the account as { id, name }.
async function listDevices() {
  const body = await ringGet('/v1/devices');
  return (body.data || []).map((d) => ({
    id: d.id,
    name: d.attributes?.name || d.attributes?.description || d.id
  }));
}

// Webhook v1.1 signature: X-Signature = "sha256=" + hex HMAC-SHA256 of the raw body.
function verifySignature(rawBody, header, hmacKey) {
  if (!header || !hmacKey) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', hmacKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Turns a Ring webhook payload (v1.1, or the older flat shape) into a stored event.
function parseWebhook(payload) {
  const type = payload?.data?.type || payload?.type;
  if (!type) return null;
  const attrs = payload?.data?.attributes || {};
  const ts = attrs.timestamp ? new Date(attrs.timestamp) : new Date(payload?.meta?.time || Date.now());
  const time = Number.isNaN(ts.getTime()) ? new Date() : ts;
  return {
    id: payload?.data?.id || payload?.meta?.request_id || `${type}-${time.getTime()}`,
    time: time.toISOString(),
    type,
    deviceId: attrs.source || null
  };
}

module.exports = { listDevices, verifySignature, parseWebhook };
