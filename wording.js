// All medicine- and health-related text shown to users lives here, so it can be reviewed in one place.
// Every string below was approved by the caregiver (project owner) before being added.

const STATUS_LABELS = {
  likely_taken: 'Activity seen near the pills (not a confirmation)',
  not_confirmed: 'No activity seen near the pills - not confirmed',
  in_window: 'Dose window open',
  upcoming: 'Upcoming',
  no_camera: 'Choose a camera to start'
};

const FOOTER_LINES = [
  'Ring Med Watch only sees motion at one camera. It cannot tell whether medicine was taken, and it is not a medical device or a substitute for medical care.',
  'No video or images are stored. Only the time, type and camera of each motion event are kept.',
  "If you are worried about someone's health, contact their doctor or pharmacist. In an emergency, call your local emergency number."
];

const MISSED_SUBJECT = 'Ring Med Watch: dose possibly missed';

// Added to both AI prompts (approved by the caregiver).
const PLAIN_TEXT_RULE = "Write plain text only, with no markdown, asterisks or bold. Always say 'possibly missed', never 'skipped', 'forgot' or any word that sounds certain.";

function missedPrompt(doseTime, windowStart, windowEnd) {
  return `Write a short, calm message (max 300 characters) to a family caregiver. No motion was seen near the pill area between ${windowStart} and ${windowEnd}, so the ${doseTime} dose was possibly missed. Motion does not prove a pill was taken, and no motion does not prove it was missed. Gently ask them to check in. Never say the dose was definitely missed. Do not give medical advice. Never suggest taking the dose late, taking a double dose or changing any medicine, and never name a medicine; only suggest checking in with the person. ${PLAIN_TEXT_RULE} Sign it "- Ring Med Watch".`;
}

const NAV = ['Today', 'Week', 'Alerts', 'Settings', 'Privacy'];

const PRIVACY_LINES = [
  'No video and no images are stored. The app never requests or downloads any camera footage.',
  'Only three facts about each Ring event are kept: the time, the event type and which camera it came from.',
  'Settings (dose times, labels, chosen camera, timezone) and a record of which alerts were sent are also kept, including the text of each alert email so you can preview it.',
  'Events and alert records are deleted automatically after 30 days.',
  'Events from the "Simulate motion" demo button are marked as simulations and can be removed at any time.',
  'The dashboard and the settings are protected by a password.',
  'A Ring Playground token, if you paste one, is kept only in memory for 30 minutes and is never stored or logged.',
  'Each alert email has a one-time check-in link. Only a hash of its token is stored.',
  "Alert emails and the daily summary are written by Amazon Bedrock. The only information sent to the model is dose times, dose windows, and for the daily summary each dose's status and the number of alerts sent and checked in."
];

const UI = {
  cards: { doses: 'Doses today', alerts: 'Alerts sent', last: 'Last activity', house: 'House status' },
  alertsNote: 'Alerts only say a dose was possibly missed. They cannot confirm it.',
  alertsEmpty: 'No alerts sent yet.',
  emailPreview: 'Email preview',
  weekNotes: ['This shows motion near the pills, not whether medicine was taken.', 'Past days use your current dose settings.'],
  weekLegend: { likely_taken: 'Activity seen', not_confirmed: 'Not confirmed', upcoming: 'Upcoming', not_set: 'Not set' },
  simulate: {
    button: 'Simulate motion (demo)',
    banner: 'Demo: this adds a simulated motion event, not a real Ring event.',
    badge: 'Simulation',
    clear: 'Remove simulated events'
  },
  // PROPOSED wording for real Ring (Playground) events and camera list, pending approval.
  ringEventBadge: 'Ring Playground event',
  // PROPOSED wording for the Ring Playground token and Fetch Ring events, pending approval.
  token: {
    heading: 'Ring Playground token',
    hint: 'Paste the temporary token from the Ring Playground. It is kept only in memory for 30 minutes and is never shown or logged.',
    connect: 'Connect',
    notConnected: 'Not connected',
    expired: 'Token expired',
    connectedUntil: 'Connected to Ring Playground until',
    fetch: 'Fetch Ring events',
    needToken: 'Connect a Ring Playground token first',
    needCamera: 'Choose a Ring camera in Settings first',
    none: 'No new events.',
    cameraHintExpired: 'The Ring Playground token expired. Paste a new one to refresh the camera list.',
    cameraHintRejected: 'Ring rejected the token. Paste a new one to refresh the camera list.',
    cameraHintError: 'The Ring camera list could not be loaded. Devices seen in Ring Playground events are listed instead.'
  },
  cameraHintNotLinked: 'The Ring camera list is not linked. Devices seen in Ring Playground events are listed instead.',
  cameraHintNoneSeen: 'No Ring Playground device seen yet. Send a test motion event from the Playground, then reload this page.',
  testEmail: 'Test email',
  testEmailSent: (doseTime) => `Test email sent for the ${doseTime} dose`,
  checkedIn: 'Checked in',
  checkedInAt: 'Checked in at',
  notCheckedIn: 'Not checked in yet',
  labelHint: 'Optional name for this dose, like Morning pills. Please do not enter medicine names.',
  demoCamera: 'Demo camera (simulation)'
};

// Timeline labels for Ring event types. Only 'motion_detected' counts for dose checks and house status.
const EVENT_LABELS = { motion_detected: 'Motion', on_demand: 'Live view opened (Ring Playground)' };
const OTHER_EVENT_PREFIX = 'Ring event';

// Message after "Fetch Ring events". counts: { motion, liveView, other } = newly added events by kind.
function fetchResultText({ motion = 0, liveView = 0, other = 0 }) {
  const total = motion + liveView + other;
  if (!total) return UI.token.none;
  const noun = `new Ring ${total === 1 ? 'event' : 'events'} added`;
  const notMotion = liveView + other;
  if (!notMotion) return `${total} ${noun}.`;
  const why = liveView && !other ? 'live view, not counted as motion' : 'not counted as motion';
  if (!motion) return `${total} ${noun} (${why}).`;
  return `${total} ${noun} (${motion} motion, ${notMotion} not counted as motion).`;
}

function seenDeviceName(id) {
  return `Ring Playground device (${String(id).slice(-6)})`;
}

function dosesSummary(scheduled, seen, notConfirmed) {
  return `${scheduled} scheduled · ${seen} activity seen · ${notConfirmed} not confirmed`;
}

function alertsSummary(count, checkedIn = 0) {
  return `${count} today · ${checkedIn} checked in`;
}

function lastActivitySummary(time, atChosenCamera, isDemoCamera = false) {
  if (!time) return 'No activity yet today';
  if (isDemoCamera) return `${time} at the demo camera (simulation)`;
  return `${time} at ${atChosenCamera ? 'the camera near the pills' : 'another camera'}`;
}

// hoursSinceMotion: number, or null when no motion is on record.
function houseStatus(hoursSinceMotion, thresholdHours) {
  if (hoursSinceMotion === null) return { level: 'no_data', text: 'No motion data yet' };
  if (hoursSinceMotion >= thresholdHours) {
    return { level: 'quiet', text: `No motion for ${Math.floor(hoursSinceMotion)} hours - maybe check in` };
  }
  if (hoursSinceMotion < 1) return { level: 'normal', text: 'Motion seen less than an hour ago' };
  const h = Math.floor(hoursSinceMotion);
  return { level: 'normal', text: `Motion seen ${h} ${h === 1 ? 'hour' : 'hours'} ago` };
}

// "I checked in" link: text in the alert email and on the public confirm page.
const CHECKIN = {
  emailLine: (link) => `Checked in with them? Let the dashboard know: ${link}`,
  heading: 'Checking in',
  question: (doseTime) => `Did you check in with them about the ${doseTime} dose?`,
  button: 'I checked in',
  disclaimer: 'This does not confirm that medicine was taken.',
  thanks: 'Thank you. This alert is now marked as checked in.',
  already: 'This alert was already marked as checked in.',
  invalid: 'This link is not valid or has expired.',
  resolvedLabel: (time) => `Checked in at ${time}`
};

// Daily summary email.
// Alerts raised from the Demo camera are real emails but clearly marked as simulated.
// PROPOSED wording, pending the caregiver's approval.
const DEMO_ALERT_SUFFIX = ' (simulation)';
const DEMO_ALERT_NOTE = 'Note: this alert is based on the demo camera, so the data is simulated.';

const SUMMARY_SUBJECT = 'Ring Med Watch: daily summary';
const SIMULATED_NOTE = "Note: today's data includes simulated events.";

const FACT_PHRASES = {
  likely_taken: 'activity seen near the pills',
  not_confirmed: 'not confirmed',
  in_window: 'dose window still open',
  upcoming: 'dose window not open yet',
  no_camera: 'no camera chosen'
};

// facts: { doses: [{ time, status }], alertsSent, checkedIn }
function summaryFactsText(facts) {
  const doseLines = facts.doses.map((d) => `Dose ${d.time}: ${FACT_PHRASES[d.status]}`).join('; ');
  return `${doseLines}. ${facts.alertsSent} alert emails sent, ${facts.checkedIn} checked in`;
}

function summaryPrompt(facts) {
  return `Write a short, calm daily summary (max 500 characters) for a family caregiver, using only these facts: ${summaryFactsText(facts)}. For each dose say whether activity was seen near the pills or was not confirmed, or whether the dose window is still open. Mention how many alert emails were sent and how many were checked in. Never say a dose was definitely taken or definitely missed. Do not give medical advice. Never suggest taking a dose late, taking a double dose or changing any medicine, and never name a medicine. ${PLAIN_TEXT_RULE} Sign it "- Ring Med Watch".`;
}

function summaryFallback(facts) {
  const seen = facts.doses.filter((d) => d.status === 'likely_taken').length;
  const notConfirmed = facts.doses.filter((d) => d.status === 'not_confirmed').length;
  return `Today: ${facts.doses.length} doses scheduled, ${seen} with activity seen near the pills, ${notConfirmed} not confirmed. ${facts.alertsSent} alert emails sent, ${facts.checkedIn} checked in. This is only a motion sensor and cannot tell whether medicine was taken. - Ring Med Watch`;
}

// Used only if the AI writer is unavailable, so a possibly-missed dose is still reported.
function missedFallback(doseTime, windowStart, windowEnd) {
  return `No activity was seen near the pills between ${windowStart} and ${windowEnd}, so the ${doseTime} dose was possibly missed. This is only a motion sensor and cannot tell whether medicine was taken. Please check in with the person. - Ring Med Watch`;
}

module.exports = {
  STATUS_LABELS, FOOTER_LINES, MISSED_SUBJECT, missedPrompt, missedFallback,
  CHECKIN, DEMO_ALERT_SUFFIX, DEMO_ALERT_NOTE, SUMMARY_SUBJECT, SIMULATED_NOTE, summaryFactsText, summaryPrompt, summaryFallback,
  NAV, PRIVACY_LINES, UI, EVENT_LABELS, OTHER_EVENT_PREFIX, fetchResultText, seenDeviceName, dosesSummary, alertsSummary, lastActivitySummary, houseStatus
};
