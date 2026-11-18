// Omio is a client-rendered page. A complete Chrome tab does not mean its
// journey cards have settled, so sample the actual visible cards repeatedly.
// This helper has no browser dependencies and can be tested with simulated loads.
const DEFAULT_TIMEOUT_MS=90000;
const DEFAULT_POLL_MS=1500;
const DEFAULT_SETTLE_MS=8000;

// Keep unrelated Omio results from indefinitely restarting a valid train's
// stabilization timer. Compare all exact-station cards, not just the cheapest.
function station(value){
  return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
export function matchingTrainJourneys(snapshot,task){
  if(!task || !Array.isArray(snapshot?.journeys))return [];
  const leg=task.leg||task;
  const from=station(leg.fromLabel||leg.from),to=station(leg.toLabel||leg.to);
  if(!from||!to)return [];
  return snapshot.journeys.filter(journey=>
    station(journey.fromStation)===from && station(journey.toStation)===to);
}

export function trainResultFingerprint(snapshot,task=null) {
  if (!snapshot?.ok || snapshot.readyState !== 'complete' || snapshot.tabComplete !== true) return null;
  if (snapshot.pageBusy) return null;
  const url=String(snapshot.sourceUrl||'');
  if (!/^https:\/\/(?:www\.)?(?:omio\.com|thetrainline\.com)\//i.test(url)) return null;
  if (snapshot.cardSource === 'omio_result_cards' && Array.isArray(snapshot.journeys) && snapshot.journeys.length) {
    // If we have exact-station matches, ignore unrelated results whose prices
    // or order can change independently while this train's fares are stable.
    // Keep every matching card (including cheaper late arrivals), not just one.
    const matching=task?matchingTrainJourneys(snapshot,task):[];
    const observed=matching.length?matching:snapshot.journeys;
    const normalized=observed.map(j=>[
      j.fromStation,j.toStation,j.departureText,j.arrivalText,
      j.priceText,j.provider,j.durationText,j.changesText
    ]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify([url,'omio',String(snapshot.departureDateText||''),normalized]);
  }
  // Non-Omio structured cards are for review only, never automatic caching.
  if (snapshot.cardSource === 'journey_elements' && Array.isArray(snapshot.cards) && snapshot.cards.length) {
    return JSON.stringify([url,'review',snapshot.cards]);
  }
  return null;
}

export async function waitForStableTrainResults({
  read, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  now=()=>Date.now(), onProgress=()=>{}, shouldStop=()=>false,
  timeoutMs=DEFAULT_TIMEOUT_MS, pollMs=DEFAULT_POLL_MS,
  settleMs=DEFAULT_SETTLE_MS, stableReads=4, task=null
}={}) {
  if (typeof read !== 'function') throw new Error('A train page reader is required.');
  const started=now();
  let previous=null, stableSince=0, repeated=0, attempts=0;
  let lastReadable=null;
  while (now()-started < timeoutMs) {
    if (shouldStop()) return {status:'stopped',attempts};
    let snapshot=null;
    try {snapshot=await read();} catch { /* Navigation and SPA hydration can interrupt messaging. */ }
    attempts++;
    const signature=trainResultFingerprint(snapshot,task);
    if(signature && snapshot?.ok && snapshot.cardSource==='omio_result_cards' && snapshot.journeys?.length)
      lastReadable=snapshot;
    if (signature) {
      if (signature===previous) repeated++;
      else {previous=signature;stableSince=now();repeated=1;}
      if (repeated>=stableReads && now()-stableSince>=settleMs) {
        return {status:'ready',capture:snapshot,attempts};
      }
    } else {
      // A redirect, a loading document, or absent result cards starts over.
      previous=null;stableSince=0;repeated=0;
    }
    onProgress({elapsedMs:now()-started,attempts,settling:Boolean(signature),repeated,
      journeysSeen:snapshot?.journeys?.length||0,
      matchingSeen:matchingTrainJourneys(snapshot,task).length});
    await sleep(pollMs);
  }
  // Never silently discard captured cards because ads or unrelated routes
  // kept changing. The UI can offer them for human review (not auto-cache).
  return lastReadable
    ? {status:'review',capture:lastReadable,attempts}
    : {status:'timeout',attempts};
}
