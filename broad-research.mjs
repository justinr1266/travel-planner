// Broad, user-triggered one-way search research. Search quotes are never
// promoted to checked fares; every amount here remains an estimate.
import {parseGoogleFlightsSearchResults,searchOptionMatchesLeg} from './google-flights-search.mjs';
import {matchingTicketsForRoute} from './roundtrip-tickets.mjs';
import {connectionWindows} from './connection-windows.mjs';
import {googleFlightsSearchUrl} from './search-links.mjs';

export const TRAIN_ESTIMATE_EUR=20;
export const MAX_BROAD_OPTIONS=5;
export const CACHE_STALE_HOURS=24;
const ISO=/^\d{4}-\d{2}-\d{2}$/;
const IATA=/^[A-Z]{3}$/;
const DAY=86400000;
function durationMinutes(text){
  const hrs=Number(String(text||'').match(/(\d+)\s*hr/i)?.[1]||0);
  const mins=Number(String(text||'').match(/(\d+)\s*min/i)?.[1]||0);
  return hrs*60+mins||null;
}

export function researchKey(leg){
  if(leg?.mode!=='flight'||!IATA.test(leg.from||'')||!IATA.test(leg.to||'')||
    leg.from===leg.to||!ISO.test(leg.date||''))return null;
  return [leg.from,leg.to,leg.date,'economy','EUR','1adult'].join('|');
}
export function researchTasks(routes=[]){
  const found=new Map();
  for(const route of routes){
    const used=new Set();
    for(const leg of route?.legs||[]){
      const key=researchKey(leg);
      if(!key)continue;
      if(!found.has(key))found.set(key,{key,leg:{from:leg.from,to:leg.to,date:leg.date,mode:'flight'},routeCount:0});
      if(!used.has(key)){found.get(key).routeCount++;used.add(key);}
    }
  }
  return [...found.values()];
}
// The exact search RouteWise opened is an explicit one-way context. Avoid
// relying on a label Google Flights may omit; never trust arbitrary page URLs.
export function captureFromOpenedOneWaySearch(capture,task){
  try{
    const source=new URL(capture?.sourceUrl||'');
    const expected=new URL(googleFlightsSearchUrl(task?.leg));
    return source.origin==='https://www.google.com' &&
      source.pathname===expected.pathname &&
      Boolean(source.searchParams.get('tfs')) &&
      source.searchParams.get('tfs')===expected.searchParams.get('tfs') &&
      source.searchParams.get('curr')==='EUR';
  }catch{return false;}
}
export function captureBroadSearch(capture,task,{confirmOneWay=false,now=new Date().toISOString()}={}){
  if(!capture?.text||!task?.leg||!researchKey(task.leg))throw new Error('Choose a valid one-way research task and import Google Flights results.');
  const parsed=parseGoogleFlightsSearchResults(capture.text);
  if(!parsed?.options?.length)throw new Error('No supported flight cards in this capture.');
  const matching=parsed.options.filter(option=>searchOptionMatchesLeg(option,task.leg));
  if(!matching.length)throw new Error('The imported results do not match the selected airports and travel date.');
  const badScope=matching.some(option=>option.priceScope==='round_trip_search_quote');
  if(badScope)throw new Error('This is a round-trip search. Open the one-way research link before importing estimates.');
  // Unknown price context requires an explicit user assertion, never inference
  // from the existence of a matching leg or the price itself.
  if(matching.some(option=>option.priceScope!=='one_way_search_quote')&&!confirmOneWay && !captureFromOpenedOneWaySearch(capture,task))
    throw new Error('Confirm that this is a ONE-WAY Google Flights search before using unlabeled prices.');
  const seen=new Set(),options=[];
  for(const o of matching){
    if(!Number.isFinite(o.displayedPriceEur)||o.displayedPriceEur<0)continue;
    const unique=[o.carrier,o.departureClock,o.arrivalClock,o.arrivalDayOffset,o.stops,o.displayedPriceEur].join('|');
    if(seen.has(unique))continue;
    seen.add(unique);
    options.push({from:o.from,to:o.to,date:task.leg.date,departureClock:o.departureClock,
      arrivalClock:o.arrivalClock,arrivalDayOffset:o.arrivalDayOffset,carrier:o.carrier,
      stops:o.stops,via:o.via||[],duration:o.duration||'',estimatedEur:o.displayedPriceEur,
      priceScope:'one_way_indicative'});
    if(options.length>=MAX_BROAD_OPTIONS)break;
  }
  if(!options.length)throw new Error('Matching flights did not contain usable EUR prices.');
  return {key:task.key,leg:{...task.leg},options,sourceUrl:String(capture.sourceUrl||'').slice(0,2048),
    capturedAt:now,quoteStatus:'indicative',resultCount:matching.length};
}
export function researchAge(record,now=Date.now()){
  const age=now-Date.parse(record?.capturedAt||'');
  return !Number.isFinite(age)||age<0||age>CACHE_STALE_HOURS*3600000?'stale':'fresh';
}
function roundEur(amount){return Math.round(amount*100)/100;}
function addDay(iso,offset){
  const ms=Date.parse(iso+'T00:00:00Z');
  return Number.isFinite(ms)?new Date(ms+offset*DAY).toISOString().slice(0,10):'';
}
function windowForLeg(route,legIndex,bufferMinutes,groundTimes){
  return connectionWindows(route,{}, {bufferMinutes,groundTimes}).find(w=>w.flightLegIndex===legIndex)||null;
}
function acceptByGroundWindow(route,legIndex,option,window){
  if(!window)return {allowed:true,check:'not_needed'};
  if(!window.earliestDepartureLocal)return {allowed:true,check:'ground_arrival_missing'};
  // Only compare wall clocks when ground ends at the SAME named airport,
  // the ground timetable provides an IANA zone, and the flight is local there.
  // In other cases leave the connection unverified instead of false certainty.
  const ground=route.legs[window.groundLegIndex];
  const flight=route.legs[legIndex];
  if(ground.to!==flight.from || !window.timezone?.includes('/'))
    return {allowed:true,check:'timezone_or_transfer_unverified'};
  const flightStamp=`${flight.date} ${option.departureClock}`;
  return flightStamp>=window.earliestDepartureLocal
    ? {allowed:true,check:'meets_buffer'}:{allowed:false,check:'below_buffer'};
}
// Independently ticketed flight legs need their own airport connection window.
// Two hours is a conservative preliminary minimum, not a booking guarantee.
const FLIGHT_TRANSFER_MINUTES=120;
function acceptByPreviousFlight(previous,leg,option){
  if(previous?.leg?.mode!=='flight'||previous.leg.to!==leg.from || !previous.option)
    return {allowed:true,check:'previous_flight_time_unverified'};
  const arrived=addDay(previous.leg.date,previous.option.arrivalDayOffset||0);
  const gap=(Date.parse(`${leg.date}T${option.departureClock}:00Z`)-
    Date.parse(`${arrived}T${previous.option.arrivalClock}:00Z`))/60000;
  if(!Number.isFinite(gap))return {allowed:true,check:'previous_flight_time_unverified'};
  // A multi-day stay between independent flights is not a connection.
  if(gap>=24*60)return {allowed:true,check:'separate_days'};
  if(gap<FLIGHT_TRANSFER_MINUTES)return {allowed:false,check:'short_flight_connection'};
  return {allowed:true,check:'flight_connection_meets_planning_buffer'};
}
export function estimateRoute(route,cache={},offers={},tickets={}, {bufferMinutes=180,groundTimes={}}={}){
  const ticketMatches=matchingTicketsForRoute(route,tickets);
  const ticketByLeg=new Map();
  for(const match of ticketMatches){
    ticketByLeg.set(match.outboundIndex,{ticket:match.ticket,charge:true});
    ticketByLeg.set(match.returnIndex,{ticket:match.ticket,charge:false});
  }
  let total=0,missing=0,estimatedCount=0,verifiedCount=0,trainCount=0;
  let conflicts=0,uncheckedConnections=0,observedDurationMinutes=0,unknownDurations=0;
  const selected=[];
  route.legs.forEach((leg,index)=>{
    const shared=ticketByLeg.get(index);
    const offer=offers?.[leg.key];
    const window=leg.mode==='flight'?windowForLeg(route,index,bufferMinutes,groundTimes):null;
    const options=leg.mode==='flight'?cache[researchKey(leg)]?.options||[]:[];
    const previous=index?selected[index-1]:null;
    const previousIsConnectingFlight=previous?.leg.mode==='flight' && previous.leg.to===leg.from &&
      Date.parse(leg.date+'T00:00:00Z')-Date.parse(previous.leg.date+'T00:00:00Z')<=2*DAY;
    const accepted=options.map(option=>{
      const groundCheck=acceptByGroundWindow(route,index,option,window);
      const flightCheck=previousIsConnectingFlight?acceptByPreviousFlight(previous,leg,option):{allowed:true,check:'not_needed'};
      return {...option,...groundCheck,flightConnectionCheck:flightCheck.check,allowed:groundCheck.allowed&&flightCheck.allowed};
    }).filter(option=>option.allowed);
    // Cost optimization initially picks the cheapest FEASIBLE captured option.
    // Never infer a timestamp for a verified ticket from a different search card.
    accepted.sort((a,b)=>a.estimatedEur-b.estimatedEur || a.departureClock.localeCompare(b.departureClock));
    const choice=accepted[0]||null;
    if((window?.earliestDepartureLocal||previousIsConnectingFlight) && options.length && !accepted.length)conflicts++;
    if(previousIsConnectingFlight && (!previous?.option||(!accepted.length && !options.length)))uncheckedConnections++;
    if(window && (!choice||!['meets_buffer','not_needed'].includes(choice.check)))uncheckedConnections++;
    if(leg.mode==='flight'&&choice){
      const minutes=durationMinutes(choice.duration);
      if(minutes!==null)observedDurationMinutes+=minutes;else unknownDurations++;
    }
    if(shared){
      if(shared.charge){total+=shared.ticket.totalEur;verifiedCount++;}
      selected.push({leg,kind:'verified_roundtrip',costEur:shared.charge?shared.ticket.totalEur:0,option:null,ticketId:shared.ticket.id});
    }else if(offer && Number.isFinite(offer.fare)){
      const amount=offer.fare+(offer.bagFee||0)+(offer.transferCost||0);
      total+=amount;verifiedCount++;
      selected.push({leg,kind:'verified',costEur:amount,option:null});
    }else if(leg.mode==='train'){
      total+=TRAIN_ESTIMATE_EUR;estimatedCount++;trainCount++;
      selected.push({leg,kind:'train_estimate',costEur:TRAIN_ESTIMATE_EUR,option:null});
    }else if(choice){
      total+=choice.estimatedEur;estimatedCount++;
      selected.push({leg,kind:'flight_estimate',costEur:choice.estimatedEur,option:choice,cacheAge:researchAge(cache[researchKey(leg)])});
    }else {
      missing++;
      selected.push({leg,kind:options.length&&window?'connection_conflict':'missing',costEur:null,option:null});
    }
  });
  // Approximate usable time at the primary destination only if both dates and
  // an arrival and later departure are known at the SAME airport. No guesses
  // about transfers or cross-zone flight durations.
  let destinationHours=null;
  if(route.primaryStay?.destination){
    const dest=route.primaryStay.destination;
    const arrival=selected.find(s=>s.leg.to===dest && s.option?.arrivalClock);
    const leaving=selected.find(s=>s.leg.from===dest && s.option?.departureClock &&
      s.leg.date>=arrival?.leg.date);
    if(arrival && leaving){
      const a=Date.parse(addDay(arrival.leg.date,arrival.option.arrivalDayOffset)+'T'+arrival.option.arrivalClock+':00Z');
      const b=Date.parse(leaving.leg.date+'T'+leaving.option.departureClock+':00Z');
      if(Number.isFinite(a)&&Number.isFinite(b)&&b>=a)destinationHours=Math.round((b-a)/360000)/10;
    }
  }
  return {routeId:route.id,total:missing?null:roundEur(total),known:roundEur(total),missing,
    trainCount,estimatedCount,verifiedCount,conflicts,uncheckedConnections,destinationHours,observedDurationMinutes,unknownDurations,selected,
    complete:missing===0 && conflicts===0};
}
export function compareBroadRoutes(routes,cache={},offers={},tickets={},opts={}){
  return routes.map((route,index)=>({route,...estimateRoute(route,cache,offers,tickets,opts),originalIndex:index}))
    .sort((a,b)=>{
      if(a.complete!==b.complete)return a.complete?-1:1;
      if(a.conflicts!==b.conflicts)return a.conflicts-b.conflicts;
      if(a.complete&&b.complete){
        if(a.total!==b.total)return a.total-b.total;
      }else if(a.missing!==b.missing)return a.missing-b.missing;
      return a.originalIndex-b.originalIndex;
    });
}
