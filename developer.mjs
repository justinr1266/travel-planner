import { DEMO_PLAN, validateTripPlan } from './trip-parser.mjs';

const $ = id => document.getElementById(id);
const objectCount = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0;
const displayJSON = value => JSON.stringify(value ?? null, null, 2);
const setText = (id, value) => { $(id).textContent = String(value ?? '—'); };

async function refresh() {
  try {
    const saved = await chrome.storage.local.get([
      'routes', 'manualRoutes', 'broadCache', 'offers', 'roundTripTickets',
      'flightTimes', 'groundTimes', 'flightResearch', 'pendingFlightCapture',
      'parsedPlan', 'parseDebug', 'parseWarnings', 'parseSource', 'developerEvents'
    ]);
    const dbg = saved.parseDebug || {};
    const routeCount = (Array.isArray(saved.routes) ? saved.routes.length : 0) +
      (Array.isArray(saved.manualRoutes) ? saved.manualRoutes.length : 0);
    setText('routeCount', routeCount);
    setText('cachedSearches', objectCount(saved.broadCache));
    setText('verifiedFares', objectCount(saved.offers));
    setText('linkedTickets', objectCount(saved.roundTripTickets));
    setText('flightTimes', objectCount(saved.flightTimes));
    setText('groundTimes', objectCount(saved.groundTimes));
    setText('flightResearch', objectCount(saved.flightResearch));
    setText('pendingCapture', saved.pendingFlightCapture?.text ? 'Yes' : 'No');

    setText('aiState', saved.parsedPlan ? (saved.parseSource === 'ai' ? 'AI result saved' : 'Non-AI preview') : 'No data');
    setText('aiModel', dbg.model || '—');
    setText('referenceDate', dbg.referenceDate || '—');
    setText('groqTiming', Number.isFinite(dbg.timingMs?.groqRequest) ? `${dbg.timingMs.groqRequest} ms` : '—');
    setText('serverTiming', Number.isFinite(dbg.timingMs?.totalServer) ? `${dbg.timingMs.totalServer} ms` : '—');
    setText('dateEvidence', displayJSON(dbg.dateEvidence || []));
    setText('corrections', displayJSON(dbg.corrections || []));
    setText('clientCorrections', displayJSON(dbg.clientCorrections || []));
    setText('rawGroq', dbg.rawModel ? displayJSON(dbg.rawModel) : 'No raw Groq object saved.');
    setText('normalizedPlan', saved.parsedPlan ? displayJSON(saved.parsedPlan) : 'No interpreted plan saved.');
    setText('planWarnings', displayJSON(saved.parseWarnings || []));

    const cache = saved.broadCache && typeof saved.broadCache === 'object' ? saved.broadCache : {};
    setText('researchDetails', displayJSON({
      searches:Object.entries(cache).map(([key, record])=>({
        key, optionCount:Array.isArray(record?.options) ? record.options.length : 0,
        capturedAt:record?.capturedAt || null
      })),
      pendingCapture:saved.pendingFlightCapture?.text ? {
        capturedAt:saved.pendingFlightCapture.capturedAt || null,
        sourceUrl:saved.pendingFlightCapture.sourceUrl || null,
        textLength:saved.pendingFlightCapture.text.length
      } : null
    }));

    const log = $('eventLog');
    log.replaceChildren();
    const events = Array.isArray(saved.developerEvents) ? saved.developerEvents : [];
    if (!events.length) { log.textContent = 'No activity recorded yet.'; }
    for (const entry of events.slice(-50).reverse()) {
      const row = document.createElement('div');
      row.className = 'event-row';
      const time = document.createElement('time');
      time.textContent = entry.time ? new Date(entry.time).toLocaleString() : '—';
      const message = document.createElement('span');
      message.textContent = entry.message || '';
      row.append(time, message);
      log.append(row);
    }
    setText('consoleStatus', `Updated ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setText('consoleStatus', `Could not load diagnostics: ${error.message}`);
  }
}

$('refresh').addEventListener('click', () => void refresh());
$('clearEvents').addEventListener('click', async () => {
  await chrome.storage.local.remove('developerEvents');
  await refresh();
});
$('sampleParse').addEventListener('click', () => {
  try {
    const result = validateTripPlan(DEMO_PLAN);
    setText('testOutput', displayJSON({
      test:'Sample trip validation',
      result:'Completed without changing the traveler panel',
      normalizedPlan:result.plan,
      warnings:result.warnings
    }));
  } catch (error) {
    setText('testOutput', `Sample validation failed: ${error.message}`);
  }
});
$('domDemo').addEventListener('click', async () => {
  try {
    await chrome.tabs.create({url:chrome.runtime.getURL('demo-results.html')});
    setText('testOutput', 'Opened the existing flight-card DOM demo in a new tab.');
  } catch (error) {
    setText('testOutput', `Could not open demo: ${error.message}`);
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(key => key !== 'developerEvents')) void refresh();
  else if (area === 'local' && changes.developerEvents) void refresh();
});
void refresh();
