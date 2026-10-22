// Storage layer. Only event time, type and source device are kept: no video, no images.
// The in-memory implementation is for local development and tests; store-dynamodb.js has the
// same interface and is used in production.

function createMemoryStore() {
  let events = [];
  const seen = new Set();
  const alerts = new Map();
  let settings = {
    doses: [],
    windowBeforeMinutes: 15,
    windowAfterMinutes: 45,
    cameraId: null,
    timezone: process.env.TIMEZONE || 'UTC'
  };

  return {
    // Returns false if an event with the same id was already recorded (webhook retries).
    // `simulated: true` marks events created by the demo button.
    async addEvent(event) {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      events.push({
        id: event.id, time: event.time, type: event.type, deviceId: event.deviceId,
        ...(event.simulated ? { simulated: true } : {})
      });
      return true;
    },
    // fromIso inclusive, toIso exclusive; both ISO 8601 strings.
    async listEvents(fromIso, toIso) {
      return events
        .filter((e) => e.time >= fromIso && e.time < toIso)
        .map((e) => ({ ...e }))
        .sort((a, b) => a.time.localeCompare(b.time));
    },
    // Removes only demo events; returns how many were removed.
    async deleteSimulatedEvents() {
      const removed = events.filter((e) => e.simulated);
      events = events.filter((e) => !e.simulated);
      removed.forEach((e) => seen.delete(e.id));
      return removed.length;
    },
    // One alert per dose window; returns false if this key was already alerted.
    async recordAlert(key, alert) {
      if (alerts.has(key)) return false;
      alerts.set(key, { key, ...alert });
      return true;
    },
    async listAlerts(fromIso, toIso) {
      return [...alerts.values()]
        .filter((a) => a.sentAt >= fromIso && a.sentAt < toIso)
        .map((a) => ({ ...a }))
        .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    },
    async getSettings() {
      return { ...settings };
    },
    async saveSettings(next) {
      settings = { ...settings, ...next };
      return { ...settings };
    }
  };
}

module.exports = { createMemoryStore };
