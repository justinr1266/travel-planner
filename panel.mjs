import { AIRPORTS, airportName, rankRoutes, normalizedOffer } from './core.mjs';
import { generatePlannedRoutes } from './route-engine.mjs';
import { DEMO_PLAN, validateTripPlan } from './trip-parser.mjs';
import { applyPlanToForm } from './plan-ui.mjs';
import { googleFlightsSearchUrl, googleFlightsRoundTripUrl, findRoundTripPairs } from './search-links.mjs';

const $ = (id) => document.getElementById(id);
const DEFAULT_TRIP = {
  origin:'BCN', preferred:'SPC', destination:'MAD', requestedRegion:'Canary Islands',
  startDate:'2027-02-02', endDate:'2027-02-10',
  request:'Barcelona to the Canary Islands, preferably La Palma, ending in Madrid. Leave Barcelona February 2–4, 2027, and arrive in Madrid by February 10, 2027. One overhead cabin bag.'
};
const DEFAULT_BAG = {name:'Overhead backpack',length:55,width:35,depth:23,kg:8};
let trip = structuredClone(DEFAULT_TRIP);
let bag = structuredClone(DEFAULT_BAG);
let offers = {};
let routes = [];
let currentKey = null;
let parsedPlan = null;
let parseWarnings = [];
let parseSource = '';
let parsedRequest = ''; // AI constraints are valid only for the description that was interpreted.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function status(message) { $('status').textContent = message; }
function money(n) { return new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR'}).format(n); }
function dateDisplay(value) { return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB',{month:'short',day:'numeric',timeZone:'UTC'}); }
function fillSelect(id, selected) {
  $(id).replaceChildren();
  if (id === 'preferred') {
    const none = document.createElement('option'); none.value = ''; none.textContent = 'No specific stop';
    $(id).append(none);
  }
  for (const [code,name] of Object.entries(AIRPORTS)) {
    const option = document.createElement('option');
    option.value = code; option.textContent = `${name} (${code})`;
    $(id).append(option);
  }
  $(id).value = selected;
}
function setForm() {
  for (const key of ['origin','preferred','destination']) fillSelect(key,trip[key]);
  for (const key of ['startDate','endDate','request']) $(key).value = trip[key];
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
async function persist() { await chrome.storage.local.set({trip,bag,offers,parsedPlan,parseWarnings,parseSource,parsedRequest}); }
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
    ['Preferred stop',showAirport(p.preferred)],
    ['Requested regions',p.requested_regions.length ? p.requested_regions.join(', ') : 'None specified'],
    ['Destination',showAirport(p.destination)],
    ['Departure window',formatWindow(p.depart_earliest,p.depart_latest,p.fixed_departure)],
    ['Arrival deadline/window',formatWindow(p.arrive_earliest,p.arrive_latest,p.fixed_arrival)],
    ['Bag type',p.bag_type.replaceAll('_',' ')],
    ['Minimum nights at stop',p.min_nights_at_preferred ?? 'Unspecified'],
    ['Priority',p.priority.replaceAll('_',' ')],
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
    trip = applied.trip;
    bag = applied.bag;
    setForm();
    await persist();
    const retained = applied.retained.length ? ` Kept previous values for: ${applied.retained.join(', ')}.` : '';
    status(`Applied recognized details. Review the dates and press Generate candidate routes.${retained}`);
  });
}
async function setParsedPlan(raw,source,sourceText=$('request').value.trim()) {
  const result = validateTripPlan(raw);
  parsedPlan = result.plan;
  parsedRequest = sourceText;
  parseWarnings = result.warnings;
  parseSource = source;
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
  $('interpret').disabled = true;
  $('interpret').textContent = 'Interpreting…';
  status('Sending trip text to local server for AI interpretation…');
  try {
    const response = await fetch('http://127.0.0.1:8787/parse-trip', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ request:description }),
      signal: AbortSignal.timeout(35000)
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Local server returned an invalid response.'); }
    if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);
    await setParsedPlan(data.plan,'ai',description);
    // Synchronize warnings supplied by the backend only when present and strings.
    if (Array.isArray(data.warnings)) {
      parseWarnings = data.warnings.filter(x=>typeof x==='string').slice(0,15);
      showPlanPreview();
      await persist();
    }
    status('AI interpretation ready. Review it and click Apply known details.');
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
    preferred: form.preferred || null,
    destination: form.destination,
    requested_regions: form.requestedRegion ? [form.requestedRegion] : [],
    depart_earliest: form.startDate,
    depart_latest: usesOriginalStart ? (parsedPlan.depart_latest || form.startDate) : form.startDate,
    arrive_latest: form.endDate,
    min_nights_at_preferred: validParsed ? parsedPlan.min_nights_at_preferred : null
  };
}
function render() {
  const ranked = rankRoutes(routes, offers);
  $('routeCount').textContent = String(ranked.length);
  $('routes').innerHTML = ranked.map(({route,summary},i) => {
    const roundTripPairs = new Map(findRoundTripPairs(route.legs).map(pair => [pair.outboundIndex, pair.returnIndex]));
    const totalLabel = summary.complete ? money(summary.total) : `${summary.pricedLegs}/${route.legs.length}`;
    const totalSub = summary.complete ? 'Recorded total' : 'Legs priced';
    const legs = route.legs.map((leg, legIndex) => {
      const offer = offers[leg.key];
      const cost = offer ? `<div class="leg-pricing">${money(offer.fare + offer.bagFee + offer.transferCost)}</div>` : '<span class="tag">Unpriced</span>';
      const source = offer?.source ? `<a class="link" target="_blank" rel="noopener noreferrer" href="${escapeHtml(offer.source)}">Saved source ↗</a>` : '';
      const returnIndex = roundTripPairs.get(legIndex);
      const roundTripButton = returnIndex === undefined ? '' :
        `<button class="secondary" data-roundtrip-route="${escapeHtml(route.id)}" data-roundtrip-index="${legIndex}" title="Search ${escapeHtml(leg.from)} to ${escapeHtml(leg.to)} on ${escapeHtml(leg.date)} and return ${escapeHtml(route.legs[returnIndex].date)}">Round trip ↗</button>`;
      const returnNote = returnIndex === undefined ? '' : `<div class="leg-meta">Return: ${dateDisplay(route.legs[returnIndex].date)} · ${escapeHtml(airportName(leg.to))} → ${escapeHtml(airportName(leg.from))}</div>`;
      return `<div class="leg">
        <div><div class="leg-title">${escapeHtml(airportName(leg.from))} → ${escapeHtml(airportName(leg.to))}</div>
        <div class="leg-meta">${dateDisplay(leg.date)} · ${escapeHtml(leg.mode)}</div>${returnNote}${cost}${source}</div>
        <div class="leg-actions">
          <button class="secondary" data-search="${escapeHtml(leg.key)}">${leg.mode === 'flight' ? 'One way ↗' : 'Find fare ↗'}</button>${roundTripButton}
          <button class="ghost" data-edit="${escapeHtml(leg.key)}">${offer?'Edit':'Add'} €</button>
        </div></div>`;
    }).join('');
    const dests = [route.legs[0].from,...route.legs.map(l=>l.to)].map(airportName).join(' → ');
    return `<article class="route ${summary.complete?'route-complete':''}">
      <div class="route-head"><div><h3>${i+1}. ${escapeHtml(route.name)}</h3><p>${escapeHtml(route.details)}</p></div>
      <div class="route-cost">${totalLabel}<small>${totalSub}</small></div></div>
      <div class="route-body"><div class="route-dest">${escapeHtml(dests)}</div>${legs}</div></article>`;
  }).join('');
}
function lookupLeg(key) { return routes.flatMap(route => route.legs).find(leg => leg.key === key); }
function editOffer(key) {
  const leg = lookupLeg(key);
  if (!leg) { status('That leg no longer exists.'); return; }
  currentKey = key;
  const offer = offers[key];
  $('editingLeg').textContent = `${airportName(leg.from)} → ${airportName(leg.to)} · ${leg.date} · ${leg.mode}`;
  $('fare').value = offer?.fare ?? '';
  $('bagFee').value = offer?.bagFee ?? 0;
  $('transferCost').value = offer?.transferCost ?? 0;
  $('source').value = offer?.source ?? '';
  $('note').value = offer?.note ?? '';
  $('editor').hidden = false;
  $('editor').scrollIntoView({behavior:'smooth',block:'start'});
  $('fare').focus();
}
function searchLeg(key) {
  const leg = lookupLeg(key);
  if (!leg) { status('That leg no longer exists.'); return; }
  const provider = leg.mode === 'flight' ? 'Google Flights' : leg.mode === 'train' ? 'Renfe' : 'Ferryhopper';
  try {
    const url = leg.mode === 'flight' ? googleFlightsSearchUrl(leg) :
      leg.mode === 'train' ? 'https://www.renfe.com/es/en' : 'https://www.ferryhopper.com/';
    chrome.tabs.create({url});
    const routeText = `${airportName(leg.from)} → ${airportName(leg.to)} on ${leg.date}`;
    if (leg.mode === 'flight') {
      status(`Opened a one-way Google Flights search link for ${routeText}. Verify that Google filled the route and date; if not, enter them on the site. Check baggage and save the actual fare here.`);
    } else {
      status(`Opened ${provider}. Search ${routeText} manually, check baggage and transfers, then save the fare here.`);
    }
  } catch (error) {
    status(`Could not prepare ${provider} search: ${error.message}`);
  }
}

function searchRoundTrip(routeId, outboundIndex) {
  const route = routes.find(candidate => candidate.id === routeId);
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
  const portugal = ['LIS','OPO','FAO'];
  const canaries = ['SPC','TFN','TFS','LPA'];
  if ((region === 'Portugal' && canaries.includes(preferred)) ||
      (region === 'Canary Islands' && portugal.includes(preferred))) $('preferred').value = '';
});
$('generate').addEventListener('click', async () => {
  try {
    const next = getFormTrip();
    const nextRoutes = generatePlannedRoutes(generationPlan(next));
    trip = next; routes = nextRoutes;
    $('editor').hidden = true; currentKey = null;
    await persist(); render();
    status('Generated unverified route patterns with tentative dates. Search each leg and save actual, baggage-aware offers.');
  } catch (error) { status(`Please fix trip setup: ${error.message}`); }
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
$('routes').addEventListener('click', (event) => {
  const editButton = event.target.closest('button[data-edit]');
  const searchButton = event.target.closest('button[data-search]');
  const roundTripButton = event.target.closest('button[data-roundtrip-route]');
  if (roundTripButton) searchRoundTrip(roundTripButton.dataset.roundtripRoute, Number(roundTripButton.dataset.roundtripIndex));
  if (editButton) editOffer(editButton.dataset.edit);
  if (searchButton) searchLeg(searchButton.dataset.search);
});
$('cancelEdit').addEventListener('click', () => { $('editor').hidden = true; currentKey = null; });
$('offerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentKey) return;
  try {
    const offer = normalizedOffer({
      fare:$('fare').value,bagFee:$('bagFee').value,
      transferCost:$('transferCost').value,source:$('source').value,note:$('note').value
    });
    offers[currentKey] = offer;
    await persist();
    $('editor').hidden = true; currentKey = null;
    render(); status('Offer saved. Shared route segments update automatically.');
  } catch (error) { status(`Could not save fare: ${error.message}`); }
});
$('clearOffers').addEventListener('click', async () => {
  if (!confirm('Delete every saved price? This cannot be undone.')) return;
  offers = {}; await persist(); render(); status('Saved offers cleared.');
});
$('domDemo').addEventListener('click', () => {
  chrome.tabs.create({url:chrome.runtime.getURL('demo-results.html')});
});
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({version:'0.3',trip,bag,offers,parsedPlan,parseWarnings,parseSource,parsedRequest},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'routewise-trip.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  status('Exported trip data.');
});
async function init() {
  try {
    const saved = await chrome.storage.local.get(['trip','bag','offers','parsedPlan','parseWarnings','parseSource']);
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
    parsedPlan = saved.parsedPlan || null;
    parseWarnings = saved.parseWarnings || [];
    parseSource = saved.parseSource || '';
    parsedRequest = saved.parsedRequest || '';
    // Older parser results do not have requested_regions. Keep the displayed plan safe.
    if (parsedPlan && !Array.isArray(parsedPlan.requested_regions)) {
      parsedPlan = null; parseWarnings = []; parseSource = ''; parsedRequest = '';
    }
    setForm();
    showPlanPreview();
    routes = generatePlannedRoutes(generationPlan(trip));
    render();
    status('Ready. Your data stays in this Chrome extension’s local storage.');
  } catch (error) { status(`Startup error: ${error.message}`); }
}
init();
