# Ring Med Watch

A small caregiver app for Amazon Ring. A family caregiver picks the Ring camera that looks at the place where pills are kept and sets the dose times (for example 08:00 and 20:00). Ring Med Watch watches for motion events from that camera. If no activity is seen near the pills during a dose window, the caregiver gets a gentle email saying the dose was **possibly missed**.

Built for the Amazon "Build, Ship, Shape" Developer Hackathon, Ring track (caretaking use case), with AWS Bedrock and SES.

## Using the Ring Playground (no Ring device needed)

The Ring Playground can send test motion events with the real Ring v1.1 payload to `POST /webhooks/ring`. When `RING_HMAC_KEY` is set, only events signed by Ring (`X-Signature: sha256=<hex HMAC-SHA256 of the raw body>`) are accepted; anything else gets HTTP 401. Accepted events are stored as real events and shown in the dashboard timeline with a "Ring Playground event" label, unlike events from the demo button, which are labelled "Simulation". In Settings, the camera list shows devices seen in these events, so a Playground device can be chosen as the "camera near the pills" without linking a Ring account.

## What it can and cannot tell you

Motion near the pills does not prove a pill was taken, and no motion does not prove one was missed. Ring Med Watch only sees motion at one camera, so it never says "taken" or "missed" as a fact. The wording everywhere is "activity seen near the pills (not a confirmation)", "no activity seen near the pills - not confirmed" and "possibly missed".

It is not a medical device or a substitute for medical care. If you are worried about someone's health, contact their doctor or pharmacist. In an emergency, call your local emergency number.

## Privacy

- **No video and no images are stored.** The app never requests or downloads any camera footage.
- Only three facts about each Ring event are kept: **the time, the event type and which camera it came from**.
- Settings (dose times, labels, chosen camera, timezone) and a record of which alerts were sent are also kept, including the text of each alert email so the caregiver can preview it.
- Events and alert records are deleted automatically after **30 days** (DynamoDB TTL).
- Events from the "Simulate motion" demo button are marked as simulations and can be removed at any time.
- Server logs contain the event type and time, not the raw Ring payload.
- The dashboard and the settings API are protected by a password. The public endpoints are `/health` and the Ring webhook.
- Each alert email has a one-time "I checked in" link. Only a hash of its token is stored.
- Alert emails and the daily summary are written by Amazon Bedrock. The only information sent to the model is dose times, dose windows, and for the daily summary each dose's status and the number of alerts sent and checked in.

## Features

1. **Dose time windows.** Up to six dose times a day, a configurable window around each one (default 15 minutes before and 45 minutes after), and a choice of camera. Statuses: upcoming, dose window open, activity seen (not a confirmation), no activity seen (not confirmed).
2. **Caregiver dashboard** (`/`), a mobile-friendly app with five pages:
   - **Today:** summary cards (doses today, alerts sent, last activity, house status), each dose with its status, and a timeline of dose windows, motion events and alerts.
   - **Week:** a 7-day colour grid with "Activity seen" or "Not confirmed" for every dose window (past days use the current dose settings).
   - **Alerts:** history of alerts sent, with a preview of each email.
   - **Settings:** dose times with an optional name each (for example "Morning pills" - please no medicine names), camera, window and timezone.
   - **Privacy:** what is and is not stored.
   - A clearly labelled **Simulate motion (demo)** button adds a simulated motion event so the timeline can be shown filling in live, and "Remove simulated events" deletes only those. If no Ring camera is available, Settings always offers "Demo camera (simulation)" so the demo still works; it is labelled as a simulation wherever it appears, and no alert emails are sent while it is selected.
3. **Gentle "possibly missed" alerts** by email through AWS SES, written by Claude on Amazon Bedrock under strict instructions (calm, never certain, no medical advice, never suggests taking a dose late or changing any medicine, never names a medicine). If the AI call fails, a fixed text with the same meaning is sent instead. One alert per dose window.
4. **"I checked in" link.** Every missed-dose email ends with a one-time link. It opens a small page with a button (so mail scanners cannot resolve it by accident); pressing it marks the alert as checked in on the Alerts page and the Today cards. It needs no login, the token works once, and it never changes a dose status.
5. **Daily summary email** at 20:30 Europe/Bucharest (second Cloud Scheduler job): a short AI-written summary of the day's doses, alerts and check-ins, sent once a day, skipped when no dose times are set. If simulated events exist it adds "Note: today's data includes simulated events."
6. **Original no-motion alert.** If the front door camera sees no motion for a long time (default 12 hours), a check-in email is sent. See [Known limits](#known-limits).

## How it works

```
Ring camera -> Ring webhook -> POST /webhooks/ring -> DynamoDB (time, type, camera)
                                                             |
Cloud Scheduler (every 5 min) -> POST /internal/check-doses -+-> dose window ended with no
                                                                 motion at the chosen camera?
                                                                    |
                                          Bedrock (Claude Haiku) writes the message -> SES email
Caregiver browser -> / (dashboard) -> /api/today, /api/settings, /api/devices
```

- **Node.js / Express** on **Google Cloud Run**.
- **Ring API:** the webhook receives Ring v1.1 events (`motion_detected`), the Ring Devices API (`GET /v1/devices`, via `ring.js`) lists the cameras so the caregiver can choose one, and webhook signatures (`X-Signature`, HMAC-SHA256) are verified when `RING_HMAC_KEY` is set.
- **AWS Bedrock** (Claude Haiku 4.5) writes the alert text. **AWS SES** sends it. **Amazon DynamoDB** (one table, on-demand, 30-day TTL) stores events, settings and alerts.
- SMS is not used: it is blocked on the AWS account used for this project (see the friction log).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /webhooks/ring` | Ring (signature checked if `RING_HMAC_KEY` is set) | Receives Ring events |
| `GET /health` | public | Time since last motion, alert state |
| `GET /` | password | Caregiver dashboard |
| `GET /api/today` | password | Today's doses, events, alerts and the approved wording |
| `GET`/`PUT /api/settings` | password | Dose times, window, camera, timezone |
| `GET /api/week`, `GET /api/alerts`, `GET /api/wording` | password | Week grid, alert history with email text, approved wording |
| `POST /api/simulate-motion`, `DELETE /api/simulated-events` | password | Demo button: add / remove simulated motion events |
| `GET /api/devices` | password | Ring cameras on the linked account |
| `GET /api/events` | password | Recorded events (time, type, camera) |
| `POST /internal/check-doses` | password or `X-Cron-Token` | Checks dose windows and sends alerts (called by Cloud Scheduler) |
| `POST /internal/daily-summary` | password or `X-Cron-Token` | Sends the daily summary once a day (second Scheduler job) |
| `GET`/`POST /checkin?t=<token>` | one-time token in the link | "I checked in" confirm page |
| `POST /test/trigger-alert` | password | Sends a test email |

Password means HTTP Basic auth with any username and `DASHBOARD_PASSWORD`.

## Run it locally

```bash
npm install
cp .env.example .env   # or create .env by hand, see below
npm start              # http://localhost:8080
```

With no `STORAGE_BACKEND` set, data is kept in memory, so you can try everything locally without AWS or Ring credentials. Send fake Ring motion events with `node scripts/simulate-ring.js http://localhost:8080 <camera-id> 3`. Emails need real AWS credentials.

Run the tests (no AWS or Ring access needed): `npm test`.

## Environment variables

| Variable | Description |
|---|---|
| `ALERT_EMAIL` | Caregiver email, also the verified SES sender |
| `DASHBOARD_PASSWORD` | Password for the dashboard and the caregiver API |
| `TIMEZONE` | IANA timezone for dose times, e.g. `Europe/Bucharest` |
| `AWS_REGION` | Region for DynamoDB (Bedrock and SES use `us-east-1`) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | AWS credentials (Bedrock, SES, DynamoDB) |
| `STORAGE_BACKEND` | `dynamodb` to persist data; anything else keeps it in memory |
| `DYNAMODB_TABLE` | DynamoDB table name (keys `pk` and `sk`, TTL attribute `ttl`) |
| `PUBLIC_BASE_URL` | Public address of the service, used for the check-in link (falls back to the request host) |
| `CRON_TOKEN` | Secret the scheduler sends in `X-Cron-Token`; it only opens `/internal/check-doses` |
| `RING_CLIENT_ID`, `RING_CLIENT_SECRET`, `RING_REFRESH_TOKEN` | Ring API credentials for listing cameras |
| `RING_HMAC_KEY` | Optional. If set, webhook signatures are verified |
| `NO_MOTION_ALERT_HOURS` | Hours before the original no-motion alert (default 12) |

## Deploying

The live service runs on Cloud Run: https://ring-med-watch-30747896454.europe-west4.run.app (the dashboard asks for a password, `/health` is public).

1. Create a DynamoDB table with partition key `pk` (string), sort key `sk` (string), on-demand billing, and TTL enabled on the attribute `ttl`. The IAM user needs `GetItem`, `PutItem` and `Query` on that table.
2. Deploy with `gcloud run deploy ring-med-watch --source . --region <region>` and set the variables above.
3. Create two Cloud Scheduler jobs that send an HTTP POST with the `X-Cron-Token` header: `/internal/check-doses` every 5 minutes (`*/5 * * * *`), and `/internal/daily-summary` once a day (`30 20 * * *`, time zone `Europe/Bucharest`).
4. In the Ring developer console, set the app's webhook URL to `https://<your-service>/webhooks/ring`.

## What changed in this update

The first version (15 Sep 2026) had a single rule: no motion at the front door for 12 hours means one email. This update (22 Oct 2026) turns it into a caregiver app:

- medication time windows tied to a chosen Ring camera, with "possibly missed" alerts,
- the Ring Devices API call, webhook signature verification and parsing of the v1.1 payload,
- persistent storage in DynamoDB with automatic 30-day deletion (the first version kept its only timer in memory),
- a password-protected caregiver dashboard with a daily timeline and settings,
- scheduled checks through Cloud Scheduler,
- the privacy and wording rules above, with tests that pin the exact wording.

## Known limits

- Full Ring OAuth account linking is not built. Without a refresh token, the camera list uses devices seen in Ring (Playground) events instead of the Ring Devices API.
- Testing so far uses the Ring Playground sandbox and fake events, not a real camera at someone's home.
- The camera list (`GET /v1/devices`) and the token refresh are written from Ring's documentation and covered by unit tests with fakes. They have not yet been run against the live Ring API.
- The original 12-hour no-motion alert keeps its timer in memory and runs on a timer inside the server. On Cloud Run, which can scale to zero, it is not reliable. The dose-window checks do not have this problem because they run from Cloud Scheduler and store data in DynamoDB.
- One caregiver, one camera, one email address.
- A daily summary email is not built.

## Friction log

See [FRICTION_LOG.md](FRICTION_LOG.md).

## License

MIT
