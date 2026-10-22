// Dose-window logic. Motion near the pills is only a hint, never proof of a dose:
// statuses are "likely_taken" / "not_confirmed", and callers must word them that way.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function offsetMs(utcMs, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// "2026-10-22" + "08:00" in tz -> UTC milliseconds.
function zonedToUtcMs(dateStr, hhmm, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

function localDate(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function nextDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// ISO bounds [start, end) of the local day containing `now`.
function dayBounds(now, tz) {
  const date = localDate(now, tz);
  return {
    date,
    from: new Date(zonedToUtcMs(date, '00:00', tz)).toISOString(),
    to: new Date(zonedToUtcMs(nextDate(date), '00:00', tz)).toISOString()
  };
}

// Throws on invalid input; returns the cleaned settings patch.
function validateSettings(input) {
  const out = {};
  if (input.doses !== undefined) {
    if (!Array.isArray(input.doses) || input.doses.length > 6) throw new Error('doses must be a list of at most 6 times');
    const items = input.doses.map((d) => (typeof d === 'string' ? { time: d } : { time: d?.time, label: d?.label }));
    if (!items.every((d) => TIME_RE.test(d.time))) throw new Error('each dose time must look like 08:00');
    if (!items.every((d) => d.label === undefined || d.label === null || (typeof d.label === 'string' && d.label.trim().length <= 30))) {
      throw new Error('a dose name can be at most 30 characters');
    }
    const byTime = new Map();
    for (const d of items) if (!byTime.has(d.time)) byTime.set(d.time, d.label ? d.label.trim() : '');
    out.doses = [...byTime.keys()].sort().map((time) => ({ time, label: byTime.get(time) }));
  }
  for (const k of ['windowBeforeMinutes', 'windowAfterMinutes']) {
    if (input[k] !== undefined) {
      if (!Number.isInteger(input[k]) || input[k] < 0 || input[k] > 180) throw new Error(`${k} must be a whole number from 0 to 180`);
      out[k] = input[k];
    }
  }
  if (input.cameraId !== undefined) {
    if (input.cameraId !== null && (typeof input.cameraId !== 'string' || !input.cameraId || input.cameraId.length > 200)) throw new Error('cameraId must be a device id or null');
    out.cameraId = input.cameraId;
  }
  if (input.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }); } catch { throw new Error('timezone is not a valid IANA name'); }
    out.timezone = input.timezone;
  }
  return out;
}

// Status of each configured dose today, from motion events at the chosen camera.
function evaluateDoses(settings, events, nowMs) {
  const tz = settings.timezone;
  const { date } = dayBounds(nowMs, tz);
  return settings.doses.map(({ time, label }) => {
    const doseMs = zonedToUtcMs(date, time, tz);
    const startMs = doseMs - settings.windowBeforeMinutes * 60000;
    const endMs = doseMs + settings.windowAfterMinutes * 60000;
    const motion = events.filter((e) =>
      e.type === 'motion_detected' && e.deviceId === settings.cameraId &&
      Date.parse(e.time) >= startMs && Date.parse(e.time) <= endMs);
    let status;
    if (!settings.cameraId) status = 'no_camera';
    else if (motion.length) status = 'likely_taken';
    else if (nowMs < startMs) status = 'upcoming';
    else if (nowMs <= endMs) status = 'in_window';
    else status = 'not_confirmed';
    return {
      key: `${date}T${time}`,
      time,
      label: label || '',
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      motionCount: motion.length,
      status
    };
  });
}

// Alerts once per dose whose window ended with no motion. `notify(dose)` sends the message
// and must throw on failure so the dose is retried on the next check.
async function checkDoses({ store, notify, nowMs = Date.now() }) {
  const settings = await store.getSettings();
  const { from, to } = dayBounds(nowMs, settings.timezone);
  const doses = evaluateDoses(settings, await store.listEvents(from, to), nowMs);
  const alerted = [];
  for (const dose of doses.filter((d) => d.status === 'not_confirmed')) {
    if ((await store.listAlerts(from, to)).some((a) => a.key === dose.key)) continue;
    const sent = await notify(dose); // may return { subject, message } so the dashboard can preview the email
    await store.recordAlert(dose.key, { sentAt: new Date(nowMs).toISOString(), doseTime: dose.time, ...(sent || {}) });
    alerted.push(dose.key);
  }
  return { doses, alerted };
}

function prevDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// The last `days` local days (today included) with each dose's status, oldest first.
// Past days are judged at the end of that day with the current settings.
function evaluateWeek(settings, events, nowMs, days = 7) {
  const tz = settings.timezone;
  const dates = [];
  for (let date = localDate(nowMs, tz); dates.length < days; date = prevDate(date)) dates.unshift(date);
  const today = dates[dates.length - 1];
  return dates.map((date) => {
    const at = date === today ? nowMs : zonedToUtcMs(nextDate(date), '00:00', tz) - 1;
    return { date, doses: evaluateDoses(settings, events, at) };
  });
}

// ISO start of the oldest day shown by evaluateWeek.
function weekStartIso(nowMs, tz, days = 7) {
  let date = localDate(nowMs, tz);
  for (let i = 1; i < days; i++) date = prevDate(date);
  return new Date(zonedToUtcMs(date, '00:00', tz)).toISOString();
}

module.exports = { zonedToUtcMs, dayBounds, validateSettings, evaluateDoses, evaluateWeek, weekStartIso, checkDoses };
