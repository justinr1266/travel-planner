import { AIRPORTS, airportName, rankRoutes, normalizedOffer } from './core.mjs';
import {rankItineraryComparisons,rankingExplanation} from './itinerary-recommendations.mjs';
import {PRICE_STORAGE_KEYS, persistableSession} from './price-test-mode.mjs';
import { generatePlannedRoutes } from './route-engine.mjs';
import { validateTripPlan, normalizeTripWithDiagnostics } from './trip-parser.mjs';
import { applyPlanToForm } from './plan-ui.mjs';
import { updateAirportSelect } from './airport-select.mjs';
import { protectReviewedTrip } from './trip-consistency.mjs';
import { googleFlightsRoundTripUrl, findRoundTripPairs } from './search-links.mjs';
import {TRAVEL_MODES, TERMINAL_KINDS, modeLabel, draftFromRoute, insertedTransfer, buildManualRoute, manualRouteForTrip} from './multimodal.mjs';
import {transportSearch} from './transport-links.mjs';
import {expandRoutesWithGround} from './ground-routes.mjs';
import {connectionWindows,validatedFlightTime,validatedGroundTime} from './connection-windows.mjs';
import {connectionPanelData,connectionOverview} from './connection-view.mjs';
import {parseFlightSelection,buildReviewedFlight} from './flight-research.mjs';
import {parseGoogleFlightsSearchResults,searchOptionMatchesLeg,sameExactGoogleFlightsSearch} from './google-flights-search.mjs';
import {parseGoogleFlightsPage} from './google-flights-text.mjs';
import {roundTripQuoteChoices} from './roundtrip-quote-options.mjs';
import {researchTasks,researchKey,captureBroadSearch,captureFromOpenedOneWaySearch,researchAge,compareBroadRoutes,TRAIN_ESTIMATE_EUR} from './broad-research.mjs';
import {googleFlightsSearchUrl} from './search-links.mjs';
import {runFlightImportQueue} from './research-queue.mjs';
import {runBestRouteWorkflow} from './best-routes-workflow.mjs';
import {excludeUnavailableFlightRoutes,hasNoFlightsResult} from './flight-availability.mjs';
import {trainResearchTasks,trainResearchKey,trainSearchUrl,parseTrainCapture,checkedTrainQuote,automaticTrainSearchEvidence,indicativeTrainQuote} from './train-research.mjs';
import {waitForStableTrainResults} from './train-import-readiness.mjs';
import {suggestedTransferTime,localTransitTimeToISO,validDatedTransitResult,routeTransferQuoteKey} from './google-ground-routes.mjs';
import {ticketKey,pairedFlightLegs,pairContainingLeg,matchingTicketSelection,matchingTicketsForRoute,ticketsUsingLeg,replaceTicketsForPair,buildRoundTripTicket} from './roundtrip-tickets.mjs';

const $ = (id) => document.getElementById(id);
// Reset listener stays independent of flight and train import event handlers.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.planningResetRequest?.newValue) return;
  window.location.reload();
});

const DEFAULT_TRIP = {
  origin:'BCN', preferred:'SPC', destination:'MAD', requestedRegion:'Canary Islands', destinationSearch:'specified',
  startDate:'2027-02-02', endDate:'2027-02-10',
  goal:'more_time_at_preferred', arrivalRule:'by', connectionBuffer:'180',
  request:'Barcelona to the Canary Islands, preferably La Palma, ending in Madrid. Leave Barcelona February 2–4, 2027, and arrive in Madrid by February 10, 2027. One overhead cabin bag.'
};
const DEFAULT_BAG = {name:'Overhead backpack',length:55,width:35,depth:23,kg:8};
let trip = structuredClone(DEFAULT_TRIP);
let bag = structuredClone(DEFAULT_BAG);
let offers = {};
let roundTripTickets = {}; // One combined EUR booking covers two opposite flight legs
let flightTimes = {}; // Saved departure times without requiring a fare
let groundTimes = {}; // Ground arrivals from a user-checked timetable, without requiring a fare
let groundQuotes = {}; // Google transit responses are ephemeral; never stored in Chrome local storage.
const GOOGLE_ROUTES_ENABLED=false; // Temporary: never call billable Routes API.
let trainCache = {}; // User-checked, indicative rail-search quotes, not booked tickets.
let trainCapture = null;
let trainTaskKey = null;
let trainResearchTabId = null;
let trainImportBusy = false;
let trainBatchBusy = false;
let trainBatchStop = false;
let groundLookupBusy = false;
let flightResearch = {}; // User-reviewed flight metadata, keyed to an exact flight leg
let broadCache = {}; // Indicative one-way Best-tab results, never checked fares
let unavailableFlights = {}; // User-confirmed or explicitly proved empty exact searches; import errors never count.
let priceTestMode = false; // Developer-only: discard prices across panel reloads and extension updates.
let activeResearchKey = null; // Explicit user-selected search task
let pendingFlightCapture = null; // Selection sent via explicit browser context-menu action
let importLegKey = null;
let ticketEditorPair = null;
let ticketEditorRaw = '';
let ticketEditorQuoteOptions = [];
let lastSavedTicketKeys = [];
let routes = [];
let manualRoutes = [];
let manualDraftRows = [];
let manualDraftId = null;
let currentKey = null;
let lastSavedFareKey = null; // Highlight the matching leg after a confirmed price update
let parsedPlan = null;
let parseWarnings = [];
let parseSource = '';
let parseDebug = null; // Local-only raw-vs-normalized diagnostics; never includes an API key.
let parsedRequest = ''; // AI constraints are valid only for the description that was interpreted.
let destinationCandidates = [];
let destinationCandidateKey = '';
let connectionCandidates = {outbound:[],inbound:[]};
let connectionCandidateKey = '';
let sessionCleared = false; // Suppress automatic route generation after a traveler reset.
let lastAiInterpretation = null; // Reuse the last successful same-day, identical prompt response.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
let developerEventQueue = Promise.resolve();
function status(message) {
  $('status').textContent = message;
  if (!message) return;
  developerEventQueue = developerEventQueue.then(async () => {
    const { developerEvents = [] } = await chrome.storage.local.get('developerEvents');
    const entries = Array.isArray(developerEvents) ? developerEvents : [];
    await chrome.storage.local.set({ developerEvents: [...entries.slice(-49), {
      time: new Date().toISOString(), message: String(message).slice(0, 900)
    }] });
  }).catch(() => { /* Logging must never interrupt trip planning. */ });
}
function generationStatus(message) { $('generationStatus').textContent = message; status(message); }
function localDate() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function candidatePool() { return sessionCleared ? [] : [...routes, ...manualRoutes.filter(route=>manualRouteForTrip(route,trip))]; }
function visibleRoutes() { return sessionCleared ? [] : excludeUnavailableFlightRoutes(candidatePool(),unavailableFlights); }
function candidateKey(t) {return JSON.stringify([t.origin,t.destination,t.requestedRegion,t.startDate,t.endDate,t.request]);}
function hubKey(t,maxConnections) {return JSON.stringify([t.origin,t.preferred,t.destination,t.startDate,t.endDate,t.request,maxConnections]);}
function placeName(code) { return visibleRoutes().find(r=>r.places?.[code])?.places?.[code] || airportName(code); }
function money(n) { return new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR'}).format(n); }
function dateDisplay(value) { return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB',{month:'short',day:'numeric',timeZone:'UTC'}); }
function fillSelect(id, selected) {
  // Do not recreate thousands of airport <option>s every time AI details are
  // applied. The initial list is cached on the select element and reused.
  updateAirportSelect($(id), AIRPORTS, selected, { allowEmpty: id === 'preferred' || !selected });
  // After Start fresh, the origin and end selectors must not silently retain
  // airports from the old trip. Do not rebuild the airport list.
  if (!selected && !Array.from($(id).options).some(option => option.value === '')) {
    $(id).add(new Option('Choose an airport', ''), 0);
  }
  if (!selected) $(id).value = '';
}
function setForm() {
  for (const key of ['origin','preferred','destination']) fillSelect(key,trip[key]);
  for (const key of ['startDate','endDate','request','goal','arrivalRule','connectionBuffer']) $(key).value = trip[key];
  $('destinationSearch').value = trip.destinationSearch || 'specified';
  $('requestedRegion').value = trip.requestedRegion || '';
  $('bagName').value = bag.name;
  $('bagL').value = bag.length;
  $('bagW').value = bag.width;
  $('bagD').value = bag.depth;
  $('bagKg').value = bag.kg;
}
function getFormTrip() {
  const result = {};
  for (const key of Object.keys(DEFAULT_TRIP)) result[key] = $(key).value;
  return result;
}
function clearPriceImportSessionState() {
  offers = {};
  roundTripTickets = {};
  flightResearch = {};
  broadCache = {};
  trainCache = {};
  trainCapture = null; trainTaskKey = null; trainResearchTabId = null;
  flightTimes = {}; // Imported and manually checked flight times must not leak between tests.
  groundQuotes={}; // Transit estimates must not leak between price-import tests.
  pendingFlightCapture = null;
  lastSavedFareKey = null;
  lastSavedTicketKeys = [];
}
let priceTestResetInProgress = false;
// Start at the same point as a freshly generated trip, just before importing
// its first flight. Do not alter trip, route candidates, baggage or AI caches.
async function restartPriceImportTest() {
  if (!priceTestMode || priceTestResetInProgress) return;
  priceTestResetInProgress = true;
  try {
    const importing = () =>
      (typeof broadImportBusy !== 'undefined' && broadImportBusy) ||
      (typeof broadBatchRunning !== 'undefined' && broadBatchRunning) ||
      (typeof workflowRunning !== 'undefined' && workflowRunning);
    if (importing()) {
      // A completed in-flight import must not refill the cleared cache.
      if (typeof broadBatchCancelRequested !== 'undefined') broadBatchCancelRequested = true;
      status('Stopping the active flight import before restarting the price test...');
      for (let attempt = 0; importing() && attempt < 110; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (importing()) throw new Error('A flight import is still active. Close that search or retry the reset after it finishes.');
    }
    clearPriceImportSessionState();
    activeResearchKey = null;
    importLegKey = null;
    ticketEditorPair = null;
    ticketEditorRaw = '';
    ticketEditorQuoteOptions = [];
    currentKey = null;
    $('flightImport').hidden = true;
    $('ticketEditor').hidden = true;
    $('editor').hidden = true;
    $('broadCaptureArea').hidden = true;
    $('broadConfirmOneWay').checked = false;
    $('broadBatchProgress') && ($('broadBatchProgress').textContent = '');
    $('workflowStatus') && ($('workflowStatus').textContent = '');
    $('priceSaveNotice').hidden = true;
    $('priceSaveNotice').textContent = '';
    $('broadCaptureStatus').textContent = '';
    // The extension is reset; open Google Flights tabs are left alone.
    await chrome.storage.local.remove(PRICE_STORAGE_KEYS);
    await chrome.storage.local.remove('trainCache');
    showCaptureNotice();
    render();
    const count = broadTasks().length;
    status(count
      ? `Price import test restarted. ${count} unique flight search(es) are ready to import from the first leg. No Groq request made.`
      : 'Price import test restarted. Generate candidate routes first; no Groq request was made by the reset.');
  } catch (error) {
    status(`Could not restart price import test: ${error.message}`);
  } finally {
    priceTestResetInProgress = false;
  }
}
async function persist() {
  const session = {trip,bag,offers,roundTripTickets,flightTimes,groundTimes,flightResearch,broadCache,routes,manualRoutes,destinationCandidates,destinationCandidateKey,connectionCandidates,connectionCandidateKey,parsedPlan,parseWarnings,parseSource,parsedRequest,parseDebug,sessionCleared,lastAiInterpretation};
  await chrome.storage.local.set(persistableSession(session, {priceTestMode}));
  if(priceTestMode)await chrome.storage.local.remove('trainCache');
  else await chrome.storage.local.set({trainCache});
  await chrome.storage.local.set({unavailableFlights});
}
function formatWindow(from, to, fixed) {
  if (!from && !to) return 'Not specified';
  if (from && to && from === to) return `${from}${fixed?' (fixed)':''}`;
  if (!from) return `By ${to}`;
  if (!to) return `From ${from}`;
  return `${from} to ${to}`;
}
function showPlanPreview() {
  const target = $('parsedResult');
  target.hidden = !parsedPlan;
  if (!parsedPlan) { target.replaceChildren(); return; }
  const p = parsedPlan;
  const showAirport = code => code ? `${airportName(code)} (${code})` : 'Not specified';
  const fields = [
    ['Origin',showAirport(p.origin)],
    ['Primary destination',p.destination_search === 'open' ? 'Open to destination suggestions' : showAirport(p.preferred)],
    ['Destination discovery',p.destination_search === 'open' ? 'Explore destination ideas' : p.destination_search === 'region' ? 'Suggest cities in requested region (review required)' : 'Named city'],
    ['Requested regions',p.requested_regions.length ? p.requested_regions.join(', ') : 'None specified'],
    ['Destination',showAirport(p.destination)],
    ['Departure window',formatWindow(p.depart_earliest,p.depart_latest,p.fixed_departure)],
    ['Arrival deadline/window',formatWindow(p.arrive_earliest,p.arrive_latest,p.fixed_arrival)],
    ['Bag type',p.bag_type.replaceAll('_',' ')],
    ['Minimum nights at primary destination',p.min_nights_at_preferred ?? 'Unspecified'],
    ['Priority',p.priority === 'unspecified' ? 'Maximize primary destination time (app default)' : p.priority.replaceAll('_',' ')],
    ['Max connections',p.max_connections ?? 'Unspecified'],
    ['Earliest departure hour',p.earliest_departure_hour === null ? 'Unspecified' : `${p.earliest_departure_hour}:00`],
    ['Other possible stops',p.alternate_stops.length ? p.alternate_stops.map(showAirport).join(', ') : 'None specified']
  ];
  const fieldHtml = fields.map(([label,value])=>`<div class="data-field"><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</div>`).join('');
  const notices = [
    ...parseWarnings,
    ...p.questions.map(q=>`Question: ${q}`)
  ];
  const more = [...p.hard_constraints.map(x=>`Required: ${x}`),...p.soft_preferences.map(x=>`Preferred: ${x}`)];
  target.innerHTML = `<h3>Review extracted trip details</h3>
    <p class="parse-source">${parseSource === 'sample' ? 'SAMPLE OUTPUT — not AI-generated' : 'AI interpretation — verify before using'}</p>
    <div class="data-grid">${fieldHtml}</div>
    ${more.length?`<ul>${more.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`:''}
    ${notices.length?`<div class="parse-warnings"><strong>Review:</strong><ul>${notices.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`:''}
    <button id="applyParsed" class="primary full">Apply known details to trip form</button>`;
  $('applyParsed').addEventListener('click', async()=>{
    if (parsedRequest !== $('request').value.trim()) {
      status('Your trip description changed since this AI result. Interpret the updated text before applying it.');
      return;
    }
    const applied = applyPlanToForm(parsedPlan, getFormTrip(), bag);
    const guarded=protectReviewedTrip(applied.trip,{parsedPlan,parsedRequest});
    trip = guarded.trip;
    bag = applied.bag;
    setForm();
    await persist();
    const retained = applied.retained.length ? ` Kept previous values for: ${applied.retained.join(', ')}.` : '';
    status(`Applied recognized details. Review the dates and press Generate candidate routes.${retained} ${guarded.notices.join(' ')}`.trim());
  });
}
async function setParsedPlan(raw,source,sourceText=$('request').value.trim(),debug=null) {
  // Normalize AGAIN locally so a stale server response cannot inject an
  // unrelated airport code into the side panel. Preserve raw Groq diagnostics.
  if(source==='ai') {
    const local=normalizeTripWithDiagnostics(sourceText,raw,{referenceDate:debug?.referenceDate || localDate()});
    if(local.corrections.length) debug={...debug,clientCorrections:local.corrections};
    raw=local.plan;
  }
  const result = validateTripPlan(raw);
  parsedPlan = result.plan;
  parsedRequest = sourceText;
  parseWarnings = result.warnings;
  parseSource = source;
  parseDebug = debug;
  showPlanPreview();
  await persist();
}
$('interpret').addEventListener('click', async()=>{
  if(broadBatchRunning || broadImportBusy){status('Finish importing flight searches before changing your trip.');return;}
  if(workflowRunning){status('Finish searching routes before changing your trip.');return;}
  const description = $('request').value.trim();
  if (!description) { status('Describe your trip first.'); return; }
  $('interpret').disabled = true;
  $('interpret').textContent = 'Interpreting…';
  status('Interpreting your trip…');
  try {
    const referenceDate=localDate();
    if (lastAiInterpretation?.request===description &&
        lastAiInterpretation.referenceDate===referenceDate && lastAiInterpretation.plan) {
      await setParsedPlan(lastAiInterpretation.plan,'ai',description,lastAiInterpretation.debug||null);
      parseWarnings=lastAiInterpretation.warnings||[];
      showPlanPreview();
      await persist();
      status('Restored your earlier AI interpretation from this device (no Groq request).');
      return;
    }
    const response = await fetch('http://127.0.0.1:8787/parse-trip', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ request:description, referenceDate }),
      signal: AbortSignal.timeout(35000)
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Local server returned an invalid response.'); }
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);
    await setParsedPlan(data.plan,'ai',description,data.debug || null);
    // Synchronize warnings supplied by the backend only when present and strings.
    if (Array.isArray(data.warnings)) {
      parseWarnings = data.warnings.filter(x=>typeof x==='string').slice(0,15);
      showPlanPreview();
      await persist();
    }
    lastAiInterpretation={request:description,referenceDate,plan:data.plan,debug:data.debug||null,warnings:[...parseWarnings]};
    await persist();
    status('Your trip is ready to review. Check the details and click Apply known details.');
  } catch(error) {
    status(`AI unavailable: ${error.message}. Check that the RouteWise service is running and try again.`);
  } finally {
    $('interpret').disabled = false;
    $('interpret').textContent = 'Interpret my trip';
  }
});
// The review form is authoritative for edited endpoints and dates. Reuse the AI's
// flexible window only while its starting date still matches the reviewed form.
function generationPlan(form) {
  const validParsed = parsedPlan && parsedRequest === form.request.trim();
  const usesOriginalStart = validParsed && form.startDate === parsedPlan.depart_earliest;
  return {
    origin: form.origin,
    preferred: form.destinationSearch === 'open' ? null : (form.preferred || null),
    destination_search: form.destinationSearch || 'specified',
    destination: form.destination,
    requested_regions: form.requestedRegion ? [form.requestedRegion] : [],
    depart_earliest: form.startDate,
    depart_latest: usesOriginalStart ? (parsedPlan.depart_latest || form.startDate) : form.startDate,
    arrive_latest: form.endDate,
    arrive_earliest: form.arrivalRule === 'fixed' ? form.endDate : null,
    fixed_arrival: form.arrivalRule === 'fixed',
    priority: form.goal || 'more_time_at_preferred',
    min_nights_at_preferred: validParsed ? parsedPlan.min_nights_at_preferred : null,
    max_connections: validParsed ? parsedPlan.max_connections : null,
    alternate_stops: validParsed ? parsedPlan.alternate_stops : []
  };
}
function connectionCardHtml(window,leg) {
  const info=connectionPanelData(window);
  if(!info)return '';
  const saved=(Object.hasOwn(flightTimes,leg.key)?flightTimes[leg.key]:offers[leg.key])||{};
  const enteredClock=saved.departureClock||'';
  const enteredZone=saved.departureTimezone||'';
  // This is a suggested default only; users can override it for the actual airport.
  const zone=enteredZone||(window.timezone?.includes('/')?window.timezone:'');
  const shownDeparture=info.flightTime?`${info.flightTime} (${info.departureTimezone})`:'Not entered';
  const savedGround=groundTimes[window.groundKey]||{};
  const day=savedGround.arrivalDate||window.groundArrivalLocal?.slice(0,10)||leg.date;
  const arrivalClock=savedGround.arrivalClock||window.groundArrivalLocal?.slice(11)||'';
  const arrivalZone=savedGround.arrivalTimezone||(window.timezone?.includes('/')?window.timezone:'');
  return `<section class="connection-check connection-${escapeHtml(info.tone)}" aria-label="Connection buffer check">
    <div class="connection-heading"><strong>Ground → flight connection</strong><span class="connection-state">${escapeHtml(info.title)}</span></div>
    <div class="connection-facts">
      <div><span>Ground arrival</span><strong>${escapeHtml(info.arrival)}</strong></div>
      <div><span>Planning buffer</span><strong>${escapeHtml(info.buffer)}</strong></div>
      <div><span>Earliest onward flight</span><strong>${escapeHtml(info.target)}</strong></div>
    </div>
    <p class="connection-info">${escapeHtml(info.detail)} ${escapeHtml(info.timezone||'Time zone not verified')}</p>
    <details class="ground-arrival-edit" ${window.status==='ground_time_needed'?'open':''}><summary>${window.groundTimeSource==='gtfs'?'Override published ground arrival':'Enter ground arrival time'} (optional)</summary>
      <form class="ground-arrival-form" data-ground-time-form="${escapeHtml(window.groundKey)}">
        <label>Date <input type="date" name="day" value="${escapeHtml(day||'')}" required /></label>
        <label>Time <input type="time" name="clock" value="${escapeHtml(arrivalClock)}" required /></label>
        <label>Time zone <input type="text" name="timezone" value="${escapeHtml(arrivalZone)}" placeholder="Europe/Madrid" required /></label>
        <button class="secondary" type="submit">Use ground arrival</button>
        ${savedGround.arrivalDate?`<button class="ghost" type="button" data-clear-ground-time="${escapeHtml(window.groundKey)}">Clear entered time</button>`:''}
      </form>
    </details>
    <form class="connection-time-form" data-flight-time-form="${escapeHtml(leg.key)}">
      <div><label>Flight departure <input type="time" name="clock" value="${escapeHtml(enteredClock)}" required /></label></div>
      <div><label>Airport time zone <input type="text" name="timezone" value="${escapeHtml(zone)}" placeholder="Europe/Madrid" required /></label></div>
      <button class="secondary" type="submit">Check time</button>
      ${enteredClock?`<button class="ghost" type="button" data-clear-flight-time="${escapeHtml(leg.key)}">Clear time</button>`:''}
    </form>
    ${info.flightTime?`<p class="connection-info">Entered flight: ${escapeHtml(shownDeparture)}</p>`:''}
  </section>`;
}
function render() {
  const ranked = rankRoutes(visibleRoutes(), offers,{bufferMinutes:Number(trip.connectionBuffer)||180,flightTimes,groundTimes,tickets:roundTripTickets,groundQuotes});
  $('bufferSummary').textContent=connectionOverview(ranked.map(x=>x.route),offers,{bufferMinutes:Number(trip.connectionBuffer)||180,flightTimes,groundTimes});
  $('routeCount').textContent = String(ranked.length);
  renderBroadResearch();
  renderTrainResearch();
  $('routes').innerHTML = ranked.map(({route,summary},i) => {
    const roundTripPairs = new Map(findRoundTripPairs(route.legs).map(pair => [pair.outboundIndex, pair.returnIndex]));
    const totalLabel = summary.complete ? money(summary.total) : summary.pricedLegs ? `${money(summary.known)}+` : `${summary.pricedLegs}/${route.legs.length}`;
    const ticketSuffix=summary.ticketCount?` · ${summary.ticketCount} linked round-trip ticket${summary.ticketCount===1?'':'s'} (counted once)`:'';
    const totalSub = (summary.complete ? 'Recorded total' : summary.pricedLegs ? `Known subtotal, ${summary.pricedLegs}/${route.legs.length} legs` : 'Legs priced')+ticketSuffix;
    const stay = route.primaryStay;
    const stayText = stay ? `<p class="stay-note">${escapeHtml(placeName(stay.destination))} · up to ${stay.possibleNights} calendar nights (${escapeHtml(stay.arrivalDate)}–${escapeHtml(stay.departureDate)})</p>` : '';
    const windows=connectionWindows(route,offers,{bufferMinutes:Number(trip.connectionBuffer)||180,flightTimes,groundTimes});
    const windowsByFlight=new Map(windows.map(window=>[window.flightLegIndex,window]));
    const routeTickets=matchingTicketsForRoute(route,roundTripTickets);
    const ticketByIndex=new Map(routeTickets.flatMap(match=>[[match.outboundIndex,{...match,position:'outbound'}],[match.returnIndex,{...match,position:'return'}]]));
    const routeDescription=route.networkEvidence
      ? `GTFS ${route.networkEvidence.dateVerified?'scheduled ground time':'route pattern'}`
      :route.manual?'Custom multimodal route':route.legs.length===2?'Basic flight route':'Connecting flight pattern';
    const legs = route.legs.map((leg, legIndex) => {
      const offer = offers[leg.key];
      const ticketMatch=ticketByIndex.get(legIndex);
      const shared=ticketMatch?.ticket;
      const localQuote = groundQuotes[routeTransferQuoteKey(route,leg)];
      const googleFare = GOOGLE_ROUTES_ENABLED && validDatedTransitResult(leg,localQuote) ? localQuote.fare.amount : null;
      const transferIndex = legIndex;
      const timeHint = suggestedTransferTime(route,transferIndex);
      const transferWidget=GOOGLE_ROUTES_ENABLED && leg.mode==='transfer' ? `<details class="ground-research"><summary>Research local transit with Google Maps</summary>
        <form data-google-ground="${escapeHtml(leg.key)}" data-google-ground-route="${escapeHtml(route.id)}">
          <label>Time to plan for <input name="localTime" type="datetime-local" value="${escapeHtml(timeHint?.localTime||'')}" required /></label>
          <label>Time zone <input name="timeZone" value="${escapeHtml(timeHint?.timeZone||'')}" placeholder="Europe/Madrid" required /></label>
          <label>Search for <select name="timeKind"><option value="departure" ${timeHint?.timeKind==='departure'?'selected':''}>Depart at</option><option value="arrival" ${timeHint?.timeKind==='arrival'?'selected':''}>Arrive by</option></select></label>
          <p class="helper">${escapeHtml(timeHint?.note||'')}. Google may not provide the fare.</p>
          <button class="secondary" type="submit">Find transit options</button>
        </form>
        ${localQuote ? `<p class="helper">© Google Maps · ${localQuote.found?`Duration: ${localQuote.routes[0]?.durationMinutes??'?'} min · ${localQuote.fare?`${escapeHtml(localQuote.fare.currencyCode)} ${localQuote.fare.amount.toFixed(2)} (estimate)`:'Fare unavailable'}`:'No transit route returned'}${googleFare===null?' · Not included in trip total':''}. Check the actual stop and date.</p>
        ${localQuote.routes?.[0]?.transit?.length ? `<p class="helper">${localQuote.routes[0].transit.map(step=>`${escapeHtml(step.line||step.mode)}: ${escapeHtml(step.from)} → ${escapeHtml(step.to)}`).join(' · ')}</p>`:''}
        <a class="link" target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/dir/?api=1&amp;origin=${encodeURIComponent(leg.fromKind==='airport'?airportName(leg.from):(leg.fromLabel||leg.from))}&amp;destination=${encodeURIComponent(leg.toKind==='airport'?airportName(leg.to):(leg.toLabel||leg.to))}&amp;travelmode=transit">Review in Google Maps ↗</a>
        ${localQuote.fare?.currencyCode==='EUR' && !localQuote.acceptedForComparison && localQuote.requestedDate===leg.date ? `<button class="secondary" type="button" data-accept-ground="${escapeHtml(leg.key)}" data-accept-ground-route="${escapeHtml(route.id)}">Use this estimated fare in comparison</button>`:''}`:''}
      </details>` : '';
      const cost=shared ? `<div class="leg-pricing ticket-covered">${ticketMatch.position==='outbound'?`${money(shared.totalEur)} · linked round-trip ticket`:'Covered by linked round-trip ticket'}<div class="ticket-link">${escapeHtml(shared.seller)} · covers ${escapeHtml(shared.outbound.date)} and ${escapeHtml(shared.returning.date)}</div></div>`
        :offer?`<div class="leg-pricing">${money(offer.fare + offer.bagFee + offer.transferCost)}</div>`:
         googleFare!==null?`<div class="leg-pricing">${money(googleFare)} · Google transit estimate</div>`:'<span class="tag">Unpriced</span>';
      const trainHint=leg.mode==='train'&&!offer?indicativeTrainQuote(trainCache,leg):null;
      const research=flightResearch[leg.key];
      const sourceUrl=shared?.sourceUrl || offer?.source || research?.sourceUrl || '';
      const source=sourceUrl ? `<a class="link" target="_blank" rel="noopener noreferrer" href="${escapeHtml(sourceUrl)}">Reviewed source ↗</a>` : '';
      const researchNote=leg.mode==='flight'&&research?.reviewedByUser
        ? `<div class="import-source-note">User-reviewed${research.carrier?` · ${escapeHtml(research.carrier)}`:''}${research.flightNumber?` ${escapeHtml(research.flightNumber)}`:''}${research.stops!==null?` · ${research.stops} stop(s)`:''}${research.departureClock?` · departs ${escapeHtml(research.departureClock)}`:''}${research.arrivalClock?` · arrives ${escapeHtml(research.arrivalClock)}${research.arrivalDayOffset?` (+${research.arrivalDayOffset}d)`:''}`:''}</div>`:'';
      const returnIndex = roundTripPairs.get(legIndex);
      const roundTripButton = returnIndex === undefined ? '' :
        `<button class="secondary" data-roundtrip-route="${escapeHtml(route.id)}" data-roundtrip-index="${legIndex}" title="Search ${escapeHtml(leg.from)} to ${escapeHtml(leg.to)} on ${escapeHtml(leg.date)} and return ${escapeHtml(route.legs[returnIndex].date)}">Round trip ↗</button>`;
      const ticketButton=returnIndex===undefined?'':`<button class="secondary" data-price-roundtrip-route="${escapeHtml(route.id)}" data-price-roundtrip-index="${legIndex}">${shared?'Edit linked ticket €':'Price as round trip €'}</button>`;
      const returnNote = returnIndex === undefined ? '' : `<div class="leg-meta">Return: ${dateDisplay(route.legs[returnIndex].date)} · ${escapeHtml(airportName(leg.to))} → ${escapeHtml(airportName(leg.from))}</div>`;
      const trainQuoteNote=trainHint?`<div class="leg-meta">Indicative train quote ${money(trainHint.fareEur)} · research only, not a checked booking price</div>`:'';
      const flightTimeNote=leg.mode==='flight' && !windowsByFlight.has(legIndex) && offer?.departureClock
        ? `<div class="leg-meta">Saved departure: ${escapeHtml(offer.departureClock)} (${escapeHtml(offer.departureTimezone||'time zone unspecified')})</div>`:'';
      const check=windowsByFlight.get(legIndex);
      return `${check?connectionCardHtml(check,leg):''}<div class="leg${lastSavedFareKey===leg.key||lastSavedTicketKeys.includes(leg.key)?' leg-updated':''}" data-leg-key="${escapeHtml(leg.key)}">
        <div><div class="leg-title">${escapeHtml(placeName(leg.from))} → ${escapeHtml(placeName(leg.to))}</div>
        <div class="leg-meta">${dateDisplay(leg.date)} · ${escapeHtml(modeLabel(leg.mode))}${leg.evidence==='gtfs_scheduled'?' · GTFS scheduled (ground leg only)':leg.evidence==='gtfs_trip_pattern'?' · GTFS trip pattern (date unverified)':leg.evidence==='transfer_needed'?' · transfer required (unverified)':''}${leg.fromKind && leg.mode !== 'flight' && !leg.evidence ? ' · user-entered terminal' : ''}</div>${leg.evidence==='gtfs_scheduled'?`<div class="leg-meta">${escapeHtml(leg.departureLocal)} → ${escapeHtml(leg.arrivalLocal)} (${escapeHtml(leg.scheduleTimezone||'feed-local')})</div>`:''}${returnNote}${flightTimeNote}${trainQuoteNote}${cost}${researchNote}${source}</div>
        <div class="leg-actions">
          <button class="secondary" data-search="${escapeHtml(leg.key)}">${leg.mode === 'flight' ? 'One way ↗' : leg.mode === 'transfer' ? 'Directions ↗' : `Find ${escapeHtml(leg.mode)} ↗`}</button>${roundTripButton}${ticketButton}
          ${leg.mode==='flight'?`<button class="ghost" data-import-flight="${escapeHtml(leg.key)}">Import flight</button>`:''}
          ${leg.mode==='train'?`<button class="ghost" data-import-train="${escapeHtml(leg.key)}">Import train</button>`:''}
          <button class="ghost" data-edit="${escapeHtml(leg.key)}">${shared?'Ticket €':offer?'Edit':'Add'} €</button>
        </div>${transferWidget}</div>`;
    }).join('');
    const dests = [route.legs[0].from,...route.legs.map(l=>l.to)].map(placeName).join(' → ');
    return `<article class="route ${summary.complete?'route-complete':''}">
      <div class="route-head"><div><h3>${i+1}. ${escapeHtml(route.name)}</h3><p>${escapeHtml(routeDescription)}</p>
      <button class="secondary route-copy" data-copy-route="${escapeHtml(route.id)}">${route.manual?'Edit multimodal route':'Make multimodal copy'}</button>
      ${route.networkEvidence?.sourceUrl?`<a class="link" target="_blank" rel="noopener noreferrer" href="${escapeHtml(route.networkEvidence.sourceUrl)}">GTFS source ↗</a>`:''}
      ${route.networkEvidence?.attribution?`<p class="helper">${escapeHtml(route.networkEvidence.attribution)}</p>`:''}
      ${route.manual?`<button class="danger route-copy" data-remove-manual="${escapeHtml(route.id)}">Remove</button>`:''}</div>
      <div class="route-cost">${totalLabel}<small>${totalSub}</small></div></div>
      <div class="route-body"><div class="route-dest">${escapeHtml(dests)}</div>${stayText}${legs}</div></article>`;
  }).join('');
}
// Independent rail research workflow. Prices from result cards remain indicative
// until a traveler confirms the exact one-way itinerary and ticket conditions.
function trainTasks(){return trainResearchTasks(visibleRoutes());}
function trainPanel(){
  let panel=$('trainResearch');
  if(panel)return panel;
  panel=document.createElement('section');
  panel.id='trainResearch';panel.className='card broad-research';
  $('broadResearch').insertAdjacentElement('afterend',panel);
  panel.addEventListener('click',async event=>{
    if(event.target.closest('#trainImportAll')){await importAllTrains();return;}
    if(event.target.closest('#trainBatchStop')){trainBatchStop=true;status('Stopping train research; the current search will not be saved.');return;}
    const open=event.target.closest('[data-train-open]');
    const capture=event.target.closest('[data-train-capture]');
    const clear=event.target.closest('[data-train-clear]');
    if(open){const task=trainTasks().find(t=>t.key===open.dataset.trainOpen);if(task)await openAndImportTrain(task);}
    if(capture){const task=trainTasks().find(t=>t.key===capture.dataset.trainCapture);if(task)openTrainImport(task.key);}
    if(clear){delete trainCache[clear.dataset.trainClear];await persist();render();status('Indicative train quote cleared.');}
  });
  return panel;
}
function trainEditor(){
  let editor=$('trainImport');
  if(editor)return editor;
  editor=document.createElement('section');
  editor.id='trainImport';editor.className='card offer-editor';editor.hidden=true;
  editor.innerHTML=`<div class="editor-title"><h2>Import a train search</h2><button class="ghost" id="trainImportClose" type="button">Close</button></div>
    <p id="trainImportLeg" class="helper"></p>
    <p class="helper">Search results are not verified booking prices. Check the correct stations, travel date, one-way trip, operator, passenger count and ticket conditions before importing.</p>
    <div class="import-actions"><button class="secondary" id="trainImportOpen" type="button">Open train search ↗</button><button class="secondary" id="trainImportCapture" type="button">Capture visible train results</button></div>
    <p id="trainImportStatus" class="helper" role="status"></p>
    <label for="trainImportSource">Train search URL</label><input id="trainImportSource" type="url" placeholder="https://www.omio.com/…" />
    <label for="trainImportText">Or paste one train journey result (for manual review)</label><textarea id="trainImportText" rows="4" placeholder="e.g. 08:00 → 10:45 · Barcelona Sants → Madrid Atocha · €45.90"></textarea>
    <button id="trainImportParse" class="secondary" type="button">Analyze pasted train result</button>
    <label for="trainImportChoice">Captured EUR-priced journey</label><select id="trainImportChoice"></select>
    <label for="trainImportFare">Fare to save (€)</label><input id="trainImportFare" type="number" min="0.01" max="5000" step="0.01" />
    <label class="import-confirm"><input id="trainImportConfirmed" type="checkbox"/> I checked this one-way train's actual departure and arrival stations, travel date, EUR fare, passenger count and fare conditions on the provider page.</label>
    <div class="import-actions"><button class="secondary" id="trainCacheSave" type="button">Cache indicative train quote</button><button class="primary" id="trainFareSave" type="button">Save checked train fare</button></div>`;
  $('trainResearch').insertAdjacentElement('afterend',editor);
  $('trainImportClose').addEventListener('click',()=>{editor.hidden=true;});
  $('trainImportOpen').addEventListener('click',()=>{const task=trainTasks().find(t=>t.key===trainTaskKey);if(task)void openAndImportTrain(task);});
  $('trainImportCapture').addEventListener('click',()=>{void captureTrainTab();});
  $('trainImportParse').addEventListener('click',()=>{
    const task=trainTasks().find(t=>t.key===trainTaskKey);if(!task)return;
    trainCapture={sourceUrl:$('trainImportSource').value,cards:[$('trainImportText').value]};
    displayTrainCapture(task,trainCapture);
  });
  $('trainImportChoice').addEventListener('change',()=>{
    const task=trainTasks().find(t=>t.key===trainTaskKey);if(!task||!trainCapture)return;
    try{$('trainImportFare').value=parseTrainCapture(trainCapture,task).options[Number($('trainImportChoice').value)]?.fareEur??'';}
    catch{$('trainImportFare').value='';}
  });
  async function saveTrain({checked}){
    const task=trainTasks().find(t=>t.key===trainTaskKey);
    if(!task)return;
    try{
      if(!$('trainImportConfirmed').checked)throw new Error('Check the provider page and confirm the exact one-way train search first.');
      const amount=Number($('trainImportFare').value);
      if(!Number.isFinite(amount)||amount<=0||amount>5000)throw new Error('Enter a valid EUR train fare.');
      const sourceUrl=$('trainImportSource').value.trim();
      const parsed=trainCapture ? parseTrainCapture({...trainCapture,sourceUrl},task):null;
      if(!parsed?.sourceUrl)throw new Error('Use the original Omio/Trainline source URL.');
      const option=parsed.options.find(x=>x.fareEur===Math.round(amount*100)/100);
      if(!option)throw new Error('This price must match a captured train journey card. Re-capture or paste that card.');
      if(checked){
        // Save the reviewed fare for every identical station/date train leg.
        // GTFS feed IDs can differ even when the operator search is identical.
        let count=0;
        for(const leg of visibleRoutes().flatMap(route=>route.legs||[])){
          if(trainResearchKey(leg)!==task.key)continue;
          offers[leg.key]=normalizedOffer({fare:amount,bagFee:0,transferCost:0,
            source:parsed.sourceUrl,note:`User-reviewed one-way train quote; confirm operator, seat and luggage terms. ${option.departureClock||''}`});
          count++;
        }
        await persist();render();editor.hidden=true;
        status(`Saved checked ${money(amount)} train fare for ${task.from} → ${task.to} (${task.date}) across ${count} matching leg(s).`);
      }else{
        trainCache[task.key]={...parsed,selected:{...option},quoteStatus:'indicative'};
        await persist();render();
        status(`Cached indicative ${money(amount)} train quote for ${task.from} → ${task.to}. Verified fares unchanged.`);
      }
    }catch(error){$('trainImportStatus').textContent=`Could not save: ${error.message}`;}
  }
  $('trainCacheSave').addEventListener('click',()=>{void saveTrain({checked:false});});
  $('trainFareSave').addEventListener('click',()=>{void saveTrain({checked:true});});
  return editor;
}
function renderTrainResearch(){
  const panel=trainPanel(),tasks=trainTasks();
  panel.hidden=!tasks.length;
  if(!tasks.length)return;
  panel.innerHTML=`<div class="broad-title"><h3>05 · Train research</h3><span class="tag">User-reviewed</span></div>
    <p class="helper">Open a dated Omio train search, inspect the actual results, then import its visible EUR prices. Cached quotes are indicative; only a separately checked fare counts as a recorded price. Google Routes API calls are paused.</p>
    <p class="helper">${tasks.length} unique station-to-station search(es) · ${tasks.filter(t=>trainCache[t.key]).length} indicative quotes cached</p>
    <div class="import-actions"><button id="trainImportAll" class="primary" type="button" ${trainImportBusy||trainBatchBusy?'disabled':''}>Import all missing train searches ↗</button>${trainBatchBusy?'<button id="trainBatchStop" class="secondary" type="button">Stop research</button>':''}</div>
    <div class="broad-searches">${tasks.map(task=>{
      const quote=indicativeTrainQuote(trainCache,task.leg);
      return `<div class="broad-task"><div><strong>${escapeHtml(task.from)} → ${escapeHtml(task.to)} · ${escapeHtml(task.date)}</strong>
      <small>${quote?`${money(quote.fareEur)} indicative · ${escapeHtml(quote.capturedAt)}`:'Not researched'} · used by ${task.routeCount} itinerary(ies)</small></div>
      <div><button class="secondary" data-train-open="${escapeHtml(task.key)}">Open and import ↗</button>
      <button class="ghost" data-train-capture="${escapeHtml(task.key)}">Review/import</button>
      ${quote?`<button class="ghost" data-train-clear="${escapeHtml(task.key)}">Clear</button>`:''}</div></div>`;
    }).join('')}</div>`;
  trainEditor();
}
function openTrainImport(key){
  const task=trainTasks().find(t=>t.key===key);
  if(!task){status('No matching train leg exists in the current itineraries.');return;}
  const editor=trainEditor();
  if(trainTaskKey!==key){trainCapture=null;trainResearchTabId=null;}
  trainTaskKey=key;
  editor.hidden=false;
  $('trainImportLeg').textContent=`${task.from} → ${task.to} · ${task.date}`;
  $('trainImportSource').value=trainCapture?.sourceUrl || trainSearchUrl(task);
  $('trainImportStatus').textContent='Open the prefilled train search. Check the results, then capture the visible journey cards or paste one card.';
  $('trainImportConfirmed').checked=false;
  if(trainCapture)displayTrainCapture(task,trainCapture);
  else{$('trainImportChoice').replaceChildren(new Option('No priced journey captured',''));$('trainImportFare').value='';}
  editor.scrollIntoView({behavior:'smooth',block:'start'});
}
function displayTrainCapture(task,capture){
  trainCapture=capture;
  try{
    const parsed=parseTrainCapture(capture,task);
    $('trainImportSource').value=parsed.sourceUrl;
    const select=$('trainImportChoice');select.replaceChildren();
    parsed.options.forEach((o,i)=>select.add(new Option(`${money(o.fareEur)} · ${o.departureClock||'time unknown'} → ${o.arrivalClock||'time unknown'}${o.operator?' · '+o.operator:''}${o.changes?' · '+o.changes:''}${o.toStation?' · '+o.toStation:''}`,String(i))));
    if(parsed.options.length){select.value='0';$('trainImportFare').value=parsed.options[0].fareEur;}
    else{$('trainImportFare').value='';select.add(new Option('No EUR-priced journey cards found',''));}
    $('trainImportConfirmed').checked=false;
    $('trainImportStatus').textContent=parsed.options.length
      ? `Found ${parsed.options.length} ${parsed.journeyCardsSeen?'exact-station matching':'possible'} EUR-priced train journey(s)${parsed.excludedStationMismatch?`; excluded ${parsed.excludedStationMismatch} journey(s) to different stations`:''}. Confirm date, passenger, seat and fare conditions before saving.`
      : parsed.excludedStationMismatch
        ? `No journeys match the requested stations. Excluded ${parsed.excludedStationMismatch} result(s) arriving at or departing from a different station.`
        : 'No recognizable EUR train journey cards. Complete the search on the provider page, capture again, or paste one journey card.';
  }catch(error){$('trainImportStatus').textContent=error.message;}
}
async function captureTrainTab(){
  const task=trainTasks().find(t=>t.key===trainTaskKey);
  if(!task)return;
  let tabId=trainResearchTabId;
  if(!Number.isInteger(tabId)){
    const tabs=await chrome.tabs.query({active:true,currentWindow:true});tabId=tabs[0]?.id;
  }
  if(!Number.isInteger(tabId)){status('Open a train result tab first.');return;}
  try{
    const reply=await chrome.tabs.sendMessage(tabId,{type:'routewise:capture-train-results'});
    if(!reply?.ok)throw new Error('Train page did not respond.');
    displayTrainCapture(task,reply);
  }catch(error){$('trainImportStatus').textContent='Train results are not ready. Finish loading the Omio results page, then click Capture visible train results. You can also paste a single journey card.';}
}
async function openAndImportTrain(task){
  if(trainImportBusy)return {ok:false,error:'Another train search is active'};
  trainImportBusy=true;
  openTrainImport(task.key);
  try{
    const openedUrl=trainSearchUrl(task);
    const tab=await chrome.tabs.create({url:openedUrl});
    if(!Number.isInteger(tab?.id))throw new Error('Chrome did not open the train search tab.');
    trainResearchTabId=tab.id;
    $('trainImportStatus').textContent='Waiting for Omio to load and for its journey list to stop changing (up to 90 seconds).';
    const wait=await waitForStableTrainResults({
      read:async()=>{
        // Chrome's load event can precede Omio's dynamically rendered results.
        const current=await chrome.tabs.get(tab.id);
        if(current.status!=='complete')return null;
        const reply=await chrome.tabs.sendMessage(tab.id,{type:'routewise:capture-train-results'});
        return reply?.ok?{...reply,tabComplete:true}:null;
      },
      task,
      shouldStop:()=>trainBatchStop,
      onProgress:({elapsedMs,settling,journeysSeen,matchingSeen})=>{
        const secs=Math.round(elapsedMs/1000);
        if(secs===0 || secs%6<2){
          $('trainImportStatus').textContent=settling
            ? `Omio: ${journeysSeen} priced journey card(s), ${matchingSeen} exact-station match(es). Waiting for matching fares to settle… (${secs}s)`
            : `Waiting for readable Omio results… (${secs}s / 90s). No fare has been saved.`;
        }
      }
    });
    if(wait.status==='stopped'){
      $('trainImportStatus').textContent='Train batch stopped. The current search tab remains open; no fare was saved.';
      return {ok:false,tabId:tab.id,error:'Stopped by user'};
    }
    if(wait.status==='review'){
      // Results appeared but never stabilized; preserve them for an explicit
      // traveler review rather than discarding them after the timeout.
      displayTrainCapture(task,wait.capture);
      $('trainImportStatus').textContent='Omio displayed journey prices but the list kept changing. Review the captured train, date and exact stations; then check the confirmation box and choose Cache indicative train quote. The batch is paused.';
      return {ok:false,tabId:tab.id,error:'Prices need review'};
    }
    if(wait.status!=='ready'){
      $('trainImportStatus').textContent='No readable Omio journey cards appeared within 90 seconds. The batch is paused. Finish loading the tab, then click Capture visible train results; no price was saved.';
      return {ok:false,tabId:tab.id,error:'Train results not ready'};
    }
    const reply=wait.capture;
    displayTrainCapture(task,reply);
    const parsed=parseTrainCapture(reply,task);
    if(reply.cardSource!=='omio_result_cards'){
      $('trainImportStatus').textContent='This site did not expose supported Omio result cards. Review the original page, then capture/paste a journey and save it manually. The train queue is paused.';
      return {ok:false,tabId:tab.id,error:'Train result layout needs review'};
    }
    if(!parsed.options.length){
      $('trainImportStatus').textContent=`Omio loaded ${parsed.journeyCardsSeen} journey(s), but none match both ${task.from} and ${task.to} with a readable EUR price and times. Do not import a different station. The train queue is paused.`;
      return {ok:false,tabId:tab.id,error:'Different stations or no matching fares'};
    }
    const evidence=automaticTrainSearchEvidence(reply,task,{openedUrl});
    if(!evidence){
      $('trainImportStatus').textContent=`Omio returned ${parsed.options.length} exact-station fare(s), but the requested day could not be matched to the opened search. Check ${task.date} and both stations, then manually confirm and cache the quote. Batch paused.`;
      return {ok:false,tabId:tab.id,error:'Provider search/date needs review'};
    }
    const timed=parsed.options.filter(option=>option.stationMatch&&option.departureClock&&option.arrivalClock);
    if(!timed.length){
      $('trainImportStatus').textContent='Omio journey times could not be verified. Review a specific train manually before saving. The queue is paused.';
      return {ok:false,tabId:tab.id,error:'Times need review'};
    }
    trainCache[task.key]={...parsed,selected:timed[0],quoteStatus:'indicative',searchEvidence:evidence};
    await persist();render();
    const dateNote=evidence.yearIndependentlyVerified
      ? 'Date matched on the results page.'
      : 'Month/day matched Omio; year comes from the original dated link and is not independently verified.';
    status(`Auto-cached indicative ${money(timed[0].fareEur)} for ${task.from} → ${task.to}. ${dateNote} Check the provider before booking.`);
    return {ok:true,tabId:tab.id};
  }catch(error){
    $('trainImportStatus').textContent=`Train search: ${error.message}. Queue paused; no fare was saved.`;
    return {ok:false,error:error.message};
  }finally{trainImportBusy=false;renderTrainResearch();}
}
async function importAllTrains({fromWorkflow=false}={}){
  if(trainBatchBusy||trainImportBusy||(workflowRunning&&!fromWorkflow))return null;
  trainBatchBusy=true;trainBatchStop=false;renderTrainResearch();
  let success=0,needsReview=0,pausedTask=null;
  try{
    for(const task of trainTasks().filter(t=>!trainCache[t.key])){
      if(trainBatchStop)break;
      status(`Researching train ${task.from} → ${task.to} on ${task.date}...`);
      const result=await openAndImportTrain(task);
      if(result?.ok){success++;continue;}
      needsReview++;
      pausedTask=task;
      // Do NOT silently jump to the next search when Omio is still loading,
      // redirects away from the exact date, or requires manual review.
      break;
    }
    const summary=pausedTask
      ? `${success} train search(es) cached as indicative. Paused at ${pausedTask.from} → ${pausedTask.to} (${pausedTask.date}): ${trainBatchStop?'stopped by user':'results not ready or need review'}. The current tab is still open; capture/review this train before continuing. No unchecked fares recorded.`
      : `${success} train search(es) cached as indicative; ${needsReview} need review${trainBatchStop?' (stopped early)':''}. No unchecked train fares were recorded.`;
    status(summary);
    if(fromWorkflow)$('workflowStatus').textContent=summary;
    return {success,needsReview,paused:Boolean(pausedTask),summary};
  }finally{trainBatchBusy=false;trainBatchStop=false;renderTrainResearch();}
}

function broadTasks(){return researchTasks(visibleRoutes());}
function renderBroadResearch(){
  const tasks=broadTasks();
  const pending=tasks.filter(task=>!broadCache[task.key]);
  const matched=tasks.filter(task=>broadCache[task.key]);
  const rows=compareBroadRoutes(visibleRoutes(),broadCache,offers,roundTripTickets,
    {bufferMinutes:Number(trip.connectionBuffer)||180,groundTimes,groundQuotes:{},trainCache});
  const importing=broadImportBusy || broadBatchRunning || workflowRunning;
  $('broadImportAll').disabled=importing || pending.length===0;
  $('broadOpenNext').disabled=importing || pending.length===0;
  $('showGoogleFlightsOverlay').disabled=importing;
  $('broadStopImport').hidden=!broadBatchRunning;
  $('broadStopImport').disabled=broadBatchCancelRequested;
  $('broadStats').textContent=`${tasks.length} unique one-way flight searches · ${matched.length} cached · ${pending.length} pending · ${trainResearchTasks(visibleRoutes()).length} unique train search(es) below`;
  const excludedTasks=researchTasks(candidatePool()).filter(task=>hasNoFlightsResult(task.key,unavailableFlights));
  $('broadSearches').innerHTML=tasks.length?tasks.map(task=>{
    const record=broadCache[task.key];
    const statusText=record?`${record.options.length} options · ${researchAge(record)==='stale'?'older than 24h':'cached'}`:'Needs research';
    return `<div class="broad-task"><div><strong>${escapeHtml(task.leg.from)} → ${escapeHtml(task.leg.to)} · ${escapeHtml(task.leg.date)}</strong>
      <small>${escapeHtml(statusText)} · used by ${task.routeCount} route(s)</small></div>
      <div><button type="button" class="secondary" data-broad-open="${escapeHtml(task.key)}">${record?'Refresh':'Open'} ↗</button>
      ${record?`<button type="button" class="ghost" data-broad-remove="${escapeHtml(task.key)}">Clear</button>`:''}
      <button type="button" class="ghost" data-broad-no-flights="${escapeHtml(task.key)}" ${importing?'disabled':''}>No flights found</button></div></div>
      ${record?`<details class="broad-options"><summary>View ${record.options.length} captured flight options</summary>
        ${record.options.map(item=>`<div class="broad-option"><div><strong>${escapeHtml(item.departureClock)} → ${escapeHtml(item.arrivalClock)}${item.arrivalDayOffset?` (+${item.arrivalDayOffset}d)`:''}</strong> · ${escapeHtml(item.carrier)}${item.stops?` · ${item.stops} stop(s)`:' · Nonstop'}</div><strong>${money(item.estimatedEur)}</strong></div>`).join('')}
        <p class="helper">Indicative one-way prices · ${escapeHtml(record.capturedAt||'Capture time unknown')} · Check baggage and seller for finalists.</p></details>`:''}`;
  }).join(''):'<p class="helper">No available candidate flight searches.</p>';
  if(excludedTasks.length){
    $('broadSearches').insertAdjacentHTML('beforeend',excludedTasks.map(task=>
      `<div class="broad-task"><div><strong>${escapeHtml(task.leg.from)} → ${escapeHtml(task.leg.to)} · ${escapeHtml(task.leg.date)}</strong>
       <small>No flights found · ${task.routeCount} candidate(s) excluded · ${unavailableFlights[task.key]?.source==='google_flights_exact_search'?'explicit Google Flights search result':'checked by user'}</small></div>
       <div><button type="button" class="secondary" data-broad-restore="${escapeHtml(task.key)}" ${importing?'disabled':''}>Retry / undo exclusion</button></div></div>`).join(''));
  }
  const choices=tasks.map(task=>({task,matched:pendingFlightCapture?.text &&
    parseGoogleFlightsSearchResults(pendingFlightCapture.text)?.options?.some(o=>
      searchOptionMatchesLeg(o,task.leg))})).filter(row=>row.matched);
  const selection=$('broadCaptureTask');
  const before=selection.value;
  selection.replaceChildren(new Option('Select a matching one-way search',''));
  choices.forEach(({task})=>selection.add(new Option(`${task.leg.from} → ${task.leg.to} · ${task.leg.date}`,task.key)));
  const preferred=choices.find(x=>x.task.key===activeResearchKey)?.task.key;
  selection.value=choices.some(x=>x.task.key===before)?before:preferred||(choices.length===1?choices[0].task.key:'');
  $('broadCaptureArea').hidden=!pendingFlightCapture?.text;
  if(pendingFlightCapture?.text){
    const count=Number(pendingFlightCapture.captureCount)||1;
    $('broadCaptureStatus').textContent=`${count} captured card(s). ${choices.length?'Choose the matching one-way search and save its indicative results (or results from a RouteWise-opened one-way search are cached automatically).':'No candidate flight search matches the captured airports/date.'}`;
    $('broadCaptureSave').disabled=importing || !choices.length;
  }
  // Compare complete, non-conflicting options before partial subtotals.
  // Honor the traveler's selected planning priority without inventing total journey time.
  const shown=rankItineraryComparisons(rows,trip.goal).slice(0,5);
  $('broadComparison').innerHTML=shown.map((r,index)=>{
    const subtotal=r.total===null?`${money(r.known)}+` :money(r.total);
    const assessment=r.assessment;
    const explanation=rankingExplanation(trip.goal,assessment);
    const flag=r.missing?`${r.missing} unpriced leg(s)` :r.conflicts?`${r.conflicts} blocked connection(s)`:
      r.uncheckedConnections?`${r.uncheckedConnections} connection(s) to check`:'No known ground-buffer conflict';
    const preview=r.selected.filter(x=>['flight_estimate','train_estimate'].includes(x.kind)).map(x=>
      `${x.leg.mode==='train'?(x.leg.fromLabel||x.leg.from)+'–'+(x.leg.toLabel||x.leg.to):x.leg.from+'–'+x.leg.to} ${x.option?.departureClock||''} ${money(x.costEur)}`).join(' · ');
    return `<div class="broad-route"><div class="broad-route-head"><strong>${index+1}. ${escapeHtml(r.route.name)}</strong><strong>${escapeHtml(subtotal)}</strong></div>
    <div class="helper"><strong>${escapeHtml(assessment.label)}</strong> · ${escapeHtml(flag)} · ${r.trainCount} train leg(s), no assumed fares</div>
    <div class="helper">${escapeHtml(explanation)}</div>
    ${assessment.flags.length?`<details class="recommendation-caveats"><summary>What still needs checking</summary><ul>${assessment.flags.map(item=>`<li>${escapeHtml(item)}</li>`).join('')}</ul></details>`:''}
    ${r.destinationHours!==null?`<div class="helper">Approx. ${r.destinationHours} hours at ${escapeHtml(r.route.primaryStay?.destination||'destination')} based on imported flight times</div>`:''}
    ${r.observedDurationMinutes?`<div class="helper">Known scheduled flight time: ${Math.floor(r.observedDurationMinutes/60)}h ${r.observedDurationMinutes%60}m${r.unknownDurations?` · ${r.unknownDurations} unknown duration(s)`: ''} (excludes waits and transfers)</div>`:''}
    ${r.selected.some(s=>s.cacheAge==='stale')?'<div class="helper">Some flight quotes are older than 24 hours; refresh before deciding.</div>':''}
    ${preview?`<div class="helper">${escapeHtml(preview)}</div>`:''}</div>`;
  }).join('')||'<p class="helper">No route comparisons yet.</p>';
  $('broadSummary').textContent=!tasks.length ? (excludedTasks.length ? 'No available flight searches remain. Undo a no-flights exclusion below or generate other route candidates.' : 'Generate candidate routes to compare flight prices.') : pending.length ?
    `Research ${pending.length} remaining one-way search(es) for a complete first-pass cost comparison.`:
    `All ${tasks.length} unique flight searches have cached results. Search quotes are preliminary; confirm finalist tickets and baggage.`;
}

// Import a single dated one-way search. Batch mode reuses a successful tab,
// waits for the exact capture to be validated and cached, and only then advances.
// Google Flights can change its markup; failures remain available for review.
let broadImportBusy = false;
let workflowRunning = false;
let broadBatchRunning = false;
let broadBatchCancelRequested = false;
async function openAndImportResearch(task,{reuseTabId=null}={}) {
  if (broadImportBusy) return {ok:false,error:'Another flight import is already in progress.'};
  broadImportBusy = true;
  activeResearchKey = task.key;
  renderBroadResearch();
  const expectedUrl = googleFlightsSearchUrl(task.leg);
  let tab;
  try {
    if (Number.isInteger(reuseTabId)) {
      try { tab=await chrome.tabs.update(reuseTabId,{url:expectedUrl,active:true}); }
      catch { tab=null; } // A traveler may have closed the research tab.
    }
    if(!tab)tab=await chrome.tabs.create({url:expectedUrl});
    if (!Number.isInteger(tab?.id)) throw new Error('Chrome did not return a tab ID.');
    status(`Searching ${task.leg.from} to ${task.leg.to} on ${task.leg.date}. Waiting for Google Flights cards...`);
    for(let attempt=0;attempt<40;attempt++) {
      let reply;
      try {
        reply=await chrome.tabs.sendMessage(tab.id,{
          type:'routewise:auto-import-flight-search',expectedUrl
        });
      } catch(error) {
        if (/No tab with id/i.test(error?.message || '')) {
          const message='Google Flights tab was closed before import finished.';
          status(message);return {ok:false,error:message,tabId:tab.id};
        }
        // The content script may not yet be installed in the new document.
        await new Promise(resolve=>setTimeout(resolve,800));
        continue;
      }
      if(reply?.ok && reply.unavailable){
        // A positive no-options page must match the exact tfs/date search URL.
        // Import failures and nearby-airport suggestions never trigger this.
        if(reply.evidence!=='explicit_no_matching_options' ||
          !sameExactGoogleFlightsSearch(reply.sourceUrl,expectedUrl)){
          const message='Unverified empty-results signal; please check the exact search manually.';
          status(message);return {ok:false,error:message,tabId:tab.id};
        }
        unavailableFlights[task.key]={status:'no_flights',source:'google_flights_exact_search',
          observedAt:new Date().toISOString()};
        delete broadCache[task.key];
        await persist();render();
        const eliminated=researchTasks(candidatePool()).find(item=>item.key===task.key)?.routeCount||1;
        status(`Google Flights found no matching options for ${task.leg.from} → ${task.leg.to} on ${task.leg.date}. Excluded ${eliminated} candidate(s). Nearby-airport alternatives were ignored; use Retry / undo exclusion to reverse.`);
        return {ok:true,unavailable:true,tabId:tab.id};
      }
      if(reply?.ok) {
        try {
          // Do not advance on a content-script acknowledgement alone: the
          // captured search must match this task and survive validation.
          const {pendingFlightCapture:capture}=await chrome.storage.local.get('pendingFlightCapture');
          if(!captureFromOpenedOneWaySearch(capture,task)) {
            throw new Error('Captured cards did not match this one-way search and date.');
          }
          const cached=await autoCacheBroadCapture(capture);
          if(!cached || broadCache[task.key]?.capturedAt!==capture.capturedAt) {
            throw new Error('The matching results could not be saved.');
          }
          return {ok:true,tabId:tab.id,options:broadCache[task.key].options.length};
        } catch(error) {
          const message=`Import needs review: ${error.message}`;
          status(message);return {ok:false,error:message,tabId:tab.id};
        }
      }
      if(!reply?.retry) {
        const message=`Automatic import unavailable: ${reply?.error || 'No flight results returned'}. Use the manual Google Flights overlay.`;
        status(message);return {ok:false,error:message,tabId:tab.id};
      }
      await new Promise(resolve=>setTimeout(resolve,800));
    }
    const message='Google Flights did not become available. Use the manual import overlay on its tab.';
    status(message);return {ok:false,error:message,tabId:tab.id};
  } catch(error) {
    const message=`Could not open/import flight search: ${error.message}`;
    status(message);return {ok:false,error:message,tabId:tab?.id};
  } finally {
    broadImportBusy=false;
    renderBroadResearch();
  }
}
$('broadSearches').addEventListener('click',async event=>{
  const mark=event.target.closest('button[data-broad-no-flights]');
  const restore=event.target.closest('button[data-broad-restore]');
  if(mark || restore){
    if(broadBatchRunning || broadImportBusy || workflowRunning)return;
    const key=mark?.dataset.broadNoFlights || restore.dataset.broadRestore;
    const task=researchTasks(candidatePool()).find(item=>item.key===key);
    if(!task)return;
    if(mark){
      if(!window.confirm(`Did you check flights from ${task.leg.from} to ${task.leg.to} on ${task.leg.date} and find NO available flights? A failed import, empty page, or missing price does not count. This excludes ${task.routeCount} candidate(s).`))return;
      unavailableFlights[key]={status:'no_flights',confirmedAt:new Date().toISOString(),source:'user_review'};
      delete broadCache[key];
    }else{
      delete unavailableFlights[key];
    }
    await persist();render();
    status(mark ? `Excluded ${task.routeCount} route(s) containing ${task.leg.from} → ${task.leg.to} on ${task.leg.date}.`
      : `Restored routes containing ${task.leg.from} → ${task.leg.to} on ${task.leg.date}. Research this flight again.`);
    return;
  }
  const open=event.target.closest('button[data-broad-open]');
  const clear=event.target.closest('button[data-broad-remove]');
  if(broadBatchRunning || broadImportBusy)return;
  if(clear){delete broadCache[clear.dataset.broadRemove];await persist();render();return;}
  if(!open)return;
  const task=broadTasks().find(item=>item.key===open.dataset.broadOpen);
  if(task)await openAndImportResearch(task);
});
$('broadOpenNext').addEventListener('click',async()=>{
  if(broadImportBusy||broadBatchRunning)return;
  const task=broadTasks().find(item=>!broadCache[item.key]);
  if(!task){status('All unique flight searches already have cached results. Open an individual search to refresh it.');return;}
  await openAndImportResearch(task);
});
$('broadStopImport').addEventListener('click',()=>{
  if(!broadBatchRunning)return;
  broadBatchCancelRequested=true;
  $('broadStopImport').disabled=true;
  $('broadBatchProgress').textContent='Stopping after the current flight search finishes...';
});
async function importAllMissingFlights({fromWorkflow=false}={}) {
  if(broadBatchRunning||broadImportBusy||(workflowRunning&&!fromWorkflow))return null;
  const todo=broadTasks().filter(task=>!broadCache[task.key]);
  if(!todo.length){status('All unique flight searches are already cached. Use Refresh on an individual leg if needed.');return {total:0,completed:0,imported:0,failures:[],stopped:false};}
  broadBatchRunning=true;
  broadBatchCancelRequested=false;
  renderBroadResearch();
  let report;
  try {
    report=await runFlightImportQueue(broadTasks(),{
      isCached:task=>Boolean(broadCache[task.key]),
      shouldStop:()=>broadBatchCancelRequested,
      shouldSkip:task=>!broadTasks().some(active=>active.key===task.key),
      importTask:(task,options)=>openAndImportResearch(task,options),
      onProgress:progress=>{
        const failures=progress.failures.length;
        if(progress.current){
          const {task,number}=progress.current;
          const message=`Flight ${number} of ${progress.total}: ${task.leg.from} → ${task.leg.to} (${task.leg.date}). ${progress.imported} imported${progress.unavailable?`, ${progress.unavailable} no-options`:''}${failures?`, ${failures} need review`:''}.`;
          $('broadBatchProgress').textContent=message;
          if(fromWorkflow)$('workflowStatus').textContent=message;
        }else if(progress.completed===progress.total || progress.stopped){
          const message=`${progress.imported} imported · ${progress.unavailable||0} no-options · ${progress.skipped||0} no longer needed${failures?` · ${failures} need review`:''}${progress.stopped?' (stopped early)':''}.`;
          $('broadBatchProgress').textContent=message;
          if(fromWorkflow)$('workflowStatus').textContent=message;
        }
      }
    });
    const failures=report.failures.length;
    const summary=`${report.imported} of ${report.total} missing one-way searches imported; ${report.unavailable} confirmed no-options; ${report.skipped} skipped as irrelevant${failures?`; ${failures} need manual review`:''}${report.stopped?' (stopped early)':''}. Saved fares were not changed.`;
    $('broadBatchProgress').textContent=summary;
    status(summary);
    return report;
  } catch(error) {
    const message=`Batch import stopped unexpectedly: ${error.message}. Any completed searches remain cached.`;
    $('broadBatchProgress').textContent=message;
    status(message);
    return null;
  } finally {
    broadBatchRunning=false;
    broadBatchCancelRequested=false;
    renderBroadResearch();
  }
}
$('broadImportAll').addEventListener('click',()=>{void importAllMissingFlights();});
// User-facing single action: generate first, then research only the missing unique flights.
// Keep each route visible while the queue runs; the comparison rerenders as captures arrive.
$('findBestRoutes').addEventListener('click',async()=>{
  if(workflowRunning||broadBatchRunning||broadImportBusy||$('interpret').disabled)return;
  workflowRunning=true;
  $('findBestRoutes').disabled=true;
  $('findBestRoutes').textContent='Finding your routes…';
  $('workflowStop').hidden=false;
  $('workflowStop').disabled=true; // Enable only once flight research begins.
  renderBroadResearch();
  try {
    const outcome=await runBestRouteWorkflow({
      generateRoutes:generateCandidateRoutes,
      getSearchCounts:()=>{
        const tasks=broadTasks();
        return {all:tasks.length,pending:tasks.filter(task=>!broadCache[task.key]).length};
      },
      importFlights:()=>importAllMissingFlights({fromWorkflow:true}),
      onStage:({phase,counts})=>{
        if(phase==='generating') $('workflowStatus').textContent='Building candidate itineraries…';
        if(phase==='researching') {
          $('findBestRoutes').textContent='Researching flights…';
          $('workflowStop').disabled=false;
          $('workflowStatus').textContent=`Researching ${counts.pending} missing flight search(es) across ${counts.all} unique legs…`;
        }
      }
    });
    let trainReport=null;
    if(!['generation-failed','research-failed','stopped'].includes(outcome.status) && trainTasks().some(task=>!trainCache[task.key])){
      $('findBestRoutes').textContent='Researching trains…';
      $('workflowStop').disabled=false;
      $('workflowStatus').textContent='Researching train searches; any ambiguous result will stay unpriced for review…';
      trainReport=await importAllTrains({fromWorkflow:true});
    }
    const report=outcome.report;
    const resultMessage=outcome.status==='generation-failed'
      ? 'Could not build routes. Review your trip details and try again.'
      : outcome.status==='no-flights'
        ? 'Routes are ready. No flight searches are required for these options.'
        : outcome.status==='cached'
          ? 'Route comparisons are ready using existing cached flight estimates. Refresh older prices before booking.'
          : outcome.status==='research-failed'
            ? 'Routes are ready, but flight research could not finish. You can retry missing flights below.'
            : `${report?.imported||0} flight search(es) imported; ${report?.unavailable||0} confirmed no-options; ${report?.skipped||0} no longer needed. ${report?.failures?.length||0} need manual review${outcome.status==='stopped'?' (stopped early)':''}. Compare your remaining options below; prices are estimates.`;
    $('workflowStatus').textContent=resultMessage+(trainReport?` Train search results: ${trainReport.success} indicative imported; ${trainReport.needsReview} need review.`:'');
    if(outcome.status!=='generation-failed')$('routeResults').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){
    $('workflowStatus').textContent=`Could not complete route research: ${error.message}. Check the details below and retry.`;
    status(`Route research error: ${error.message}`);
  }finally{
    workflowRunning=false;
    $('findBestRoutes').disabled=false;
    $('findBestRoutes').textContent='Find my best routes ↗';
    $('workflowStop').hidden=true;
    $('workflowStop').disabled=false;
    renderBroadResearch();
  }
});
$('workflowStop').addEventListener('click',()=>{
  if(trainBatchBusy){trainBatchStop=true;$('workflowStop').disabled=true;$('workflowStatus').textContent='Stopping after the active train search…';return;}
  if(!workflowRunning||!broadBatchRunning)return;
  broadBatchCancelRequested=true;
  $('workflowStop').disabled=true;
  $('workflowStatus').textContent='Stopping after the current flight search…';
});

$('broadCaptureSave').addEventListener('click',async()=>{
  const task=broadTasks().find(item=>item.key===$('broadCaptureTask').value);
  if(!task)return;
  try{
    const record=captureBroadSearch(pendingFlightCapture,task,{confirmOneWay:$('broadConfirmOneWay').checked});
    broadCache[task.key]=record;
    await persist();render();
    status(`Cached ${record.options.length} one-way flight estimate(s) for ${task.leg.from} → ${task.leg.to} ${task.leg.date}. Updated preliminary route comparisons; verified fares were not changed.`);
  }catch(error){$('broadCaptureStatus').textContent=`Could not import for broad research: ${error.message}`;}
});

function lookupLeg(key) { return visibleRoutes().flatMap(route => route.legs).find(leg => leg.key === key); }
function linkedTicketFlightConflict(key,{departureClock='',carrier=''}={}){
  if(!ticketsUsingLeg(roundTripTickets,key).length)return false;
  const prior=flightResearch[key]||{};
  if(prior.departureClock && departureClock && prior.departureClock!==departureClock)return true;
  if(prior.carrier && carrier && prior.carrier!==carrier)return true;
  return false;
}

function announceSavedFare(leg, offer) {
  lastSavedFareKey=leg.key;
  const appearances=visibleRoutes().reduce((count,route)=>count+route.legs.filter(item=>item.key===leg.key).length,0);
  const total=money(offer.fare+offer.bagFee+offer.transferCost);
  lastSavedTicketKeys=[];
  const message=`Saved ${total} for ${leg.from} to ${leg.to} on ${leg.date}. Updated ${appearances} matching leg ${appearances===1?'entry':'entries'} across the route comparisons. Incomplete itineraries show a known subtotal, not a complete ticket total.`;
  $('priceSaveNotice').textContent=message;
  $('priceSaveNotice').hidden=false;
  render();
  const matched=[...document.querySelectorAll('[data-leg-key]')].find(node=>node.dataset.legKey===leg.key);
  matched?.scrollIntoView({behavior:'smooth',block:'center'});
  status(message);
}

function editOffer(key) {
  const linked=ticketsUsingLeg(roundTripTickets,key);
  if(linked.length){
    const pair=pairContainingLeg(visibleRoutes(),key);
    if(pair)openTicketEditor(pair.route.id,pair.outboundIndex);
    else status('This leg is linked to a round-trip ticket. Open the itinerary containing both flights to edit it.');
    return;
  }
  const leg = lookupLeg(key);
  if (!leg) { status('That leg no longer exists.'); return; }
  currentKey = key;
  const offer = offers[key];
  $('editingLeg').textContent = `${placeName(leg.from)} → ${placeName(leg.to)} · ${leg.date} · ${leg.mode}`;
  $('fare').value = offer?.fare ?? '';
  $('bagFee').value = offer?.bagFee ?? 0;
  $('transferCost').value = offer?.transferCost ?? 0;
  $('source').value = offer?.source ?? '';
  $('note').value = offer?.note ?? '';
  const time=Object.hasOwn(flightTimes,key)?flightTimes[key]:offer;
  $('departureClock').value = time?.departureClock ?? '';
  $('departureTimezone').value = time?.departureTimezone ?? '';
  $('editor').hidden = false;
  $('editor').scrollIntoView({behavior:'smooth',block:'start'});
  $('fare').focus();
}
function searchLeg(key) {
  const leg = lookupLeg(key);
  if (!leg) { status('That leg no longer exists.'); return; }
  try {
    const search=leg.mode==='train'?{provider:'Omio train search',url:trainSearchUrl(leg),datePreFilled:true}:transportSearch(leg);
    chrome.tabs.create({url:search.url});
    const routeText = `${placeName(leg.from)} → ${placeName(leg.to)} on ${leg.date}`;
    status(`Opened ${search.provider} for ${routeText}. ${search.datePreFilled ? 'Check that the route/date are correct. ' : 'Set the travel date manually; dates are not prefilled. '}Verify the exact terminals, actual service, transfer times, baggage and fares before recording a price.`);
  } catch (error) {
    status(`Could not open search: ${error.message}`);
  }
}

function searchRoundTrip(routeId, outboundIndex) {
  const route = visibleRoutes().find(candidate => candidate.id === routeId);
  if (!route) { status('That route no longer exists.'); return; }
  const match = findRoundTripPairs(route.legs).find(pair => pair.outboundIndex === outboundIndex);
  if (!match) { status('That route no longer contains a valid round-trip flight pair.'); return; }
  const outbound = route.legs[match.outboundIndex];
  const returning = route.legs[match.returnIndex];
  try {
    chrome.tabs.create({url: googleFlightsRoundTripUrl(outbound, returning)});
    status(`Opened a round-trip search ${outbound.from} → ${outbound.to} (${outbound.date}) returning ${returning.date}. These are tentative itinerary dates: verify both in Google Flights. A round-trip fare covers BOTH legs; do not save the full price twice.`);
  } catch (error) {
    status(`Could not open round-trip search: ${error.message}`);
  }
}

// When changing regions manually, clear a stop that belongs to a different region.
$('requestedRegion').addEventListener('change', () => {
  const region = $('requestedRegion').value;
  const preferred = $('preferred').value;
  // A newly entered region should not silently retain a vacation stop from the last trip.
  if(region && region !== trip.requestedRegion && preferred) $('preferred').value = '';
});
async function generateCandidateRoutes() {
  if(broadBatchRunning || broadImportBusy){status('Finish importing flight searches before regenerating routes.');return false;}
  $('generate').disabled=true;
  try {
    const guarded=protectReviewedTrip(getFormTrip(),{parsedPlan,parsedRequest});
    if(guarded.error)throw new Error(guarded.error);
    const next=guarded.trip;
    if(guarded.notices.length) $('preferred').value=next.preferred;
    const plan = generationPlan(next);
    const region = next.requestedRegion?.trim();
    let candidates = [];
    const requiresSuggestions = plan.destination_search === 'open' || plan.destination_search === 'region';
    if (requiresSuggestions) {
      const key=candidateKey(next);
      if (destinationCandidateKey===key && destinationCandidates.length) {
        candidates=destinationCandidates;
      } else {
        generationStatus(`Asking Groq for candidate cities ${region ? `in ${region}` : 'for this trip'}…`);
        const response=await fetch('http://127.0.0.1:8787/suggest-destinations',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({request:next.request,region:region||'',destinationSearch:plan.destination_search,origin:next.origin,destination:next.destination,
            startDate:next.startDate,endDate:next.endDate}),signal:AbortSignal.timeout(35000)
        });
        const data=await response.json();
        if(!response.ok) throw new Error(data.error||`Destination service returned ${response.status}`);
        if (!Array.isArray(data.candidates) || !data.candidates.length) throw new Error('No candidate cities returned.');
        candidates=data.candidates;
        destinationCandidates=candidates;
        destinationCandidateKey=key;
      }
    }
    // Named-destination journeys should also consider plausible connection
    // airports. This is a separate AI call, NOT a real timetable search.
    let hubs = null;
    let hubWarning = '';
    if (plan.destination_search === 'specified' && plan.preferred && plan.max_connections !== 0) {
      const key=hubKey(next,plan.max_connections);
      if(connectionCandidateKey === key &&
          (connectionCandidates.outbound?.length || connectionCandidates.inbound?.length)) {
        hubs=connectionCandidates;
      } else {
        generationStatus('Asking Groq for possible airport connections (not verified flights)…');
        try {
          const response=await fetch('http://127.0.0.1:8787/suggest-connections',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({request:next.request,origin:next.origin,preferred:next.preferred,
              destination:next.destination,startDate:next.startDate,endDate:next.endDate,
              maxConnections:plan.max_connections}),signal:AbortSignal.timeout(35000)
          });
          const data=await response.json();
          if(!response.ok)throw new Error(data.error||`Connection service returned ${response.status}`);
          if(!Array.isArray(data.outbound)||!Array.isArray(data.inbound))
            throw new Error('Unexpected connection response.');
          hubs={outbound:data.outbound,inbound:data.inbound};
          connectionCandidates=hubs;connectionCandidateKey=key;
        } catch(error) {
          // Preserve the useful direct candidate if the server or Groq fails.
          hubWarning=` Connection suggestions unavailable: ${error.message}. Only direct and explicitly requested patterns were generated.`;
        }
      }
    }
    const flightRoutes=generatePlannedRoutes(plan,{destinationCandidates:candidates,connectionCandidates:hubs});
    let nextRoutes=flightRoutes,groundNotice='';
    try {
      generationStatus('Checking local GTFS network for train, bus, and ferry trip patterns…');
      const flightLegs=flightRoutes.flatMap(route=>route.legs.map(({from,to})=>({from,to})));
      const response=await fetch('http://127.0.0.1:8787/discover-ground',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({request:next.request,origin:plan.origin,preferred:plan.preferred,
          destination:plan.destination,departureDate:plan.depart_earliest,flightLegs}),signal:AbortSignal.timeout(20000)
      });
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||`Ground network HTTP ${response.status}`);
      nextRoutes=expandRoutesWithGround(plan,flightRoutes,data.alternatives||[],{maxRoutes:5,bufferMinutes:Number(next.connectionBuffer)||180});
      const modeCount=nextRoutes.filter(route=>route.networkEvidence).length;
      if(modeCount){const dateCount=nextRoutes.filter(route=>route.networkEvidence?.dateVerified).length;groundNotice=` ${modeCount} mixed-mode, ${dateCount} with a dated GTFS timetable.`;}
      else if(!data.hasNetwork)groundNotice=' No GTFS feeds loaded. Optional: npm run sync:transit (see README).';
      else groundNotice=' The imported GTFS feeds did not show a relevant intercity connection.';
    }catch(error){groundNotice=` Ground-network lookup unavailable: ${error.message}. Flight candidates preserved.`;}
    trip=next;routes=nextRoutes;sessionCleared=false;groundQuotes={};
    $('editor').hidden=true;currentKey=null;
    await persist();render();
    const withConnections=routes.filter(route=>route.legs.length>2).length;
    generationStatus(`${guarded.notices.join(' ')} Generated ${routes.length} candidate routes${withConnections?` (${withConnections} with connections)`:''}.${hubWarning}${groundNotice}`.trim());
    return routes.length > 0;
  } catch(error) {generationStatus(`Could not generate routes: ${error.message}`);return false;}
  finally {$('generate').disabled=false;}
}
// Keep the original generation-only control for advanced troubleshooting.
$('generate').addEventListener('click', async () => {
  if(broadBatchRunning || broadImportBusy){status('Finish importing flight searches before regenerating routes.');return;}
  if(workflowRunning)return;
  await generateCandidateRoutes();
});
$('resetPlan').addEventListener('click', async()=>{
  if ($('interpret').disabled || $('generate').disabled || broadImportBusy || broadBatchRunning || workflowRunning) {
    status('Finish the current search or interpretation before starting fresh.');
    return;
  }
  if (!confirm('Clear the displayed trip, selections, route results, and unfinished edits? Your trip description, saved baggage, saved fares, and cached research will be kept.')) return;
  groundQuotes={};
  const description=$('request').value; // Include edits not yet saved to storage.
  trip={...DEFAULT_TRIP,origin:'',preferred:'',destination:'',requestedRegion:'',
    startDate:'',endDate:'',request:description};
  routes=[]; sessionCleared=true;
  parsedPlan=null;parseWarnings=[];parseSource='';parsedRequest=''; // Keep diagnostics in developer console.
  activeResearchKey=null;currentKey=null;importLegKey=null;ticketEditorPair=null;
  ticketEditorRaw='';ticketEditorQuoteOptions=[];lastSavedTicketKeys=[];lastSavedFareKey=null;
  manualDraftRows=[];manualDraftId=null;pendingFlightCapture=null;
  $('manualEditor').hidden=true; $('flightImport').hidden=true;
  $('ticketEditor').hidden=true; $('editor').hidden=true;
  $('priceSaveNotice').hidden=true; $('priceSaveNotice').textContent='';
  $('generationStatus').textContent='';
  $('workflowStatus').textContent='';
  $('broadConfirmOneWay').checked=false;
  $('broadCaptureArea').hidden=true;
  setForm();showPlanPreview();showCaptureNotice();render();
  await persist();
  await chrome.storage.local.remove('pendingFlightCapture');
  $('tripSetup').open=true;
  status('Started a fresh planning view. Your trip description, saved fares, and research caches are still available.');
});
$('connectionBuffer').addEventListener('change', async()=>{
  trip.connectionBuffer=$('connectionBuffer').value;
  await persist();render();
});
$('saveBag').addEventListener('click', async () => {
  const candidate = {
    name: $('bagName').value.trim(), length: Number($('bagL').value),
    width: Number($('bagW').value),depth: Number($('bagD').value),kg:Number($('bagKg').value)
  };
  if (!candidate.name || [candidate.length,candidate.width,candidate.depth,candidate.kg].some(v=>!Number.isFinite(v)||v<=0)) {
    status('Enter a bag name and positive dimensions/weight.'); return;
  }
  bag = candidate; await persist(); status('Bag profile saved. Fare-specific baggage compatibility is not yet automated.');
});
// All unverified ground terminal names come from user input, not from a
// supposed global train/ferry timetable. A route may be copied and edited
// without affecting the original flight candidate or its saved offers.
function renderManualEditor(){
  const editor=$('manualEditor');
  if(!manualDraftRows.length){editor.hidden=true;return;}
  const kindOptions=selected=>TERMINAL_KINDS.map(kind=>`<option value="${kind}" ${kind===selected?'selected':''}>${kind.replace('_',' ')}</option>`).join('');
  const modeOptions=selected=>TRAVEL_MODES.map(mode=>`<option value="${mode}" ${mode===selected?'selected':''}>${modeLabel(mode)}</option>`).join('');
  $('manualLegRows').innerHTML=manualDraftRows.map((row,index)=>`<div class="manual-leg" data-index="${index}">
    <div class="manual-row-heading"><strong>Leg ${index+1}</strong><div><button class="ghost" type="button" data-insert-leg="${index}">+ Transfer after</button> <button class="danger" type="button" data-delete-leg="${index}" ${manualDraftRows.length<=1?'disabled':''}>Remove</button></div></div>
    <div class="two-col"><div><label>Mode</label><select data-field="mode">${modeOptions(row.mode)}</select></div>
    <div><label>Travel date</label><input data-field="date" type="date" value="${escapeHtml(row.date)}"/></div></div>
    <div class="two-col"><div><label>From terminal type</label><select data-field="fromKind">${kindOptions(row.fromKind)}</select></div>
    <div><label>To terminal type</label><select data-field="toKind">${kindOptions(row.toKind)}</select></div></div>
    <label>From (airport code or exact stop name)</label><input data-field="from" value="${escapeHtml(row.from)}" placeholder="e.g. Barcelona Sants" />
    <label>To (airport code or exact stop name)</label><input data-field="to" value="${escapeHtml(row.to)}" placeholder="e.g. Madrid Atocha" />
  </div>`).join('');
  editor.hidden=false;
}
function syncManualDraft(){
  for(const node of $('manualLegRows').querySelectorAll('.manual-leg')){
    const row=manualDraftRows[Number(node.dataset.index)];
    if(!row)continue;
    for(const field of ['mode','date','fromKind','toKind','from','to'])row[field]=node.querySelector(`[data-field="${field}"]`).value;
  }
}
function openManualEditor(routeId){
  const route=visibleRoutes().find(candidate=>candidate.id===routeId);
  if(!route){status('Choose a route to copy.');return;}
  manualDraftRows=draftFromRoute(route);
  manualDraftId=route.manual?route.id:null;
  $('manualName').value=route.manual?route.name:`Multimodal alternative: ${route.name}`;
  renderManualEditor();
  $('manualEditor').scrollIntoView({behavior:'smooth',block:'start'});
  status('Edit terminal types and names, then add transfers if needed. No train, bus, ferry or flight service is assumed to exist.');
}
$('manualLegRows').addEventListener('change',(event)=>{
  const select=event.target.closest('select[data-field="mode"]');
  if(!select)return;
  const block=select.closest('.manual-leg');
  const preset=select.value==='train'?'station':select.value==='ferry'?'port':select.value==='flight'?'airport':null;
  if(preset){
    block.querySelector('[data-field="fromKind"]').value=preset;
    block.querySelector('[data-field="toKind"]').value=preset;
  }
});
$('manualLegRows').addEventListener('click',event=>{
  const add=event.target.closest('[data-insert-leg]');
  const remove=event.target.closest('[data-delete-leg]');
  if(!add && !remove)return;
  syncManualDraft();
  if(add){const i=Number(add.dataset.insertLeg);if(manualDraftRows.length>=16){status('Maximum 16 legs per manual route.');return;}
    manualDraftRows.splice(i+1,0,insertedTransfer(manualDraftRows,i));}
  else if(manualDraftRows.length>1)manualDraftRows.splice(Number(remove.dataset.deleteLeg),1);
  renderManualEditor();
});
$('closeManual').addEventListener('click',()=>{manualDraftRows=[];manualDraftId=null;renderManualEditor();});
$('manualForm').addEventListener('submit',async event=>{
  event.preventDefault();
  try{
    syncManualDraft();
    // The source trip is the reviewed form used to generate candidate routes.
    const manual=buildManualRoute({name:$('manualName').value,rows:manualDraftRows,trip,
      primary:trip.preferred,id:manualDraftId||undefined});
    if(manualDraftId)manualRoutes=manualRoutes.filter(route=>route.id!==manualDraftId);
    manualRoutes.push(manual);
    manualDraftRows=[];manualDraftId=null;renderManualEditor();
    await persist();render();
    status('Saved a manual mixed-mode route for comparison. Verify terminals, dates, services and transfers before using any fare.');
  }catch(error){status(`Could not save multimodal route: ${error.message}`);}
});

// A round trip is priced as ONE booking linking both flight leg keys. This
// editor can start from a paired route button or a user-pasted selected-flights
// page; the Google Flights quote is never silently treated as a confirmed fare.
function openTicketEditor(routeId,outboundIndex,sourceText='',sourceUrl=''){
  const route=visibleRoutes().find(r=>r.id===routeId);
  const pair=pairedFlightLegs(route,outboundIndex);
  if(!pair){status('This itinerary has no matching outbound/return flight pair.');return;}
  ticketEditorPair=pair;
  const old=roundTripTickets[ticketKey(pair.outbound.key,pair.returning.key)];
  $('ticketForm').reset();
  $('ticketLegs').textContent=`OUTBOUND ${pair.outbound.from} → ${pair.outbound.to} · ${pair.outbound.date}\nRETURN ${pair.returning.from} → ${pair.returning.to} · ${pair.returning.date}`;
  $('ticketTotal').value=old?.totalEur??'';
  $('ticketSeller').value=old?.seller??'';
  $('ticketSource').value=old?.sourceUrl||sourceUrl||'';
  $('ticketNotes').value=old?.notes||'';
  $('ticketConfirmed').checked=false;
  $('ticketBagVerified').checked=false;
  $('ticketMessage').textContent=old?'Editing the existing shared ticket will replace its combined total.':'Confirm the actual fare for BOTH directions, including overhead baggage, before saving.';
  $('removeTicket').hidden=!old;
  const capture=sourceText||pendingFlightCapture?.text||'';
  updateTicketQuotesFromCapture(capture,sourceUrl||pendingFlightCapture?.sourceUrl||'',{autoPrefillSingle:true});
  $('ticketEditor').hidden=false;
  $('ticketEditor').scrollIntoView({behavior:'smooth',block:'start'});
}
// An imported result-card quote can prefill an open ticket editor, but it
// cannot identify a return-flight selection or booking seller by itself.
function useTicketQuote(index){
  const quote=ticketEditorQuoteOptions[index];
  if(!quote)return;
  $('ticketQuoteChoice').value=String(index);
  $('ticketTotal').value=String(quote.amount);
  $('ticketSeller').value=quote.seller; // Blank for result cards: not a verified seller.
  $('ticketConfirmed').checked=false;
  $('ticketBagVerified').checked=false;
  $('ticketMessage').textContent=quote.kind==='search_card' ?
    `Prefilled EUR ${quote.amount} from the ${quote.carrier} ${quote.from} → ${quote.to} search card. This is only a ROUND-TRIP estimate; Google Flights has not confirmed the return flight or seller. Select both flights with the seller, check baggage and booking fees, then confirm the actual total before saving.` :
    'Prefilled the selected round-trip booking quote. Recheck that the seller offers BOTH selected flights at this total, including the overhead bag and booking fees.';
}
function updateTicketQuotesFromCapture(capture,sourceUrl='',{autoPrefillSingle=false}={}){
  if(!ticketEditorPair)return;
  const {outbound,returning}=ticketEditorPair;
  const {kind,selected,choices}=roundTripQuoteChoices(capture,outbound,returning);
  ticketEditorRaw=selected?capture:'';
  ticketEditorQuoteOptions=choices;
  const select=$('ticketQuoteChoice');
  select.replaceChildren(new Option('Choose an imported quote (not yet verified)',''));
  choices.forEach((quote,index)=>select.add(new Option(quote.label,String(index))));
  $('ticketQuoteArea').hidden=!choices.length;
  $('ticketQuoteHelp').textContent=kind==='search_results' ?
    'These are Google Flights search-card round-trip estimates. A card does not include the chosen return flight or final booking seller. Select a quote, then verify both flights, all fees and baggage before saving.' :
    'Booking quotes on the selected round-trip page are not final. Verify the exact seller, both flights, and the all-in price before saving.';
  if(sourceUrl && choices.length)$('ticketSource').value=sourceUrl;
  if(autoPrefillSingle && kind==='search_results' && choices.length===1){
    useTicketQuote(0);
    $('ticketMessage').textContent+=' The quote was imported from Google Flights; it has NOT been saved to your itinerary yet.';
  } else if(kind==='search_results' && choices.length>1){
    $('ticketMessage').textContent=`${choices.length} matching round-trip search quotes imported. Select one in the dropdown to prefill its amount. Nothing has been saved.`;
  } else if(kind==='selected_round_trip' && choices.length){
    $('ticketMessage').textContent='Select a booking seller quote to prefill the shared round-trip total, then verify the final price and both confirmations.';
  } else if(capture && kind==='search_results'){
    $('ticketMessage').textContent='The imported card does not contain a labeled round-trip quote for either flight in this pair. The shared total was not changed.';
  } else if(capture && parseGoogleFlightsPage(capture)){
    $('ticketMessage').textContent='The captured round-trip selection does not match both of these flight dates and airports. Enter a checked amount manually.';
  }
}
$('ticketQuoteChoice').addEventListener('change',()=>{
  if($('ticketQuoteChoice').value==='')return;
  useTicketQuote(Number($('ticketQuoteChoice').value));
});
$('closeTicketEditor').addEventListener('click',()=>{ticketEditorPair=null;ticketEditorRaw='';ticketEditorQuoteOptions=[];$('ticketEditor').hidden=true;});
$('ticketForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!ticketEditorPair){status('Choose a pair of flights first.');return;}
  const {outbound,returning}=ticketEditorPair;
  try{
    const ticket=buildRoundTripTicket({
      totalEur:$('ticketTotal').value,seller:$('ticketSeller').value,
      confirmed:$('ticketConfirmed').checked,baggageVerified:$('ticketBagVerified').checked,
      sourceUrl:$('ticketSource').value,notes:$('ticketNotes').value
    },outbound,returning);
    const related=ticketsUsingLeg(roundTripTickets,outbound.key).concat(ticketsUsingLeg(roundTripTickets,returning.key));
    const conflicts=[outbound.key,returning.key].filter(key=>offers[key]);
    if((conflicts.length || related.some(t=>t.id!==ticket.id)) && !confirm('This shared ticket replaces saved one-way prices or other tickets using these two flights. Continue?'))return;
    roundTripTickets=replaceTicketsForPair(roundTripTickets,ticket);
    delete offers[outbound.key];delete offers[returning.key];
    const selected=parseGoogleFlightsPage(ticketEditorRaw);
    if(matchingTicketSelection(selected,outbound,returning)){
      for(const [leg,direction] of [[outbound,selected.outbound],[returning,selected.inbound]]){
        const prior=flightResearch[leg.key]||{};
        flightResearch[leg.key]={...prior,legKey:leg.key,from:leg.from,to:leg.to,date:leg.date,
          carrier:direction.carrier,flightNumber:direction.flightNumbers.join(' / '),
          stops:direction.stops,departureClock:direction.departureClock,arrivalClock:direction.arrivalClock,
          arrivalDayOffset:prior.arrivalDayOffset??0,sourceUrl:ticket.sourceUrl,reviewedByUser:true,reviewedAt:ticket.checkedAt,
          bagStatus:'included_in_checked_round_trip_total'};
      }
    }
    lastSavedFareKey=null;
    lastSavedTicketKeys=[outbound.key,returning.key];
    await persist();
    $('ticketEditor').hidden=true;ticketEditorPair=null;ticketEditorRaw='';ticketEditorQuoteOptions=[];
    const message=`Saved ${money(ticket.totalEur)} as ONE ${ticket.seller} round-trip ticket covering ${outbound.from} → ${outbound.to} (${outbound.date}) AND ${returning.from} → ${returning.to} (${returning.date}). Counted once in each itinerary containing both legs.`;
    $('priceSaveNotice').textContent=message;$('priceSaveNotice').hidden=false;
    render();
    [...document.querySelectorAll('[data-leg-key]')].find(el=>el.dataset.legKey===outbound.key)?.scrollIntoView({behavior:'smooth',block:'center'});
    status(message);
  }catch(error){
    $('ticketMessage').textContent=`Could not save: ${error.message}`;
    status(`Could not save ticket: ${error.message}`);
  }
});
$('removeTicket').addEventListener('click',async()=>{
  if(!ticketEditorPair)return;
  const key=ticketKey(ticketEditorPair.outbound.key,ticketEditorPair.returning.key);
  if(!roundTripTickets[key])return;
  if(!confirm('Remove this shared round-trip price? Both flight legs will become unpriced unless a separate fare is saved.'))return;
  delete roundTripTickets[key];
  lastSavedTicketKeys=[];
  await persist();
  $('ticketEditor').hidden=true;ticketEditorPair=null;ticketEditorRaw='';ticketEditorQuoteOptions=[];
  render();status('Linked round-trip ticket removed. Both flights are available for separate fare entries.');
});

// Flight research is user-directed: paste, right-click selected text, or
// import Google Flights cards through an explicit on-page overlay action.
function showCaptureNotice(){
  const ready=Boolean(pendingFlightCapture?.text);
  $('pendingCaptureNotice').hidden=!ready;
  $('useFlightCapture').disabled=!ready;
  if(ready){
    const count=Number(pendingFlightCapture.captureCount)||1;
    $('pendingCaptureNotice').textContent=pendingFlightCapture.captureMode==='page' ?
      `${count} Google Flights result cards received. Open Import flight on the matching itinerary leg to choose a flight.` :
      pendingFlightCapture.captureMode==='card' ?
        'One Google Flights card received. Open Import flight on the matching leg to review it.' :
        'Selected flight text received. Open Import flight on the matching leg to review it.';
  }
}
function renderFlightImportPreview(suggested) {
  const preview=$('flightImportPreview');
  if(suggested.searchResults){
    const leg=lookupLeg(importLegKey);
    const options=suggested.searchResults.options;
    preview.hidden=false;
    preview.innerHTML=`<strong>Google Flights search results · ${options.length} option(s)</strong>
      <p class="helper">Choose a flight to fill its times. Search prices may be one-way, round-trip, or not explicitly labeled; verify before treating any amount as a checked fare.</p>
      <div class="flight-search-options">${options.map((option,index)=>{
        const matched=searchOptionMatchesLeg(option,leg);
        const price=option.displayedPriceEur===null?'Price unavailable':money(option.displayedPriceEur ?? option.quotedRoundTripEur);
        const priceLabel=option.priceScope==='round_trip_search_quote'?'round-trip search quote':
          option.priceScope==='one_way_search_quote'?'one-way search quote':'search price (scope unverified)';
        return `<div class="flight-search-option${matched?'':' option-mismatch'}">
          <div><strong>${escapeHtml(option.departureClock)} → ${escapeHtml(option.arrivalClock)}${option.arrivalDayOffset?` (+${option.arrivalDayOffset} day)`:''}</strong>
          <div>${escapeHtml(option.carrier)}${option.operatedBy?` · operated by ${escapeHtml(option.operatedBy)}`:''}</div>
          <small>${escapeHtml(option.from)} → ${escapeHtml(option.to)} · ${escapeHtml(option.dateISO||option.dateLabel||'Date unverified')} · ${option.stops?'via '+escapeHtml(option.via.join(', ')||`${option.stops} stop(s)`):'Nonstop'}${option.duration?' · '+escapeHtml(option.duration):''}</small>
          <div class="search-quote">${price} · ${escapeHtml(priceLabel)}</div></div>
          <div class="flight-search-option-actions"><button type="button" class="secondary" data-choose-search-option="${index}" ${matched?'':'disabled'}>${matched?'Use this flight':'Different leg/date'}</button>
          ${matched&&option.priceScope==='round_trip_search_quote'&&pairContainingLeg(visibleRoutes(),importLegKey)?`<button type="button" class="secondary" data-price-search-option="${index}">Use round-trip quote €</button>`:''}</div>
        </div>`;
      }).join('')}</div>
      <p class="helper">Choosing a flight only fills the review form. Confirm before saving its time; search prices are never saved automatically as checked fares.</p>`;
    return;
  }
  if(!suggested.roundTrip){preview.hidden=true;preview.innerHTML='';return;}
  const trip=suggested.roundTrip;
  const directionHtml=(label,part)=>`<div class="roundtrip-direction">
    <strong>${escapeHtml(label)} · ${escapeHtml(part.dateLabel)}</strong>
    <div>${escapeHtml(part.from)} ${escapeHtml(part.departureClock)} → ${escapeHtml(part.to)} ${escapeHtml(part.arrivalClock)}</div>
    <small>${part.stops?`${part.stops} stop(s) via ${escapeHtml(part.via.join(', '))}`:'Nonstop'}${part.carrier?` · ${escapeHtml(part.carrier)}`:''}</small>
  </div>`;
  const booking=trip.bookingOptions.slice(0,6).map(option=>`<span>${escapeHtml(option.seller)}: ${money(option.fareEur)}</span>`).join(' · ');
  const pair=pairContainingLeg(visibleRoutes(),importLegKey);
  const canPricePair=pair&&matchingTicketSelection(trip,pair.outbound,pair.returning);
  preview.hidden=false;
  preview.innerHTML=`<strong>Google Flights round-trip selection</strong>
    ${directionHtml('Departing',trip.outbound)}
    ${directionHtml('Returning',trip.inbound)}
    <p><strong>Lowest round-trip total: ${trip.lowestTotalEur!==null?money(trip.lowestTotalEur):'Not identified'}</strong>${trip.carryOnNote?` · ${escapeHtml(trip.carryOnNote)}`:''}</p>
    ${booking?`<p class="helper">Booking quotes: ${booking}</p>`:''}
    ${canPricePair?'<button type="button" class="primary" data-open-ticket-from-import>Save as one round-trip ticket €</button>':''}
    <p class="helper">${suggested.matchedDirection?`Times populated for the ${escapeHtml(suggested.matchedDirection)} flight leg.`:'No matching flight leg/date selected.'} The price covers both directions and must be recorded as one linked ticket, not as a single-leg fare.${trip.baggageSellerUnknown?' Check baggage terms with the selected seller.':''}</p>`;
}
function applySearchOption(option){
  const leg=lookupLeg(importLegKey);
  if(!searchOptionMatchesLeg(option,leg)){
    status('The selected flight does not match this itinerary leg and departure date.');
    return false;
  }
  $('flightImportDeparture').value=option.departureClock;
  $('flightImportArrival').value=option.arrivalClock;
  $('flightImportArrivalDayOffset').value=String(option.arrivalDayOffset);
  $('flightImportCarrier').value=option.carrier;
  $('flightImportNumber').value=''; // A search card is not reliable evidence of a flight number.
  $('flightImportStops').value=option.stops;
  const provenOneWay=option.priceScope==='one_way_search_quote' ||
    (pendingFlightCapture && captureFromOpenedOneWaySearch(pendingFlightCapture,{leg}));
  $('flightImportFare').value=provenOneWay && option.displayedPriceEur!==null ? String(option.displayedPriceEur) : ''; // One-way quotes are drafts only; verification remains required.
  $('flightImportBagStatus').value='unknown';
  $('flightImportOneWayVerified').checked=false;
  $('flightImportConfirmed').checked=false;
  const quote=option.displayedPriceEur??option.quotedRoundTripEur;
  const quoteKind=option.priceScope==='round_trip_search_quote'?'round-trip ticket quote':option.priceScope==='one_way_search_quote'?'one-way search quote':'search quote (ticket scope unknown)';
  $('flightImportQuoteNotice').hidden=false;
  $('flightImportQuoteNotice').textContent=quote===null?'No captured price. Enter a separately checked one-way EUR fare if you have one.':`Captured ${money(quote)} ${quoteKind}. ${provenOneWay?'Prefilled as a DRAFT one-way fare.':'NOT added to the one-way price field.'} Confirm the exact flight, seller, overhead baggage and all-in cost before saving.`;
  $('flightImportHints').textContent=`Selected ${option.carrier} ${option.departureClock} to ${option.arrivalClock}. Enter the departure airport time zone. Save checked departure time, or independently verify a one-way fare and save it with the confirmation below.`;
  return true;
}
function parseCaptureText(){
  const leg=lookupLeg(importLegKey);
  const suggested=parseFlightSelection($('flightImportText').value,{leg});
  $('flightImportDeparture').value=suggested.departureClock;
  $('flightImportArrival').value=suggested.arrivalClock;
  $('flightImportArrivalDayOffset').value=String(suggested.arrivalDayOffset??0);
  $('flightImportFare').value=suggested.fareEur??'';
  $('flightImportOneWayVerified').checked=false;
  $('flightImportQuoteNotice').hidden=!suggested.roundTrip;
  $('flightImportQuoteNotice').textContent=suggested.roundTrip?'This is a round-trip ticket quote. Do not enter its full price as one leg. Only save a price after separately verifying the exact one-way cost.':'';
  if(suggested.roundTrip){
    $('flightImportCarrier').value=suggested.carrier||'';
    $('flightImportNumber').value=suggested.flightNumber||'';
    $('flightImportStops').value=suggested.stops??'';
    $('flightImportBagStatus').value='unknown'; // Never assume one seller honors another seller's bag allowance.
  }
  renderFlightImportPreview(suggested);
  $('flightImportHints').textContent=suggested.warnings.join(' ') ||
    'Suggestions filled where unambiguous. Confirm airports, date, times, currency and baggage yourself.';
  // A card was explicitly selected on Google Flights. Prefill its timing
  // immediately when it matches the exact RouteWise leg; still require review.
  if(suggested.searchResults?.options?.length===1){
    applySearchOption(suggested.searchResults.options[0]);
  }
  $('flightImportConfirmed').checked=false;
}
$('flightImportPreview').addEventListener('click',(event)=>{
  const roundTripButton=event.target.closest('button[data-open-ticket-from-import]');
  if(roundTripButton){
    const pair=pairContainingLeg(visibleRoutes(),importLegKey);
    if(pair)openTicketEditor(pair.route.id,pair.outboundIndex,$('flightImportText').value,$('flightImportSource').value);
    return;
  }
  const ticketButton=event.target.closest('button[data-price-search-option]');
  if(ticketButton){
    const parsed=parseGoogleFlightsSearchResults($('flightImportText').value);
    const option=parsed?.options?.[Number(ticketButton.dataset.priceSearchOption)];
    const pair=pairContainingLeg(visibleRoutes(),importLegKey);
    if(!option || !pair || !searchOptionMatchesLeg(option,lookupLeg(importLegKey)))return;
    const normalized=`<li data-routewise-from="${escapeHtml(option.from)}" data-routewise-to="${escapeHtml(option.to)}" data-routewise-date="${escapeHtml(lookupLeg(importLegKey).date)}" data-routewise-departure="${escapeHtml(option.departureClock)}" data-routewise-arrival="${escapeHtml(option.arrivalClock)}" data-routewise-carrier="${escapeHtml(option.carrier)}" data-routewise-stops="${option.stops}" data-routewise-price="${option.displayedPriceEur}" data-routewise-price-scope="round_trip_search_quote"></li>`;
    openTicketEditor(pair.route.id,pair.outboundIndex,normalized,$('flightImportSource').value);
    return;
  }
  const button=event.target.closest('button[data-choose-search-option]');
  if(!button)return;
  const parsed=parseGoogleFlightsSearchResults($('flightImportText').value);
  const index=Number(button.dataset.chooseSearchOption);
  const option=parsed?.options?.[index];
  if(!Number.isInteger(index)||!option)return;
  if(applySearchOption(option))$('flightImportDeparture').focus();
});
function usePendingCapture(){
  if(!pendingFlightCapture?.text){status('No browser capture is waiting. Paste a flight summary instead.');return;}
  $('flightImportText').value=pendingFlightCapture.text;
  $('flightImportSource').value=pendingFlightCapture.sourceUrl||'';
  parseCaptureText();
}
function openFlightImport(key){
  const leg=lookupLeg(key);
  if(!leg||leg.mode!=='flight'){status('Choose a flight leg to review.');return;}
  importLegKey=key;
  $('flightImportForm').reset();
  $('flightImportQuoteNotice').hidden=true;
  $('flightImportQuoteNotice').textContent='';
  $('flightImportText').value='';
  $('flightImportHints').textContent='';
  $('flightImportPreview').hidden=true;
  $('flightImportPreview').innerHTML='';
  $('flightImportLeg').textContent=`${placeName(leg.from)} (${leg.from}) → ${placeName(leg.to)} (${leg.to}), ${leg.date}. Saving a fare replaces any prior fare for this exact leg.`;
  const old=offers[key];const time=flightTimes[key]||old||{};const research=flightResearch[key]||{};
  $('flightImportDeparture').value=time.departureClock||'';
  $('flightImportZone').value=time.departureTimezone||'';
  $('flightImportArrival').value=research.arrivalClock||'';
  $('flightImportArrivalDayOffset').value=String(research.arrivalDayOffset??0);
  $('flightImportCarrier').value=research.carrier||'';
  $('flightImportNumber').value=research.flightNumber||'';
  $('flightImportStops').value=research.stops??'';
  $('flightImportFare').value=old?.fare??'';
  $('flightImportBagFee').value=old?.bagFee??'';
  $('flightImportTransferCost').value=old?.transferCost??0;
  $('flightImportSource').value=old?.source||research.sourceUrl||'';
  if(['included','extra'].includes(research.bagStatus))$('flightImportBagStatus').value=research.bagStatus;
  $('flightImport').hidden=false;
  if(pendingFlightCapture?.text)usePendingCapture();
  $('flightImport').scrollIntoView({behavior:'smooth',block:'start'});
}
function closeFlightImport(){
  importLegKey=null;
  $('flightImport').hidden=true;
}
$('closeFlightImport').addEventListener('click',closeFlightImport);
$('useFlightCapture').addEventListener('click',usePendingCapture);
$('parseFlightImport').addEventListener('click',parseCaptureText);
$('discardFlightCapture').addEventListener('click',async()=>{
  pendingFlightCapture=null;
  await chrome.storage.local.remove('pendingFlightCapture');
  showCaptureNotice();
  $('flightImportHints').textContent='Browser capture discarded. Pasted text remains available until you close this editor.';
});
$('flightImportText').addEventListener('input',()=>{ $('flightImportConfirmed').checked=false; $('flightImportOneWayVerified').checked=false; });
$('flightImportForm').addEventListener('submit',async(event)=>{
  event.preventDefault();
  const leg=lookupLeg(importLegKey);
  if(!leg){status('That flight is no longer in the itinerary.');return;}
  const form={
    confirmed:$('flightImportConfirmed').checked,
    mode:event.submitter?.value==='fare'?'fare':'timing',
    carrier:$('flightImportCarrier').value,flightNumber:$('flightImportNumber').value,
    departureClock:$('flightImportDeparture').value,arrivalClock:$('flightImportArrival').value,
    arrivalDayOffset:$('flightImportArrivalDayOffset').value,
    departureTimezone:$('flightImportZone').value,stops:$('flightImportStops').value,
    fareEur:$('flightImportFare').value,bagStatus:$('flightImportBagStatus').value,
    oneWayFareVerified:$('flightImportOneWayVerified').checked,
    bagFee:$('flightImportBagFee').value,transferCost:$('flightImportTransferCost').value,
    sourceUrl:$('flightImportSource').value,notes:$('flightImportNotes').value,
    rawSelectionText:$('flightImportText').value
  };
  try{
    const reviewed=buildReviewedFlight(form,leg);
    if(linkedTicketFlightConflict(leg.key,reviewed.research)){
      throw new Error('This departure/airline differs from the flight attached to a linked round-trip ticket. Edit or remove the shared ticket before choosing another flight.');
    }
    flightResearch[leg.key]=reviewed.research;
    if(reviewed.offer){
      if(ticketsUsingLeg(roundTripTickets,leg.key).length)throw new Error('This leg is covered by a linked round-trip ticket. Remove or edit the ticket before saving an individual fare.');
      offers[leg.key]=reviewed.offer;
      delete flightTimes[leg.key];
    }else if(reviewed.flightTime){flightTimes[leg.key]=reviewed.flightTime;}
    await persist();
    if(pendingFlightCapture){pendingFlightCapture=null;await chrome.storage.local.remove('pendingFlightCapture');}
    showCaptureNotice();closeFlightImport();
    if(reviewed.offer)announceSavedFare(leg,reviewed.offer);
    else {render();status('Reviewed departure time saved; prices unchanged.');}
  }catch(error){
    $('flightImportHints').textContent=`Could not save: ${error.message}`;
    status(`Could not save research: ${error.message}`);
  }
});
async function autoCacheBroadCapture(capture) {
  if (!capture?.text) return false;
  const task = broadTasks().find(item => captureFromOpenedOneWaySearch(capture,item));
  if (!task) return false;
  if (broadCache[task.key]?.capturedAt === capture.capturedAt) return true;
  try {
    const record = captureBroadSearch(capture,task);
    broadCache[task.key] = record;
    await persist();
    render();
    status(`Auto-cached ${record.options.length} indicative one-way results for ${task.leg.from} to ${task.leg.to}. Preliminary comparison updated; verified fares unchanged.`);
    return true;
  } catch (error) {
    status(`Broad import needs review: ${error.message}`);
    return false;
  }
}
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local')return;
  if(changes.priceTestMode){
    priceTestMode = changes.priceTestMode.newValue === true;
    // Entering test mode restores the first-flight import starting point.
    // Turning it off keeps AI caches intact and resumes normal persistence.
    if (priceTestMode) void restartPriceImportTest();
    else { clearPriceImportSessionState(); showCaptureNotice(); render();
      status('Price import test mode disabled. New prices will be saved normally.'); }
  }
  if(changes.priceImportResetRequest && priceTestMode) void restartPriceImportTest();
  if(!changes.pendingFlightCapture)return;
  pendingFlightCapture=changes.pendingFlightCapture.newValue||null;
  showCaptureNotice();
  $('broadConfirmOneWay').checked=false;
  renderBroadResearch();
  void autoCacheBroadCapture(pendingFlightCapture);
  if(importLegKey && pendingFlightCapture?.text)usePendingCapture();
  if(ticketEditorPair && pendingFlightCapture?.text){
    updateTicketQuotesFromCapture(pendingFlightCapture.text,pendingFlightCapture.sourceUrl||'',{autoPrefillSingle:true});
  }
});

$('showGoogleFlightsOverlay').addEventListener('click',async()=>{
  try{
    const tabs=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tabs[0]?.id)throw new Error('No browser tab found.');
    const result=await chrome.tabs.sendMessage(tabs[0].id,{type:'routewise:show-flight-overlay'});
    if(!result?.ok)throw new Error('The Google Flights importer did not respond.');
    status(`Flight overlay opened on Google Flights; ${result.count} cards detected.`);
  }catch{
    status('Open or refresh a Google Flights search-results tab, then press Show flight import overlay again.');
  }
});
$('routes').addEventListener('click', (event) => {
  const importButton = event.target.closest('button[data-import-flight]');
  const trainButton = event.target.closest('button[data-import-train]');
  const editButton = event.target.closest('button[data-edit]');
  const searchButton = event.target.closest('button[data-search]');
  const roundTripButton = event.target.closest('button[data-roundtrip-route]');
  const ticketButton=event.target.closest('button[data-price-roundtrip-route]');
  const copyButton = event.target.closest('button[data-copy-route]');
  const removeButton = event.target.closest('button[data-remove-manual]');
  if(importButton)openFlightImport(importButton.dataset.importFlight);
  if(trainButton)openTrainImport(trainResearchKey(lookupLeg(trainButton.dataset.importTrain)));
  if(copyButton)openManualEditor(copyButton.dataset.copyRoute);
  if(removeButton){manualRoutes=manualRoutes.filter(route=>route.id!==removeButton.dataset.removeManual);persist().then(render);status('Manual itinerary removed. Saved fare entries were left intact.');}
  if (roundTripButton) searchRoundTrip(roundTripButton.dataset.roundtripRoute, Number(roundTripButton.dataset.roundtripIndex));
  if(ticketButton)openTicketEditor(ticketButton.dataset.priceRoundtripRoute,Number(ticketButton.dataset.priceRoundtripIndex));
  if (editButton) editOffer(editButton.dataset.edit);
  if (searchButton) searchLeg(searchButton.dataset.search);
});
// A flight departure can be entered before any fare has been researched.
// That keeps timing decisions independent from the pricing model.
$('routes').addEventListener('submit',async event=>{
  const form=event.target.closest('form[data-flight-time-form]');
  if(!form)return;
  event.preventDefault();
  const key=form.dataset.flightTimeForm;
  if(!lookupLeg(key)) {status('This flight is no longer part of your route.');return;}
  try {
    const checked=validatedFlightTime({departureClock:form.elements.clock.value,
      departureTimezone:form.elements.timezone.value});
    if(linkedTicketFlightConflict(key,checked))throw new Error('This flight time differs from the linked round-trip ticket selection. Edit or remove the ticket before changing flights.');
    flightTimes[key]=checked;
    await persist();render();
    status('Flight departure recorded for the connection check. No fare was added.');
  } catch(error) {status(`Could not check departure: ${error.message}`);}
});
$('routes').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-clear-flight-time]');
  if(!button)return;
  const key=button.dataset.clearFlightTime;
  delete flightTimes[key];
  if(offers[key])offers[key]={...offers[key],departureClock:'',departureTimezone:''};
  await persist();render();status('Saved departure time cleared; fare amount retained.');
});
// The traveler reviews the returned stop/route before a Google fare may count.
$('routes').addEventListener('click',event=>{
  const button=event.target.closest('button[data-accept-ground]');
  if(!button)return;
  const route=visibleRoutes().find(r=>r.id===button.dataset.acceptGroundRoute);
  const leg=route?.legs?.find(l=>l.key===button.dataset.acceptGround);
  if(!leg||leg.mode!=='transfer')return;
  const key=routeTransferQuoteKey(route,leg),record=groundQuotes[key];
  if(!record?.fare || record.fare.currencyCode!=='EUR'||record.requestedDate!==leg.date)return;
  groundQuotes[key]={...record,acceptedForComparison:true};
  render();status('Reviewed Google transit estimate added to the provisional route total. No fare was booked or saved.');
});
// Explicit, billable Google Maps transit research; never runs during page render.
$('routes').addEventListener('submit',async event=>{
  const form=event.target.closest('form[data-google-ground]');
  if(!form)return;
  event.preventDefault();
  if(!GOOGLE_ROUTES_ENABLED){status('Google Routes API lookups are temporarily disabled; no Google API call was made.');return;}
  if(groundLookupBusy){status('Finish the current ground-transfer lookup first.');return;}
  const route=visibleRoutes().find(r=>r.id===form.dataset.googleGroundRoute);
  const leg=route?.legs?.find(item=>item.key===form.dataset.googleGround);
  if(leg?.mode!=='transfer'){status('Choose a local transfer to research.');return;}
  try{
    const localTime=form.elements.localTime.value;
    const time=localTransitTimeToISO(localTime,form.elements.timeZone.value.trim());
    const from=leg.fromKind==='airport' ? airportName(leg.from) : (leg.fromLabel||leg.from);
    const to=leg.toKind==='airport' ? airportName(leg.to) : (leg.toLabel||leg.to);
    groundLookupBusy=true;
    status(`Finding public transit for ${from} to ${to}...`);
    const response=await fetch('http://127.0.0.1:8787/ground-transit',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({origin:from,destination:to,
        time,timeKind:form.elements.timeKind.value,localDate:localTime.slice(0,10)})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Google transit lookup failed.');
    const first=data.routes?.[0]||null;
    groundQuotes[routeTransferQuoteKey(route,leg)]={...data,requestedDate:localTime.slice(0,10),fare:first?.fare||null,acceptedForComparison:false};
    render();
    status(!first?'Google did not return a public transit route; no fare was assigned.':
      `Google returned ${data.routes.length} transit option(s) for this local transfer. ${first.fare?'A provider estimate is available.':'No complete fare was returned.'} Check the actual stations and connection buffer.`);
  }catch(error){status(`Ground transfer research: ${error.message}`);}
  finally{groundLookupBusy=false;}
});
// Save confirmed ground arrival times even when GTFS only has route-pattern evidence.
$('routes').addEventListener('submit',async event=>{
  const form=event.target.closest('form[data-ground-time-form]');
  if(!form)return;
  event.preventDefault();
  const key=form.dataset.groundTimeForm;
  if(!lookupLeg(key)){status('This ground leg is no longer in the itinerary.');return;}
  try {
    groundTimes[key]=validatedGroundTime({arrivalDate:form.elements.day.value,
      arrivalClock:form.elements.clock.value,arrivalTimezone:form.elements.timezone.value});
    await persist();render();status('Ground arrival recorded. The onward-flight buffer was recalculated.');
  } catch(error) { status(`Could not save ground arrival: ${error.message}`); }
});
$('routes').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-clear-ground-time]');
  if(!button)return;
  delete groundTimes[button.dataset.clearGroundTime];
  await persist();render();status('Ground arrival override cleared; published timetable restored when available.');
});
$('cancelEdit').addEventListener('click', () => { $('editor').hidden = true; currentKey = null; });
$('offerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentKey) return;
  try {
    const offer = normalizedOffer({
      fare:$('fare').value,bagFee:$('bagFee').value,
      transferCost:$('transferCost').value,source:$('source').value,note:$('note').value,
      departureClock:$('departureClock').value,departureTimezone:$('departureTimezone').value
    });
    if(ticketsUsingLeg(roundTripTickets,currentKey).length)throw new Error('Remove or edit the linked round-trip ticket before adding a one-way fare.');
    offers[currentKey] = offer;
    delete flightResearch[currentKey]; // A later manual edit no longer has the previous review attestation.
    delete flightTimes[currentKey]; // The fare editor now owns this leg's saved time.
    await persist();
    const savedLeg=lookupLeg(currentKey);
    $('editor').hidden = true; currentKey = null;
    if(savedLeg)announceSavedFare(savedLeg,offer);
    else {render();status('Offer saved. Shared route segments update automatically.');}
  } catch (error) { status(`Could not save fare: ${error.message}`); }
});
$('clearOffers').addEventListener('click', async () => {
  if (!confirm('Delete every saved one-way fare and linked round-trip ticket? This cannot be undone.')) return;
  offers = {}; roundTripTickets={};lastSavedTicketKeys=[]; await persist(); render(); status('Saved one-way fares and round-trip tickets cleared.');
});
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({version:'0.4.10',trip,bag,offers,roundTripTickets,flightTimes,groundTimes,flightResearch,broadCache,trainCache,routes,manualRoutes,parsedPlan,parseWarnings,parseSource,parsedRequest,parseDebug},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'routewise-trip.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  status('Exported trip data.');
});
async function init() {
  try {
    const saved = await chrome.storage.local.get(['trainCache','trip','bag','offers','roundTripTickets','flightTimes','groundTimes','flightResearch','broadCache','pendingFlightCapture','routes','manualRoutes','destinationCandidates','destinationCandidateKey','connectionCandidates','connectionCandidateKey','parsedPlan','parseWarnings','parseSource','parsedRequest','parseDebug','sessionCleared','lastAiInterpretation','priceTestMode','unavailableFlights']);
    priceTestMode = saved.priceTestMode === true;
    // Upgrade from v0.2.1: restore an explicitly named country from saved request text.
    const previous = saved.trip || {};
    const oldRegion = /\bportugal\b/i.test(previous.request || '') ? 'Portugal' :
      /canary islands/i.test(previous.request || '') ? 'Canary Islands' : '';
    const oldPreferred = oldRegion === 'Portugal' && !('requestedRegion' in previous) &&
      ['SPC','TFN','TFS','LPA'].includes(previous.preferred) ? '' : previous.preferred;
    trip = {...DEFAULT_TRIP,...previous,requestedRegion: previous.requestedRegion ?? (oldRegion || DEFAULT_TRIP.requestedRegion)};
    if (oldPreferred !== undefined) trip.preferred = oldPreferred;
    bag = {...DEFAULT_BAG,...(saved.bag||{})};
    offers = saved.offers || {};
    roundTripTickets = saved.roundTripTickets && typeof saved.roundTripTickets==='object' && !Array.isArray(saved.roundTripTickets)?saved.roundTripTickets:{};
    flightResearch = saved.flightResearch && typeof saved.flightResearch==='object' && !Array.isArray(saved.flightResearch) ? saved.flightResearch : {};
    broadCache = saved.broadCache && typeof saved.broadCache==='object' && !Array.isArray(saved.broadCache) ? saved.broadCache : {};
    unavailableFlights = saved.unavailableFlights && typeof saved.unavailableFlights==='object' && !Array.isArray(saved.unavailableFlights) ? saved.unavailableFlights : {};
    trainCache = saved.trainCache && typeof saved.trainCache==='object' && !Array.isArray(saved.trainCache) ? saved.trainCache : {};
    pendingFlightCapture = saved.pendingFlightCapture?.text ? saved.pendingFlightCapture : null;
    flightTimes = saved.flightTimes && !Array.isArray(saved.flightTimes) && typeof saved.flightTimes === 'object' ? saved.flightTimes : {};
    groundTimes = saved.groundTimes && !Array.isArray(saved.groundTimes) && typeof saved.groundTimes==='object' ? saved.groundTimes : {};
    manualRoutes=Array.isArray(saved.manualRoutes)?saved.manualRoutes.filter(route=>route?.manual===true && Array.isArray(route.legs)):[];
    parsedPlan = saved.parsedPlan || null;
    parseWarnings = saved.parseWarnings || [];
    parseSource = saved.parseSource || '';
    parseDebug = saved.parseDebug || null;
    parsedRequest = saved.parsedRequest || '';
    sessionCleared = saved.sessionCleared === true;
    lastAiInterpretation = saved.lastAiInterpretation || (
      saved.parseSource==='ai' && saved.parsedPlan && saved.parsedRequest && saved.parseDebug?.referenceDate
        ? {request:saved.parsedRequest,referenceDate:saved.parseDebug.referenceDate,
           plan:saved.parsedPlan,debug:saved.parseDebug,warnings:saved.parseWarnings||[]} : null
    );
    destinationCandidates = saved.destinationCandidates || [];
    destinationCandidateKey = saved.destinationCandidateKey || '';
    connectionCandidates = saved.connectionCandidates && typeof saved.connectionCandidates === 'object' ? saved.connectionCandidates : {outbound:[],inbound:[]};
    connectionCandidateKey = saved.connectionCandidateKey || '';
    // A v0.3.3 saved form had no arrival rule. Honor any already-reviewed fixed date.
    if (!previous.arrivalRule && parsedPlan && parsedRequest === trip.request && parsedPlan.fixed_arrival) {
      trip.arrivalRule = 'fixed';
    }
    // Older parser results do not have requested_regions. Keep the displayed plan safe.
    if (parsedPlan && !Array.isArray(parsedPlan.requested_regions)) {
      parsedPlan = null; parseWarnings = []; parseSource = ''; parsedRequest = ''; parseDebug = null;
    }
    if(priceTestMode){
      clearPriceImportSessionState();
      // Older saved values (or a leftover capture) must never reappear after
      // a side-panel/browser/extension reload while testing imports.
      await chrome.storage.local.remove(PRICE_STORAGE_KEYS);
    await chrome.storage.local.remove('trainCache');
    }
    setForm();
    showPlanPreview();
    // A previously saved country may require Groq. Don't fail extension startup.
    routes = Array.isArray(saved.routes) ? saved.routes : [];
    if (!routes.length && !sessionCleared) {
      try { routes=generatePlannedRoutes(generationPlan(trip),{destinationCandidates}); }
      catch { routes=[]; }
    }
    render();
    showCaptureNotice();
    status(priceTestMode ? 'Price import test ready. All flight searches start uncached; your routes and trip details remain.' : 'Ready. Your data stays in this Chrome extension’s local storage.');
    if(pendingFlightCapture) void autoCacheBroadCapture(pendingFlightCapture);
  } catch (error) { status(`Startup error: ${error.message}`); }
}
init();
