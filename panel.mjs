import { AIRPORTS, airportName, rankRoutes, normalizedOffer } from './core.mjs';
import { generatePlannedRoutes } from './route-engine.mjs';
import { DEMO_PLAN, validateTripPlan, normalizeTripWithDiagnostics } from './trip-parser.mjs';
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
import {parseGoogleFlightsSearchResults,searchOptionMatchesLeg} from './google-flights-search.mjs';
import {parseGoogleFlightsPage} from './google-flights-text.mjs';
import {roundTripQuoteChoices} from './roundtrip-quote-options.mjs';
import {researchTasks,researchKey,captureBroadSearch,captureFromOpenedOneWaySearch,researchAge,compareBroadRoutes,TRAIN_ESTIMATE_EUR} from './broad-research.mjs';
import {googleFlightsSearchUrl} from './search-links.mjs';
import {ticketKey,pairedFlightLegs,pairContainingLeg,matchingTicketSelection,matchingTicketsForRoute,ticketsUsingLeg,replaceTicketsForPair,buildRoundTripTicket} from './roundtrip-tickets.mjs';

const $ = (id) => document.getElementById(id);
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
let flightResearch = {}; // User-reviewed flight metadata, keyed to an exact flight leg
let broadCache = {}; // Indicative one-way Best-tab results, never checked fares
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function status(message) { $('status').textContent = message; }
function generationStatus(message) { $('generationStatus').textContent = message; status(message); }
function localDate() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function visibleRoutes() { return [...routes, ...manualRoutes.filter(route=>manualRouteForTrip(route,trip))]; }
function candidateKey(t) {return JSON.stringify([t.origin,t.destination,t.requestedRegion,t.startDate,t.endDate,t.request]);}
function hubKey(t,maxConnections) {return JSON.stringify([t.origin,t.preferred,t.destination,t.startDate,t.endDate,t.request,maxConnections]);}
function placeName(code) { return visibleRoutes().find(r=>r.places?.[code])?.places?.[code] || airportName(code); }
function money(n) { return new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR'}).format(n); }
function dateDisplay(value) { return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB',{month:'short',day:'numeric',timeZone:'UTC'}); }
function fillSelect(id, selected) {
  // Do not recreate thousands of airport <option>s every time AI details are
  // applied. The initial list is cached on the select element and reused.
  updateAirportSelect($(id), AIRPORTS, selected, { allowEmpty: id === 'preferred' });
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
async function persist() { await chrome.storage.local.set({trip,bag,offers,roundTripTickets,flightTimes,groundTimes,flightResearch,broadCache,routes,manualRoutes,destinationCandidates,destinationCandidateKey,connectionCandidates,connectionCandidateKey,parsedPlan,parseWarnings,parseSource,parsedRequest,parseDebug}); }
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
    ['Destination discovery',p.destination_search === 'open' ? 'Explore destinations with Groq' : p.destination_search === 'region' ? 'Suggest cities inside requested region (Groq, unverified)' : 'Named city'],
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
  const debugView = parseDebug ? `<details class="parse-debug"><summary>Developer diagnostics — raw Groq vs normalized data</summary>
    <p class="helper">Only locally saved trip data is shown. Never share exported diagnostics containing private travel details.</p>
    <strong>Model: ${escapeHtml(parseDebug.model || 'Unknown')} · Reference date: ${escapeHtml(parseDebug.referenceDate || 'Unknown')}</strong>
    <p class="helper">Date evidence: ${escapeHtml((parseDebug.dateEvidence || []).join('; ') || 'No deterministic date phrases found')}</p>
    ${parseDebug.timingMs ? `<p class="helper">Server timing: Groq ${parseDebug.timingMs.groqRequest} ms · Local parsing ${parseDebug.timingMs.normalization} ms · Total ${parseDebug.timingMs.totalServer} ms</p>` : ''}
    <strong>Fields corrected after AI:</strong><pre>${escapeHtml(JSON.stringify(parseDebug.corrections || [],null,2))}</pre>
    ${parseDebug.clientCorrections?.length ? `<strong>Side-panel safety corrections:</strong><pre>${escapeHtml(JSON.stringify(parseDebug.clientCorrections,null,2))}</pre>` : ''}
    <strong>Raw Groq object:</strong><pre>${escapeHtml(JSON.stringify(parseDebug.rawModel || {},null,2))}</pre>
    <strong>Normalized result:</strong><pre>${escapeHtml(JSON.stringify(p,null,2))}</pre></details>` : '';
  target.innerHTML = `<h3>Review extracted trip details</h3>
    <p class="parse-source">${parseSource === 'sample' ? 'SAMPLE OUTPUT — not AI-generated' : 'AI interpretation — verify before using'}</p>
    <div class="data-grid">${fieldHtml}</div>
    ${more.length?`<ul>${more.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`:''}
    ${notices.length?`<div class="parse-warnings"><strong>Review:</strong><ul>${notices.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`:''}
    ${debugView}
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
$('sampleParse').addEventListener('click', async()=>{
  await setParsedPlan(DEMO_PLAN,'sample');
  status('Sample extraction preview shown. This did not call an AI or modify your trip fields.');
});
$('interpret').addEventListener('click', async()=>{
  const description = $('request').value.trim();
  if (!description) { status('Describe your trip first.'); return; }
  const startedAt=performance.now();
  $('interpret').disabled = true;
  $('interpret').textContent = 'Interpreting…';
  status('Sending trip text to local server for AI interpretation…');
  try {
    const response = await fetch('http://127.0.0.1:8787/parse-trip', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ request:description, referenceDate:localDate() }),
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
    status(`AI interpretation ready in ${((performance.now()-startedAt)/1000).toFixed(1)}s. Review it and click Apply known details.`);
  } catch(error) {
    status(`AI unavailable: ${error.message}. Start the local server with npm run server, or try Preview sample.`);
  } finally {
    $('interpret').disabled = false;
    $('interpret').textContent = 'Interpret trip with AI';
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
  const ranked = rankRoutes(visibleRoutes(), offers,{bufferMinutes:Number(trip.connectionBuffer)||180,flightTimes,groundTimes,tickets:roundTripTickets});
  $('bufferSummary').textContent=connectionOverview(ranked.map(x=>x.route),offers,{bufferMinutes:Number(trip.connectionBuffer)||180,flightTimes,groundTimes});
  $('routeCount').textContent = String(ranked.length);
  renderBroadResearch();
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
      const cost=shared ? `<div class="leg-pricing ticket-covered">${ticketMatch.position==='outbound'?`${money(shared.totalEur)} · linked round-trip ticket`:'Covered by linked round-trip ticket'}<div class="ticket-link">${escapeHtml(shared.seller)} · covers ${escapeHtml(shared.outbound.date)} and ${escapeHtml(shared.returning.date)}</div></div>`
        :offer?`<div class="leg-pricing">${money(offer.fare + offer.bagFee + offer.transferCost)}</div>`:'<span class="tag">Unpriced</span>';
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
      const flightTimeNote=leg.mode==='flight' && !windowsByFlight.has(legIndex) && offer?.departureClock
        ? `<div class="leg-meta">Saved departure: ${escapeHtml(offer.departureClock)} (${escapeHtml(offer.departureTimezone||'time zone unspecified')})</div>`:'';
      const check=windowsByFlight.get(legIndex);
      return `${check?connectionCardHtml(check,leg):''}<div class="leg${lastSavedFareKey===leg.key||lastSavedTicketKeys.includes(leg.key)?' leg-updated':''}" data-leg-key="${escapeHtml(leg.key)}">
        <div><div class="leg-title">${escapeHtml(placeName(leg.from))} → ${escapeHtml(placeName(leg.to))}</div>
        <div class="leg-meta">${dateDisplay(leg.date)} · ${escapeHtml(modeLabel(leg.mode))}${leg.evidence==='gtfs_scheduled'?' · GTFS scheduled (ground leg only)':leg.evidence==='gtfs_trip_pattern'?' · GTFS trip pattern (date unverified)':leg.evidence==='transfer_needed'?' · transfer required (unverified)':''}${leg.fromKind && leg.mode !== 'flight' && !leg.evidence ? ' · user-entered terminal' : ''}</div>${leg.evidence==='gtfs_scheduled'?`<div class="leg-meta">${escapeHtml(leg.departureLocal)} → ${escapeHtml(leg.arrivalLocal)} (${escapeHtml(leg.scheduleTimezone||'feed-local')})</div>`:''}${returnNote}${flightTimeNote}${cost}${researchNote}${source}</div>
        <div class="leg-actions">
          <button class="secondary" data-search="${escapeHtml(leg.key)}">${leg.mode === 'flight' ? 'One way ↗' : leg.mode === 'transfer' ? 'Directions ↗' : `Find ${escapeHtml(leg.mode)} ↗`}</button>${roundTripButton}${ticketButton}
          ${leg.mode==='flight'?`<button class="ghost" data-import-flight="${escapeHtml(leg.key)}">Import flight</button>`:''}
          <button class="ghost" data-edit="${escapeHtml(leg.key)}">${shared?'Ticket €':offer?'Edit':'Add'} €</button>
        </div></div>`;
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
function broadTasks(){return researchTasks(visibleRoutes());}
function renderBroadResearch(){
  const tasks=broadTasks();
  const pending=tasks.filter(task=>!broadCache[task.key]);
  const matched=tasks.filter(task=>broadCache[task.key]);
  const rows=compareBroadRoutes(visibleRoutes(),broadCache,offers,roundTripTickets,
    {bufferMinutes:Number(trip.connectionBuffer)||180,groundTimes});
  $('broadStats').textContent=`${tasks.length} unique one-way searches · ${matched.length} cached · ${pending.length} pending · train estimate ${money(TRAIN_ESTIMATE_EUR)}/leg`;
  $('broadSearches').innerHTML=tasks.length?tasks.map(task=>{
    const record=broadCache[task.key];
    const statusText=record?`${record.options.length} options · ${researchAge(record)==='stale'?'older than 24h':'cached'}`:'Needs research';
    return `<div class="broad-task"><div><strong>${escapeHtml(task.leg.from)} → ${escapeHtml(task.leg.to)} · ${escapeHtml(task.leg.date)}</strong>
      <small>${escapeHtml(statusText)} · used by ${task.routeCount} route(s)</small></div>
      <div><button type="button" class="secondary" data-broad-open="${escapeHtml(task.key)}">${record?'Refresh':'Open'} ↗</button>
      ${record?`<button type="button" class="ghost" data-broad-remove="${escapeHtml(task.key)}">Clear</button>`:''}</div></div>
      ${record?`<details class="broad-options"><summary>View ${record.options.length} captured flight options</summary>
        ${record.options.map(item=>`<div class="broad-option"><div><strong>${escapeHtml(item.departureClock)} → ${escapeHtml(item.arrivalClock)}${item.arrivalDayOffset?` (+${item.arrivalDayOffset}d)`:''}</strong> · ${escapeHtml(item.carrier)}${item.stops?` · ${item.stops} stop(s)`:' · Nonstop'}</div><strong>${money(item.estimatedEur)}</strong></div>`).join('')}
        <p class="helper">Indicative one-way prices · ${escapeHtml(record.capturedAt||'Capture time unknown')} · Check baggage and seller for finalists.</p></details>`:''}`;
  }).join(''):'<p class="helper">Generate candidate routes first.</p>';
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
    $('broadCaptureSave').disabled=!choices.length;
  }
  const shown=rows.slice(0,5);
  $('broadComparison').innerHTML=shown.map((r,index)=>{
    const subtotal=r.total===null?`${money(r.known)}+` :money(r.total);
    const flag=r.missing?`${r.missing} unpriced leg(s)` :r.conflicts?`${r.conflicts} blocked connection(s)`:
      r.uncheckedConnections?`${r.uncheckedConnections} connection(s) to check`:'No known ground-buffer conflict';
    const preview=r.selected.filter(x=>x.kind==='flight_estimate').map(x=>
      `${x.leg.from}–${x.leg.to} ${x.option.departureClock} ${money(x.costEur)}`).join(' · ');
    return `<div class="broad-route"><div class="broad-route-head"><strong>${index+1}. ${escapeHtml(r.route.name)}</strong><strong>${escapeHtml(subtotal)}</strong></div>
    <div class="helper">${escapeHtml(r.complete?'Complete indicative estimate':'Incomplete estimate')} · ${escapeHtml(flag)} · ${r.trainCount} train(s) at €20</div>
    ${r.destinationHours!==null?`<div class="helper">Approx. ${r.destinationHours} hours at ${escapeHtml(r.route.primaryStay?.destination||'destination')} based on imported flight times</div>`:''}
    ${r.observedDurationMinutes?`<div class="helper">Known scheduled flight time: ${Math.floor(r.observedDurationMinutes/60)}h ${r.observedDurationMinutes%60}m${r.unknownDurations?` · ${r.unknownDurations} unknown duration(s)`: ''} (excludes waits and transfers)</div>`:''}
    ${r.selected.some(s=>s.cacheAge==='stale')?'<div class="helper">Some flight quotes are older than 24 hours; refresh before deciding.</div>':''}
    ${preview?`<div class="helper">${escapeHtml(preview)}</div>`:''}</div>`;
  }).join('')||'<p class="helper">No route comparisons yet.</p>';
  $('broadSummary').textContent=pending.length ? `Research ${pending.length} remaining one-way search(es) for a complete first-pass cost comparison.`:
    `All ${tasks.length} unique flight searches have cached results. Search quotes are preliminary; confirm finalist tickets and baggage.`;
}

$('broadSearches').addEventListener('click', async event=>{
  const open=event.target.closest('button[data-broad-open]');
  const clear=event.target.closest('button[data-broad-remove]');
  if(clear){delete broadCache[clear.dataset.broadRemove];await persist();render();return;}
  if(!open)return;
  const task=broadTasks().find(item=>item.key===open.dataset.broadOpen);
  if(!task)return;
  activeResearchKey=task.key;
  chrome.tabs.create({url:googleFlightsSearchUrl(task.leg)});
  renderBroadResearch();
  status(`Opened one-way ${task.leg.from} → ${task.leg.to} on ${task.leg.date}. Import all visible Best results using the RouteWise overlay, then use the broad-research capture action.`);
});
$('broadOpenNext').addEventListener('click',()=>{
  const task=broadTasks().find(item=>!broadCache[item.key]);
  if(!task){status('All unique flight searches have cached results. Open an individual search to refresh it.');return;}
  activeResearchKey=task.key;chrome.tabs.create({url:googleFlightsSearchUrl(task.leg)});
  renderBroadResearch();
  status(`Opened ${task.leg.from} → ${task.leg.to} ${task.leg.date}. Import all visible Best results in the overlay.`);
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
    const search=transportSearch(leg);
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
$('generate').addEventListener('click', async () => {
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
    trip=next;routes=nextRoutes;
    $('editor').hidden=true;currentKey=null;
    await persist();render();
    const withConnections=routes.filter(route=>route.legs.length>2).length;
    generationStatus(`${guarded.notices.join(' ')} Generated ${routes.length} candidate routes${withConnections?` (${withConnections} with connections)`:''}.${hubWarning}${groundNotice}`.trim());
  } catch(error) {generationStatus(`Could not generate routes: ${error.message}`);}
  finally {$('generate').disabled=false;}
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
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local'||!changes.pendingFlightCapture)return;
  pendingFlightCapture=changes.pendingFlightCapture.newValue||null;
  showCaptureNotice();
  $('broadConfirmOneWay').checked=false;
  renderBroadResearch();
  // Fast path: a capture from the exact one-way search RouteWise opened can be
  // safely cached immediately, without another confirmation click. Unknown
  // page contexts still require manual review of the price scope.
  const task=broadTasks().find(item=>item.key===activeResearchKey);
  if(task && pendingFlightCapture?.text && captureFromOpenedOneWaySearch(pendingFlightCapture,task)){
    try{
      const record=captureBroadSearch(pendingFlightCapture,task);
      broadCache[task.key]=record;
      persist().then(()=>{render();status(`Auto-cached ${record.options.length} Best-tab one-way results for ${task.leg.from} → ${task.leg.to}. The preliminary comparison is updated.`);})
        .catch(error=>status(`Could not save broad results: ${error.message}`));
    }catch(error){status(`Broad import needs review: ${error.message}`);}
  }
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
  const editButton = event.target.closest('button[data-edit]');
  const searchButton = event.target.closest('button[data-search]');
  const roundTripButton = event.target.closest('button[data-roundtrip-route]');
  const ticketButton=event.target.closest('button[data-price-roundtrip-route]');
  const copyButton = event.target.closest('button[data-copy-route]');
  const removeButton = event.target.closest('button[data-remove-manual]');
  if(importButton)openFlightImport(importButton.dataset.importFlight);
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
$('domDemo').addEventListener('click', () => {
  chrome.tabs.create({url:chrome.runtime.getURL('demo-results.html')});
});
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({version:'0.4.9',trip,bag,offers,roundTripTickets,flightTimes,groundTimes,flightResearch,broadCache,routes,manualRoutes,parsedPlan,parseWarnings,parseSource,parsedRequest,parseDebug},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'routewise-trip.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  status('Exported trip data.');
});
async function init() {
  try {
    const saved = await chrome.storage.local.get(['trip','bag','offers','roundTripTickets','flightTimes','groundTimes','flightResearch','pendingFlightCapture','routes','manualRoutes','destinationCandidates','destinationCandidateKey','connectionCandidates','connectionCandidateKey','parsedPlan','parseWarnings','parseSource','parsedRequest','parseDebug']);
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
    pendingFlightCapture = saved.pendingFlightCapture?.text ? saved.pendingFlightCapture : null;
    flightTimes = saved.flightTimes && !Array.isArray(saved.flightTimes) && typeof saved.flightTimes === 'object' ? saved.flightTimes : {};
    groundTimes = saved.groundTimes && !Array.isArray(saved.groundTimes) && typeof saved.groundTimes==='object' ? saved.groundTimes : {};
    manualRoutes=Array.isArray(saved.manualRoutes)?saved.manualRoutes.filter(route=>route?.manual===true && Array.isArray(route.legs)):[];
    parsedPlan = saved.parsedPlan || null;
    parseWarnings = saved.parseWarnings || [];
    parseSource = saved.parseSource || '';
    parseDebug = saved.parseDebug || null;
    parsedRequest = saved.parsedRequest || '';
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
    setForm();
    showPlanPreview();
    // A previously saved country may require Groq. Don't fail extension startup.
    routes = Array.isArray(saved.routes) ? saved.routes : [];
    if (!routes.length) {
      try { routes=generatePlannedRoutes(generationPlan(trip),{destinationCandidates}); }
      catch { routes=[]; }
    }
    render();
    showCaptureNotice();
    status('Ready. Your data stays in this Chrome extension’s local storage.');
  } catch (error) { status(`Startup error: ${error.message}`); }
}
init();
