const crypto = require('crypto');

const API_BASE = 'https://api.amazonvision.com';
const TOKEN_URL = 'https://oauth.ring.com/oauth/token';
const PLAYGROUND_TOKEN_MINUTES = 30;

// Ring's docs require User-Agent ("AppName/version") and Hardware_Id (a UUID) on requests, else HTTP 406.
const USER_AGENT = 'ring-med-watch/1.0';
const HARDWARE_ID = (() => {
  const h = crypto.createHash('sha256').update('ring-med-watch').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
})();

// Error from a Ring call. Messages never contain a token or a response body.
class RingError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RingError';
    this.status = status || null;
  }
}

/* ---------- Ring Playground token: memory only, 30-minute expiry, never logged or returned ---------- */
let playground = null; // { token, expiresAt }

function setPlaygroundToken(token, nowMs = Date.now()) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{20,4096}$/.test(token.trim())) {
    throw new Error('That does not look like a Ring token');
  }
  playground = { token: token.trim(), expiresAt: nowMs + PLAYGROUND_TOKEN_MINUTES * 60000 };
}

// What the dashboard may know: whether it is connected and until when. Never the token.
function playgroundStatus(nowMs = Date.now()) {
  if (!playground) return { state: 'none', until: null };
  if (playground.expiresAt <= nowMs) return { state: 'expired', until: new Date(playground.expiresAt).toISOString() };
  return { state: 'connected', until: new Date(playground.expiresAt).toISOString() };
}

/* ---------- Access token: Playground token if valid, else refresh-token flow ---------- */
let cachedToken = null;
// Ring may rotate the refresh token; the new one is kept in memory only.
let refreshToken = process.env.RING_REFRESH_TOKEN;

function refreshConfigured() {
  return Boolean(process.env.RING_CLIENT_ID && process.env.RING_CLIENT_SECRET && refreshToken);
}

// 'ok' | 'token_expired' | 'not_linked'
function ringApiState(nowMs = Date.now()) {
  if (playgroundStatus(nowMs).state === 'connected' || refreshConfigured()) return 'ok';
  return playground ? 'token_expired' : 'not_linked';
}

function ringApiConfigured() {
  return ringApiState() === 'ok';
}

async function getAccessToken() {
  if (playgroundStatus().state === 'connected') return playground.token;
  if (!refreshConfigured()) {
    throw new RingError(playground ? 'The Ring Playground token expired' : 'Ring is not connected');
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Hardware_Id: HARDWARE_ID },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.RING_CLIENT_ID,
      client_secret: process.env.RING_CLIENT_SECRET,
      refresh_token: refreshToken
    })
  });
  if (!res.ok) throw new RingError(`Ring token refresh failed: HTTP ${res.status}`, res.status);
  const body = await res.json();
  if (body.refresh_token) refreshToken = body.refresh_token;
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function ringGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      Hardware_Id: HARDWARE_ID
    }
  });
  if (res.status === 401 || res.status === 403) throw new RingError('Ring rejected the token', res.status);
  if (res.status === 406) throw new RingError('Ring blocked this request (HTTP 406). Ring may block requests from cloud servers', 406);
  if (!res.ok) throw new RingError(`Ring API request failed: HTTP ${res.status}`, res.status);
  return res.json();
}

// Lists the Ring cameras visible to the token as { id, name } (GET /v1/devices).
async function listDevices() {
  const body = await ringGet('/v1/devices');
  return (body.data || []).map((d) => ({
    id: d.id,
    name: d.attributes?.name || d.attributes?.description || d.id
  }));
}

// Events from Event History (GET /v1/history/devices/{device_id}/events), newest first, normalised for the store.
// Motion types become 'motion_detected' (the only type that counts for dose checks); every other Ring event
// type (for example 'on_demand', a live view opened) is kept under its own type so it shows in the timeline.
// Follows links.next for at most `maxPages` pages.
// Ring documents start/end as epoch milliseconds; also accept seconds, numeric strings and ISO strings.
function ringTimeMs(value) {
  const n = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  if (typeof n === 'number' && Number.isFinite(n)) return n >= 1e12 ? n : n >= 1e9 ? n * 1000 : NaN;
  const t = typeof n === 'string' ? Date.parse(n) : NaN;
  return t;
}

// The returned array has a non-enumerable `stats` property: what Ring sent and what was skipped (no secrets).
async function fetchHistoryEvents(deviceId, { maxPages = 3 } = {}) {
  const events = [];
  const stats = { pages: 0, received: 0, types: {}, skipped: { noType: 0, badTime: 0 } };
  let path = `/v1/history/devices/${encodeURIComponent(deviceId)}/events`;
  for (let page = 0; page < maxPages && path; page++) {
    const body = await ringGet(path);
    stats.pages++;
    for (const e of body.data || []) {
      stats.received++;
      const kind = String(e.attributes?.event_type || '');
      stats.types[kind || '(none)'] = (stats.types[kind || '(none)'] || 0) + 1;
      const start = ringTimeMs(e.attributes?.start ?? e.attributes?.end);
      if (!kind) { stats.skipped.noType++; continue; }
      if (!Number.isFinite(start)) { stats.skipped.badTime++; continue; }
      const type = kind.startsWith('motion') ? 'motion_detected' : /^[\w.-]{1,40}$/.test(kind) ? kind : 'unknown';
      // Ring gives every event an id; if one were missing, build a stable one so the event is not lost.
      events.push({ id: e.id ? String(e.id) : `${deviceId}:${kind}:${start}`, time: new Date(start).toISOString(), type, deviceId });
    }
    const next = body.links?.next;
    path = typeof next === 'string' && next.startsWith('/') ? next : null; // relative URL, keeps the original filters
  }
  Object.defineProperty(events, 'stats', { value: stats, enumerable: false });
  return events;
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
    deviceId: deviceIdOf(payload)
  };
}

// The camera that produced the event: attributes.source, else the device in the event's relationships
// (an id, or a link ending in /v1/devices/<id>).
function deviceIdOf(payload) {
  const attrs = payload?.data?.attributes || {};
  if (attrs.source) return String(attrs.source);
  const rel = payload?.data?.relationships?.devices;
  const direct = Array.isArray(rel?.data) ? rel.data[0]?.id : rel?.data?.id;
  if (direct) return String(direct);
  const link = rel?.links?.related || rel?.links?.self || (typeof rel === 'string' ? rel : null);
  const m = typeof link === 'string' && link.match(/\/devices\/([^/?#]+)/);
  return m ? m[1] : null;
}

module.exports = {
  RingError, listDevices, fetchHistoryEvents, verifySignature, parseWebhook,
  ringApiConfigured, ringApiState, setPlaygroundToken, playgroundStatus
};
