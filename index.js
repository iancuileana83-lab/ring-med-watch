require('dotenv').config();
const express = require('express');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const app = express();
app.use(express.json());

const NO_MOTION_ALERT_HOURS = Number(process.env.NO_MOTION_ALERT_HOURS || 12);
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'maziluileana88@gmail.com';

let lastMotionAt = new Date();
let alreadyAlerted = false;

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const ses = new SESv2Client({ region: 'us-east-1' });

async function generateAlertMessage(hoursSinceMotion) {
  const prompt = `Write a short, calm, non-alarming message (max 300 characters) to a family caregiver. No motion has been detected at their relative's front door for ${hoursSinceMotion.toFixed(1)} hours. Ask them to check in. Do not sound like an emergency. Sign it "- Ring Med Watch".`;

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

async function sendAlertEmail(message) {
  await ses.send(new SendEmailCommand({
    FromEmailAddress: ALERT_EMAIL,
    Destination: { ToAddresses: [ALERT_EMAIL] },
    Content: {
      Simple: {
        Subject: { Data: 'Ring Med Watch Alert' },
        Body: { Text: { Data: message } }
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

app.post('/webhooks/ring', (req, res) => {
  const event = req.body;
  console.log('Received Ring event:', JSON.stringify(event));

  const eventType = event?.data?.type || event?.type;

  if (eventType === 'motion_detected') {
    lastMotionAt = new Date();
    alreadyAlerted = false;
    console.log('Motion detected at', lastMotionAt.toISOString());
  }

  res.status(200).send('OK');
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

app.post('/test/trigger-alert', async (req, res) => {
  try {
    const message = await generateAlertMessage(Number(req.body.hours || NO_MOTION_ALERT_HOURS));
    await sendAlertEmail(message);
    res.json({ sent: true, message });
  } catch (err) {
    res.status(500).json({ sent: false, error: err.message });
  }
});

setInterval(checkAndAlert, 5 * 60 * 1000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ring Med Watch listening on port ${PORT}`));
