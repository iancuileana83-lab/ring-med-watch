# Ring Med Watch

Motion-based caregiver alerts for Amazon Ring devices. Built for the Amazon "Build, Ship, Shape" Developer Hackathon (Ring track).

## The problem

Elderly or vulnerable people living alone are often checked on informally, if at all. Family caregivers want a lightweight, non-intrusive way to know something might be wrong, without cameras streaming 24/7 to their phone or expensive medical alert hardware.

## How it works

1. A Ring doorbell/camera reports motion events at the front door via a webhook.
2. Ring Med Watch tracks the time since the last detected motion.
3. If no motion is detected for a configurable threshold (default 12 hours), the app asks AWS Bedrock (Claude Haiku) to draft a short, calm, non-alarming message.
4. The message is sent to the caregiver by email via AWS SES.

No motion for too long doesn't necessarily mean an emergency, so the tone of the message is deliberately gentle: a nudge to check in, not a panic alert.

## Architecture

- **Node.js / Express** server exposing:
  - `POST /webhooks/ring` — receives Ring motion events
  - `GET /health` — current status (time since last motion, alert state)
  - `POST /test/trigger-alert` — manually trigger an alert for testing/demo
- **AWS Bedrock** (`claude-haiku-4-5`) drafts the caregiver message
- **AWS SES** delivers the message by email
- Deployed on **Google Cloud Run**

## Live demo

- Deployed app: https://ring-med-watch-30747896454.europe-west4.run.app
- Health check: https://ring-med-watch-30747896454.europe-west4.run.app/health

## Ring integration

The webhook parses Ring's real v1.1 payload format:

```json
{
  "meta": { "version": "1.1", "time": "...", "request_id": "...", "account_id": "..." },
  "data": {
    "type": "motion_detected",
    "attributes": { "source": "<device_id>", "timestamp": 1770989995231 }
  }
}
```

Tested against the Ring Developer Playground sandbox.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `ALERT_EMAIL` | Caregiver's email address (also used as verified SES sender) | - |
| `NO_MOTION_ALERT_HOURS` | Hours of no motion before an alert is generated | 12 |

## Running locally

```bash
npm install
node index.js
```

## Testing

```bash
curl -X POST http://localhost:8080/test/trigger-alert \
  -H "Content-Type: application/json" \
  -d '{"hours":13}'
```

## Future improvements

- Full Ring OAuth account linking (currently tested via Ring Playground sandbox)
- HMAC-SHA256 signature verification on incoming webhooks
- SMS delivery via AWS SNS/Pinpoint (currently blocked by an AWS account-level service subscription restriction, ticket open with AWS Support)
- Multiple caregiver contacts per household
