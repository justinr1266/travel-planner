import { DEMO_PLAN, validateTripPlan } from './trip-parser.mjs';
import {PRICE_STORAGE_KEYS} from './price-test-mode.mjs';
import {resetPlanningSession} from './planning-reset.mjs';

const $ = id => document.getElementById(id);
const objectCount = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0;
const displayJSON = value => JSON.stringify(value ?? null, null, 2);
const setText = (id, value) => { $(id).textContent = String(value ?? '—'); };

async function refresh() {
  try {
    const saved = await chrome.storage.local.get([
      'routes', 'manualRoutes', 'broadCache', 'offers', 'roundTripTickets',
      'flightTimes', 'groundTimes', 'flightResearch', 'pendingFlightCapture',
      'parsedPlan', 'parseDebug', 'parseWarnings', 'parseSource', 'developerEvents', 'priceTestMode'
    ]);
    $('priceTestMode').checked = saved.priceTestMode === true;
    $('restartPriceImportTest').disabled = saved.priceTestMode !== true;
    setText('priceTestState', saved.priceTestMode ? 'ON · Prices are session-only' : 'OFF · Normal price saving');
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

$('priceTestMode').addEventListener('change', async event => {
  const enabled = event.target.checked;
  if(enabled && !confirm('Enable price import testing? This permanently clears locally stored imported flight estimates, saved fares, linked tickets, and reviewed flight details. Export any fares you need before continuing.')) {
    event.target.checked = false;
    return;
  }
  event.target.disabled = true;
  try {
    // Mode survives extension reloads, but prices and flight timings will not.
    // Never clear AI interpretation, suggestions, GTFS network, trip, or bag.
    await chrome.storage.local.set({priceTestMode:enabled});
    await chrome.storage.local.remove(PRICE_STORAGE_KEYS);
    setText('testOutput', enabled
      ? 'Price import test mode ON. Import progress, prices and flight timings reset. Candidate routes retained; start from the first flight. No Groq calls were made.'
      : 'Price import test mode OFF. Session prices cleared. Future imports will save normally.');
  } catch(error) {
    setText('testOutput', `Could not update price test mode: ${error.message}`);
  } finally {
    event.target.disabled = false;
    await refresh();
  }
});
$('restartPriceImportTest').addEventListener('click', async () => {
  if (!$('priceTestMode').checked) return;
  if (!confirm('Clear this price-import test and return to the first unresearched flight? The trip and candidate routes will remain, but all locally stored prices and flight times will be deleted.')) return;
  $('restartPriceImportTest').disabled = true;
  try {
    // Clear persistent price state even if the traveler panel is closed.
    // An open panel receives the request and resets its in-memory import UI.
    await chrome.storage.local.remove(PRICE_STORAGE_KEYS);
    await chrome.storage.local.set({priceImportResetRequest:crypto.randomUUID()});
    setText('testOutput', 'Price-import test reset requested. Keep your candidate routes and start importing from the first flight. No Groq call was made.');
  } catch (error) {
    setText('testOutput', `Could not reset price-import test: ${error.message}`);
  } finally {
    await refresh();
  }
});
$('resetPlanningSession').addEventListener('click', async () => {
  if (!confirm('Delete ALL saved routes, route comparisons, flight and train search results, fares, tickets, timing overrides and AI interpretation? Your trip description and bag profile will remain. This cannot be undone.')) return;
  const button=$('resetPlanningSession');
  button.disabled=true;
  try {
    await resetPlanningSession(chrome.storage.local);
    setText('testOutput','Full planning reset completed. The traveler panel will refresh to an empty results view. Your trip description and bag are preserved; no Groq or Google Maps API requests were made.');
  } catch(error) {
    setText('testOutput',`Could not reset planning session: ${error.message}`);
  } finally {
    button.disabled=false;
    await refresh();
  }
});
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
