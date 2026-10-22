// Storage layer. Only event time, type and source device are kept: no video, no images.
// The in-memory implementation is for local development and tests; a DynamoDB
// implementation with the same interface will replace it once the table is approved.

function createMemoryStore() {
  const events = [];
  const seen = new Set();
  let settings = { doses: [], windowMinutes: 60, cameraId: null };

  return {
    // Returns false if an event with the same id was already recorded (webhook retries).
    async addEvent(event) {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      events.push({ id: event.id, time: event.time, type: event.type, deviceId: event.deviceId });
      return true;
    },
    // fromIso inclusive, toIso exclusive; both ISO 8601 strings.
    async listEvents(fromIso, toIso) {
      return events
        .filter((e) => e.time >= fromIso && e.time < toIso)
        .sort((a, b) => a.time.localeCompare(b.time));
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
