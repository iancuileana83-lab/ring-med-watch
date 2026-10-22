require('dotenv').config();
const express = require('express');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const { listDevices, fetchHistoryEvents, verifySignature, parseWebhook, ringApiState, setPlaygroundToken, playgroundStatus, RingError } = require('./ring');
const { createMemoryStore } = require('./store');
const { createDynamoStore } = require('./store-dynamodb');
const { newToken, hashToken, TOKEN_RE } = require('./checkin');
const { runDailySummary } = require('./summary');
const { DEMO_CAMERA_ID, validateSettings, evaluateDoses, evaluateWeek, weekStartIso, checkDoses, dayBounds } = require('./doses');
const { STATUS_LABELS, FOOTER_LINES, MISSED_SUBJECT, missedPrompt, missedFallback,
  CHECKIN, SUMMARY_SUBJECT, DEMO_ALERT_SUFFIX, DEMO_ALERT_NOTE,
  NAV, PRIVACY_LINES, UI, EVENT_LABELS, OTHER_EVENT_PREFIX, fetchResultText, seenDeviceName, dosesSummary, alertsSummary, lastActivitySummary, houseStatus } = require('./wording');

const app = express();
// Keep the raw bytes: Ring's webhook signature is computed over them.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// STORAGE_BACKEND=dynamodb keeps data across restarts; the default is in-memory (local development, tests).
const store = process.env.STORAGE_BACKEND === 'dynamodb'
  ? createDynamoStore({ tableName: process.env.DYNAMODB_TABLE, region: process.env.AWS_REGION || 'us-east-1', defaultTimezone: process.env.TIMEZONE || 'UTC' })
  : createMemoryStore();

// Simple password gate for the caregiver-only API (HTTP Basic, any username).
function requirePassword(req, res, next) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return res.status(503).json({ error: 'DASHBOARD_PASSWORD is not set' });
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.replace(/^Basic /, ''), 'base64').toString().split(':').slice(1).join(':');
  if (given !== expected) {
    res.set('WWW-Authenticate', 'Basic realm="Ring Med Watch"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

const NO_MOTION_ALERT_HOURS = Number(process.env.NO_MOTION_ALERT_HOURS || 12);
const ALERT_EMAIL = process.env.ALERT_EMAIL;
if (!ALERT_EMAIL) console.warn('ALERT_EMAIL is not set; alert emails will fail until it is.');

let lastMotionAt = new Date();
let alreadyAlerted = false;

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const ses = new SESv2Client({ region: 'us-east-1' });

async function generateAlertMessage(hoursSinceMotion) {
  return generateText(`Write a short, calm, non-alarming message (max 300 characters) to a family caregiver. No motion has been detected at their relative's front door for ${hoursSinceMotion.toFixed(1)} hours. Ask them to check in. Do not sound like an emergency. Sign it "- Ring Med Watch".`);
}

async function generateText(prompt, maxTokens = 150) {
  const command = new InvokeModelCommand({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const response = await bedrock.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.content[0].text.trim();
}

// extraLines (check-in link, simulation notes) go between the message and the approved footer.
async function sendAlertEmail(message, subject = 'Ring Med Watch Alert', extraLines = []) {
  await ses.send(new SendEmailCommand({
    FromEmailAddress: ALERT_EMAIL,
    Destination: { ToAddresses: [ALERT_EMAIL] },
    Content: {
      Simple: {
        Subject: { Data: subject },
        Body: { Text: { Data: `${[message, ...extraLines].join('\n\n')}\n\n--\n${FOOTER_LINES.join('\n')}` } }
      }
    }
  }));
  console.log('Email sent:', message);
}

async function checkAndAlert() {
  const hoursSinceMotion = (Date.now() - lastMotionAt.getTime()) / 1000 / 60 / 60;

  if (hoursSinceMotion >= NO_MOTION_ALERT_HOURS && !alreadyAlerted) {
    try {
      const message = await generateAlertMessage(hoursSinceMotion);
      await sendAlertEmail(message);
      alreadyAlerted = true;
    } catch (err) {
      console.error('Alert failed:', err);
    }
  }
}

app.post('/webhooks/ring', async (req, res) => {
  // Signature check is enforced only when RING_HMAC_KEY is configured.
  if (process.env.RING_HMAC_KEY && !verifySignature(req.rawBody || '', req.headers['x-signature'], process.env.RING_HMAC_KEY)) {
    // Say why an event was dropped, without logging its content.
    console.warn(`Ring webhook rejected: ${req.headers['x-signature'] ? 'signature does not match RING_HMAC_KEY' : 'no X-Signature header'}`);
    return res.status(401).send('Invalid signature');
  }

  const parsed = parseWebhook(req.body);
  // Log only what is stored: time, type, device. Never the full payload.
  console.log('Received Ring event:', parsed ? `${parsed.type} ${parsed.time}` : 'unrecognised');

  if (parsed) {
    try {
      await store.addEvent(parsed);
    } catch (err) {
      console.error('Could not store event:', err.message);
    }
    if (parsed.type === 'motion_detected') {
      lastMotionAt = new Date(parsed.time);
      alreadyAlerted = false;
    }
  }

  res.status(200).send('OK');
});

// Cameras to choose from: the linked Ring account (when a refresh token is configured) plus any device
// seen in real Ring events (for example from the Ring Playground), so the list works without account linking.
app.get('/api/devices', requirePassword, async (req, res) => {
  let ringApi = ringApiState(); // 'ok' | 'token_expired' | 'not_linked'
  let apiDevices = [];
  if (ringApi === 'ok') {
    try {
      apiDevices = (await listDevices()).map((d) => ({ ...d, source: 'ring-api' }));
    } catch (err) {
      console.warn('Ring camera list unavailable:', err.message); // messages never contain the token
      ringApi = err instanceof RingError && (err.status === 401 || err.status === 403) ? 'token_rejected' : 'error';
    }
  }
  const now = Date.now();
  const events = await store.listEvents(new Date(now - 30 * 24 * 3600 * 1000).toISOString(), new Date(now + 1000).toISOString());
  const known = new Set(apiDevices.map((d) => d.id));
  const seen = [...new Set(events.filter((e) => !e.simulated && e.deviceId && !known.has(e.deviceId)).map((e) => e.deviceId))]
    .map((id) => ({ id, name: seenDeviceName(id), source: 'ring-events' }));
  res.json({ devices: [...apiDevices, ...seen], ringApi });
});

// ---- Ring Playground token: pasted by the caregiver, kept only in memory for 30 minutes ----
const ringStatusJson = async () => {
  const s = playgroundStatus();
  return { state: s.state, until: s.until, timezone: (await store.getSettings()).timezone };
};

app.get('/api/ring/status', requirePassword, async (req, res) => {
  res.json(await ringStatusJson());
});

app.put('/api/ring/token', requirePassword, async (req, res) => {
  try {
    setPlaygroundToken(req.body && req.body.token); // never logged, never echoed back
    res.json(await ringStatusJson());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pulls motion events from Ring Event History for the chosen camera into the timeline and dose checks.
app.post('/api/ring/fetch-events', requirePassword, async (req, res) => {
  const { cameraId } = await store.getSettings();
  if (playgroundStatus().state !== 'connected') return res.status(400).json({ error: 'Connect a Ring Playground token first' });
  if (!cameraId || cameraId === DEMO_CAMERA_ID) return res.status(400).json({ error: 'Choose a Ring camera in Settings first' });
  try {
    const events = await fetchHistoryEvents(cameraId);
    const counts = { motion: 0, liveView: 0, other: 0 };
    for (const e of events) {
      if (!(await store.addEvent(e))) continue; // addEvent ignores ids it already has
      counts[e.type === 'motion_detected' ? 'motion' : e.type === 'on_demand' ? 'liveView' : 'other']++;
    }
    res.json({ fetched: events.length, added: counts.motion + counts.liveView + counts.other, ...counts, message: fetchResultText(counts) });
  } catch (err) {
    console.warn('Ring event fetch failed:', err.message);
    res.status(err instanceof RingError && err.status === 401 ? 401 : 502).json({ error: err.message });
  }
});

app.get('/api/settings', requirePassword, async (req, res) => {
  res.json(await store.getSettings());
});

app.put('/api/settings', requirePassword, async (req, res) => {
  try {
    res.json(await store.saveSettings(validateSettings(req.body || {})));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Today's dose windows and their status.
app.get('/api/doses', requirePassword, async (req, res) => {
  const settings = await store.getSettings();
  const { from, to } = dayBounds(Date.now(), settings.timezone);
  res.json({ doses: evaluateDoses(settings, await store.listEvents(from, to), Date.now()) });
});

// Overridable in tests so no real AI or email call is made.
const deps = { generateText: (...a) => generateText(...a), sendAlertEmail: (...a) => sendAlertEmail(...a) };

// Public address of this service, used for the "I checked in" link.
const publicBase = (req) => (process.env.PUBLIC_BASE_URL || `https://${req.get('host')}`).replace(/\/+$/, '');

// Called on a schedule (every few minutes). Throws if sending fails so the dose is retried.
async function notifyPossiblyMissed(dose, { checkinToken, baseUrl } = {}) {
  const { timezone, cameraId } = await store.getSettings();
  const local = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const [start, end] = [local(dose.windowStart), local(dose.windowEnd)];
  let message;
  try {
    message = await deps.generateText(missedPrompt(dose.time, start, end));
  } catch (err) {
    console.error('AI message failed, using the fixed text:', err.message);
    message = missedFallback(dose.time, start, end);
  }
  const simulated = cameraId === DEMO_CAMERA_ID;
  const subject = MISSED_SUBJECT + (simulated ? DEMO_ALERT_SUFFIX : '');
  const stored = simulated ? `${message}\n\n${DEMO_ALERT_NOTE}` : message; // what the dashboard previews
  const extra = [];
  if (simulated) extra.push(DEMO_ALERT_NOTE);
  if (checkinToken && baseUrl) extra.push(CHECKIN.emailLine(`${baseUrl}/checkin?t=${checkinToken}`));
  await deps.sendAlertEmail(message, subject, extra);
  return { subject, message: stored, ...(simulated ? { simulated: true } : {}) };
}

// The scheduler may use CRON_TOKEN (X-Cron-Token header) instead of the dashboard password,
// so the job config never holds the password. The token only opens this one endpoint.
function requireCronOrPassword(req, res, next) {
  const token = process.env.CRON_TOKEN;
  const given = req.headers['x-cron-token'];
  if (token && given && given.length === token.length && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(token))) return next();
  return requirePassword(req, res, next);
}

app.post('/internal/check-doses', requireCronOrPassword, async (req, res) => {
  try {
    const baseUrl = publicBase(req);
    res.json(await checkDoses({ store, notify: (dose, ctx) => notifyPossiblyMissed(dose, { ...ctx, baseUrl }) }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sends one real missed-dose email for the first dose so the caregiver can check how it looks.
// Recorded like a normal alert (with a working check-in link), under its own key.
app.post('/test/trigger-missed-alert', requirePassword, async (req, res) => {
  try {
    const settings = await store.getSettings();
    if (!settings.doses.length) return res.status(400).json({ sent: false, error: 'Set a dose time first' });
    const now = Date.now();
    const dose = evaluateDoses(settings, [], now)[0];
    const token = newToken();
    const sent = await notifyPossiblyMissed(dose, { checkinToken: token, baseUrl: publicBase(req) });
    await store.recordAlert(`${dose.key}#test-${now}`, { sentAt: new Date(now).toISOString(), doseTime: dose.time, checkinHash: hashToken(token), ...sent });
    res.json({ sent: true, subject: sent.subject });
  } catch (err) {
    res.status(500).json({ sent: false, error: err.message });
  }
});

// Once a day (Cloud Scheduler, 20:30 Europe/Bucharest). Skipped if no doses are set or already sent today.
app.post('/internal/daily-summary', requireCronOrPassword, async (req, res) => {
  try {
    res.json(await runDailySummary({
      store,
      generate: (prompt) => deps.generateText(prompt, 300),
      send: (message, extra) => deps.sendAlertEmail(message, SUMMARY_SUBJECT, extra)
    }));
  } catch (err) {
    console.error('Daily summary failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- "I checked in" (public: the one-time token in the link is the only credential) ----
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function checkinPage(res, status, bodyHtml) {
  res.status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
    })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Ring Med Watch</title>
<style>body{margin:0;background:#fbf6ef;color:#2b2622;font:16px/1.5 system-ui,sans-serif}main{max-width:520px;margin:0 auto;padding:24px 16px}.card{background:#fffdf9;border:1px solid #eadfce;border-radius:16px;padding:20px}h1{font-size:1.3rem;margin:0 0 8px}button{font:inherit;font-weight:700;background:#1f7a6d;color:#fff;border:0;border-radius:10px;padding:12px 18px;min-height:44px;cursor:pointer}.muted{color:#6d6359;font-size:.9rem}footer{margin-top:16px;color:#6d6359;font-size:.85rem}@media (prefers-color-scheme:dark){body{background:#171411;color:#f1e9de}.card{background:#211d19;border-color:#342d26}.muted,footer{color:#b0a597}button{background:#5fc2b1;color:#0f2a25}}</style></head>
<body><main><div class="card">${bodyHtml}</div><footer>${FOOTER_LINES.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}</footer></main></body></html>`);
}

const tokenFrom = (value) => (typeof value === 'string' && TOKEN_RE.test(value) ? value : null);
const invalidPage = (res) => checkinPage(res, 404, `<h1>${escapeHtml(CHECKIN.heading)}</h1><p>${escapeHtml(CHECKIN.invalid)}</p>`);

// GET only shows a confirm button: mail scanners that open links must not resolve the alert.
app.get('/checkin', async (req, res) => {
  const token = tokenFrom(req.query.t);
  const alert = token && await store.findAlertByHash(hashToken(token));
  if (!alert) return invalidPage(res);
  if (alert.resolvedAt) return checkinPage(res, 200, `<h1>${escapeHtml(CHECKIN.heading)}</h1><p>${escapeHtml(CHECKIN.already)}</p>`);
  checkinPage(res, 200, `<h1>${escapeHtml(CHECKIN.heading)}</h1><p>${escapeHtml(CHECKIN.question(alert.doseTime))}</p>
<form method="post" action="/checkin"><input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit">${escapeHtml(CHECKIN.button)}</button></form>
<p class="muted">${escapeHtml(CHECKIN.disclaimer)}</p>`);
});

app.post('/checkin', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const token = tokenFrom(req.body && req.body.t);
  if (!token) return invalidPage(res);
  const result = await store.resolveAlertByHash(hashToken(token), new Date().toISOString());
  if (result.status === 'invalid') return invalidPage(res);
  const text = result.status === 'resolved' ? CHECKIN.thanks : CHECKIN.already;
  checkinPage(res, 200, `<h1>${escapeHtml(CHECKIN.heading)}</h1><p>${escapeHtml(text)}</p><p class="muted">${escapeHtml(CHECKIN.disclaimer)}</p>`);
});

// Local time of day, HH:MM, for dashboard summaries.
const clock = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

// Hours since the latest motion event at any camera (last 7 days), or null if none is on record.
async function hoursSinceLastMotion(now) {
  const events = await store.listEvents(new Date(now - 7 * 24 * 3600 * 1000).toISOString(), new Date(now + 1000).toISOString());
  const motion = events.filter((e) => e.type === 'motion_detected');
  if (!motion.length) return null;
  return Math.max(0, (now - Date.parse(motion[motion.length - 1].time)) / 3600000);
}

// Everything the Today page shows, in one call: doses, events, alerts, summary cards and wording.
app.get('/api/today', requirePassword, async (req, res) => {
  const settings = await store.getSettings();
  const now = Date.now();
  const { date, from, to } = dayBounds(now, settings.timezone);
  const events = await store.listEvents(from, to);
  const doses = evaluateDoses(settings, events, now);
  const alerts = await store.listAlerts(from, to);
  const resolvedKeys = new Set(alerts.filter((a) => a.resolvedAt).map((a) => a.key));
  const lastNear = [...events].reverse().find((e) => e.type === 'motion_detected' && e.deviceId === settings.cameraId);
  res.json({
    date,
    timezone: settings.timezone,
    cameraId: settings.cameraId,
    demoCamera: settings.cameraId === DEMO_CAMERA_ID,
    doses: doses.map((d) => (resolvedKeys.has(d.key) ? { ...d, checkedIn: true } : d)),
    events,
    alerts,
    summary: {
      doses: dosesSummary(doses.length, doses.filter((d) => d.status === 'likely_taken').length, doses.filter((d) => d.status === 'not_confirmed').length),
      alerts: alertsSummary(alerts.length, resolvedKeys.size),
      last: lastActivitySummary(lastNear ? clock(lastNear.time, settings.timezone) : null, true, settings.cameraId === DEMO_CAMERA_ID),
      house: houseStatus(await hoursSinceLastMotion(now), NO_MOTION_ALERT_HOURS)
    },
    statusLabels: STATUS_LABELS,
    footer: FOOTER_LINES
  });
});

// The last 7 days, one status per dose per day.
app.get('/api/week', requirePassword, async (req, res) => {
  const settings = await store.getSettings();
  const now = Date.now();
  const events = await store.listEvents(weekStartIso(now, settings.timezone), new Date(now + 1000).toISOString());
  res.json({ timezone: settings.timezone, demoCamera: settings.cameraId === DEMO_CAMERA_ID, days: evaluateWeek(settings, events, now), footer: FOOTER_LINES });
});

// Alerts sent in the last 30 days (the retention period), newest first, with the email text.
app.get('/api/alerts', requirePassword, async (req, res) => {
  const now = Date.now();
  const settings = await store.getSettings();
  const alerts = await store.listAlerts(new Date(now - 30 * 24 * 3600 * 1000).toISOString(), new Date(now + 1000).toISOString());
  res.json({ timezone: settings.timezone, alerts: alerts.reverse(), footer: FOOTER_LINES });
});

// Approved wording used by every dashboard page.
app.get('/api/wording', requirePassword, (req, res) => {
  res.json({ nav: NAV, privacy: PRIVACY_LINES, ui: UI, eventLabels: EVENT_LABELS, otherEventPrefix: OTHER_EVENT_PREFIX, demoCameraId: DEMO_CAMERA_ID, footer: FOOTER_LINES, statusLabels: STATUS_LABELS });
});

// Demo only: adds a motion event marked as a simulation at the chosen camera.
app.post('/api/simulate-motion', requirePassword, async (req, res) => {
  const { cameraId } = await store.getSettings();
  if (!cameraId) return res.status(400).json({ error: 'Choose a camera in Settings first' });
  const now = new Date();
  await store.addEvent({ id: `sim-${now.getTime()}`, time: now.toISOString(), type: 'motion_detected', deviceId: cameraId, simulated: true });
  res.json({ added: true });
});

app.delete('/api/simulated-events', requirePassword, async (req, res) => {
  res.json({ removed: await store.deleteSimulatedEvents() });
});

app.get('/', requirePassword, (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'dashboard.html'));
});

// Today's recorded events (time, type, device only).
app.get('/api/events', requirePassword, async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const to = req.query.to || new Date(Date.now() + 1000).toISOString();
  res.json({ events: await store.listEvents(from, to) });
});

app.get('/health', (req, res) => {
  const hoursSinceMotion = (Date.now() - lastMotionAt.getTime()) / 1000 / 60 / 60;
  res.json({
    lastMotionAt,
    hoursSinceMotion: hoursSinceMotion.toFixed(2),
    alertThresholdHours: NO_MOTION_ALERT_HOURS,
    alertTriggered: hoursSinceMotion >= NO_MOTION_ALERT_HOURS,
    alreadyAlerted
  });
});

app.post('/test/trigger-alert', requirePassword, async (req, res) => {
  try {
    const message = await generateAlertMessage(Number(req.body.hours || NO_MOTION_ALERT_HOURS));
    await sendAlertEmail(message);
    res.json({ sent: true, message });
  } catch (err) {
    res.status(500).json({ sent: false, error: err.message });
  }
});

if (require.main === module) {
  setInterval(checkAndAlert, 5 * 60 * 1000);
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => console.log(`Ring Med Watch listening on port ${PORT}`));
}

module.exports = { app, store, deps };
