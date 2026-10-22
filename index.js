require('dotenv').config();
const express = require('express');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const { listDevices, verifySignature, parseWebhook } = require('./ring');
const { createMemoryStore } = require('./store');
const { createDynamoStore } = require('./store-dynamodb');
const { validateSettings, evaluateDoses, checkDoses, dayBounds } = require('./doses');
const { STATUS_LABELS, FOOTER_LINES, MISSED_SUBJECT, missedPrompt } = require('./wording');

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

async function generateText(prompt) {
  const command = new InvokeModelCommand({
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const response = await bedrock.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.content[0].text.trim();
}

async function sendAlertEmail(message, subject = 'Ring Med Watch Alert') {
  await ses.send(new SendEmailCommand({
    FromEmailAddress: ALERT_EMAIL,
    Destination: { ToAddresses: [ALERT_EMAIL] },
    Content: {
      Simple: {
        Subject: { Data: subject },
        Body: { Text: { Data: `${message}\n\n--\n${FOOTER_LINES.join('\n')}` } }
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

// Lists Ring cameras on the linked account (used to pick the camera near the pills).
app.get('/api/devices', requirePassword, async (req, res) => {
  try {
    res.json({ devices: await listDevices() });
  } catch (err) {
    res.status(502).json({ error: err.message });
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

// Called on a schedule (every few minutes). Throws if sending fails so the dose is retried.
async function notifyPossiblyMissed(dose) {
  const { timezone } = await store.getSettings();
  const local = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const message = await generateText(missedPrompt(dose.time, local(dose.windowStart), local(dose.windowEnd)));
  await sendAlertEmail(message, MISSED_SUBJECT);
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
    res.json(await checkDoses({ store, notify: notifyPossiblyMissed }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Everything the dashboard shows, in one call: today's doses, events, alerts and approved wording.
app.get('/api/today', requirePassword, async (req, res) => {
  const settings = await store.getSettings();
  const now = Date.now();
  const { date, from, to } = dayBounds(now, settings.timezone);
  const events = await store.listEvents(from, to);
  res.json({
    date,
    timezone: settings.timezone,
    cameraId: settings.cameraId,
    doses: evaluateDoses(settings, events, now),
    events,
    alerts: await store.listAlerts(from, to),
    statusLabels: STATUS_LABELS,
    footer: FOOTER_LINES
  });
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

module.exports = { app, store };
