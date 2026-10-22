// Daily summary email: gathers today's facts, asks the AI writer (or uses the fixed text), sends once.
const { evaluateDoses, dayBounds, isTestAlert } = require('./doses');
const { summaryPrompt, summaryFallback, SIMULATED_NOTE } = require('./wording');

// generate(prompt) -> text; send(message, extraLines) -> sends the email. Both are injected so this is testable.
async function runDailySummary({ store, generate, send, nowMs = Date.now() }) {
  const settings = await store.getSettings();
  if (!settings.doses.length) return { skipped: 'no doses' };

  const { date, from, to } = dayBounds(nowMs, settings.timezone);
  if (!(await store.claimDaily(date))) return { skipped: 'already sent' };

  try {
    const events = await store.listEvents(from, to);
    const alerts = (await store.listAlerts(from, to)).filter((a) => !isTestAlert(a));
    const facts = {
      doses: evaluateDoses(settings, events, nowMs).map(({ time, status }) => ({ time, status })),
      alertsSent: alerts.length,
      checkedIn: alerts.filter((a) => a.resolvedAt).length
    };

    let message;
    try {
      message = await generate(summaryPrompt(facts));
    } catch (err) {
      console.error('AI summary failed, using the fixed text:', err.message);
      message = summaryFallback(facts);
    }

    const simulated = events.some((e) => e.simulated);
    await send(message, simulated ? [SIMULATED_NOTE] : []);
    return { sent: true, date, simulated };
  } catch (err) {
    await store.releaseDaily(date); // let the next call retry
    throw err;
  }
}

module.exports = { runDailySummary };
