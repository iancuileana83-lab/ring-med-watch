// Sends fake Ring v1.1 motion webhooks to a local server for development.
// Usage: node scripts/simulate-ring.js [baseUrl] [deviceId] [count]
const base = process.argv[2] || 'http://localhost:8080';
const deviceId = process.argv[3] || 'fake-pillbox-camera';
const count = Number(process.argv[4] || 1);

(async () => {
  for (let i = 0; i < count; i++) {
    const now = Date.now();
    const res = await fetch(`${base}/webhooks/ring`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meta: { version: '1.1', time: new Date(now).toISOString(), request_id: `sim-${now}-${i}`, account_id: 'fake-account' },
        data: { id: `sim-evt-${now}-${i}`, type: 'motion_detected', attributes: { source: deviceId, timestamp: now } }
      })
    });
    console.log(`event ${i + 1}/${count}: HTTP ${res.status}`);
  }
})();
