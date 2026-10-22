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

function missedPrompt(doseTime, windowStart, windowEnd) {
  return `Write a short, calm message (max 300 characters) to a family caregiver. No motion was seen near the pill area between ${windowStart} and ${windowEnd}, so the ${doseTime} dose was possibly missed. Motion does not prove a pill was taken, and no motion does not prove it was missed. Gently ask them to check in. Never say the dose was definitely missed. Do not give medical advice. Never suggest taking the dose late, taking a double dose or changing any medicine, and never name a medicine; only suggest checking in with the person. Sign it "- Ring Med Watch".`;
}

const NAV = ['Today', 'Week', 'Alerts', 'Settings', 'Privacy'];

const PRIVACY_LINES = [
  'No video and no images are stored. The app never requests or downloads any camera footage.',
  'Only three facts about each Ring event are kept: the time, the event type and which camera it came from.',
  'Settings (dose times, labels, chosen camera, timezone) and a record of which alerts were sent are also kept, including the text of each alert email so you can preview it.',
  'Events and alert records are deleted automatically after 30 days.',
  'Events from the "Simulate motion" demo button are marked as simulations and can be removed at any time.',
  'The dashboard and the settings are protected by a password.',
  'Alert emails are written by Amazon Bedrock. The only information sent to the model is the dose time and the dose window.'
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
  labelHint: 'Optional name for this dose, like Morning pills. Please do not enter medicine names.'
};

function dosesSummary(scheduled, seen, notConfirmed) {
  return `${scheduled} scheduled · ${seen} activity seen · ${notConfirmed} not confirmed`;
}

function alertsSummary(count) {
  return `${count} today`;
}

function lastActivitySummary(time, atChosenCamera) {
  if (!time) return 'No activity yet today';
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

// Used only if the AI writer is unavailable, so a possibly-missed dose is still reported.
function missedFallback(doseTime, windowStart, windowEnd) {
  return `No activity was seen near the pills between ${windowStart} and ${windowEnd}, so the ${doseTime} dose was possibly missed. This is only a motion sensor and cannot tell whether medicine was taken. Please check in with the person. - Ring Med Watch`;
}

module.exports = {
  STATUS_LABELS, FOOTER_LINES, MISSED_SUBJECT, missedPrompt, missedFallback,
  NAV, PRIVACY_LINES, UI, dosesSummary, alertsSummary, lastActivitySummary, houseStatus
};
