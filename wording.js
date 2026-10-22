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

module.exports = { STATUS_LABELS, FOOTER_LINES, MISSED_SUBJECT, missedPrompt };
