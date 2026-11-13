// Manually authored mixed-mode routes. A name entered for a station, bus stop,
// or ferry port is a user-supplied terminal, NOT a verified stop or timetable.
// Future GTFS/ferry adapters may resolve these typed terminals to stable IDs.
import {legKey, parseISODate} from './core.mjs';
import {resolveLocation, LOCATION_RECORDS, fold} from './location-resolver.mjs';

export const TRAVEL_MODES=Object.freeze(['flight','train','bus','ferry','transfer']);
export const TERMINAL_KINDS=Object.freeze(['airport','station','bus_stop','port','place']);
const allowed={
  flight: {from:['airport'],to:['airport']},
  train: {from:['station'],to:['station']},
  ferry: {from:['port'],to:['port']},
  bus: {from:TERMINAL_KINDS,to:TERMINAL_KINDS},
  transfer: {from:TERMINAL_KINDS,to:TERMINAL_KINDS}
};
export const modeLabel=mode=>({flight:'Flight',train:'Train',bus:'Bus',ferry:'Ferry',transfer:'Transfer'}[mode]||mode);

function terminal(raw,kind,records){
  if(!TERMINAL_KINDS.includes(kind)) throw new Error(`Invalid terminal type: ${kind}.`);
  const name=String(raw||'').trim().replace(/\s+/g,' ');
  if(!name || name.length>120)throw new Error('Each leg needs a terminal name (1–120 characters).');
  if(kind==='airport') {
    const result=resolveLocation(name,{records});
    if(!result || result.kind==='metro')throw new Error(`Airport “${name}” was not resolved to a physical airport. Choose an airport code.`);
    return {id:result.code,label:result.label||result.city,kind:'airport'};
  }
  if(/^[A-Z]{3}$/.test(name) && resolveLocation(name,{records}))
    throw new Error(`“${name}” is an airport code. Enter the actual ${kind.replace('_',' ')} name or change its terminal type.`);
  // Names must be city-qualified if ambiguous (user input, unverified).
  // Encode the folded full label, preserving accents in the display name.
  const normalized=fold(name);
  if(!normalized)throw new Error('Terminal name must contain letters or numbers.');
  return {id:`${kind}:${encodeURIComponent(normalized)}`,label:name,kind};
}
export function normalizeManualLeg(row,{records=LOCATION_RECORDS}={}){
  const mode=String(row?.mode||'');
  if(!TRAVEL_MODES.includes(mode))throw new Error('Choose a supported mode: flight, train, bus, ferry, or transfer.');
  const fromKind=row.fromKind || (mode==='flight'?'airport':mode==='train'?'station':mode==='ferry'?'port':'place');
  const toKind=row.toKind || (mode==='flight'?'airport':mode==='train'?'station':mode==='ferry'?'port':'place');
  if(!allowed[mode].from.includes(fromKind)||!allowed[mode].to.includes(toKind))
    throw new Error(`${modeLabel(mode)} requires appropriate terminal types (flight: airports; train: stations; ferry: ports).`);
  parseISODate(row.date);
  const from=terminal(row.from,fromKind,records);
  const to=terminal(row.to,toKind,records);
  if(from.id===to.id)throw new Error('A leg must travel between distinct terminals.');
  const leg={from:from.id,to:to.id,date:row.date,mode,fromLabel:from.label,toLabel:to.label,
    fromKind:from.kind,toKind:to.kind,verifiedSchedule:false};
  leg.key=legKey(leg);
  return leg;
}
export function draftFromRoute(route){
  if(!route?.legs?.length)throw new Error('Choose an itinerary to copy.');
  return route.legs.map(leg=>({mode:leg.mode||'flight',date:leg.date,
    from:leg.fromKind==='airport'?leg.from:(leg.fromLabel||leg.from),
    to:leg.toKind==='airport'?leg.to:(leg.toLabel||leg.to),
    fromKind:leg.fromKind||'airport',toKind:leg.toKind||'airport'}));
}
export function insertedTransfer(rows,index){
  const previous=rows[index],next=rows[index+1];
  if(!previous)throw new Error('Choose a leg before inserting a transfer.');
  return {mode:'transfer',date:previous.date,from:previous.to,fromKind:previous.toKind,
    to:next?.from||'',toKind:next?.fromKind||'airport'};
}
export function tripSignature(trip){
  return JSON.stringify([trip?.origin||'',trip?.preferred||'',trip?.destination||'',
    trip?.startDate||'',trip?.endDate||'',trip?.request||'']);
}
export function buildManualRoute({name,rows,trip,primary=null,id}, {records=LOCATION_RECORDS}={}){
  if(!Array.isArray(rows)||rows.length===0||rows.length>16)throw new Error('Enter 1–16 travel legs.');
  const legs=rows.map((row,i)=>{try{return normalizeManualLeg(row,{records});}
    catch(error){throw new Error(`Leg ${i+1}: ${error.message}`);}});
  for(let i=1;i<legs.length;i++){
    if(legs[i-1].to!==legs[i].from)
      throw new Error(`Legs ${i} and ${i+1} do not connect. Add a transfer or make the terminal names and types match.`);
    if(parseISODate(legs[i].date)<parseISODate(legs[i-1].date))
      throw new Error(`Leg ${i+1} departs before the preceding leg's date.`);
  }
  if(trip?.startDate && legs[0].date!==trip.startDate)
    throw new Error('The first leg must use the trip departure date.');
  if(trip?.endDate && parseISODate(legs.at(-1).date)>parseISODate(trip.endDate))
    throw new Error('The last leg is after the final arrival date.');
  if(trip?.arrivalRule==='fixed' && legs.at(-1).date!==trip.endDate)
    throw new Error('The final leg must arrive on the exact final date (dates are tentative).');
  let stay=null;
  const preferred=primary || trip?.preferred;
  if(preferred){
    const focusIndex=legs.findIndex(leg=>leg.to===preferred);
    const leavingIndex=legs.findIndex((leg,i)=>i>focusIndex && leg.from===preferred);
    if(focusIndex>=0 && leavingIndex>focusIndex){
      const nights=Math.round((parseISODate(legs[leavingIndex].date)-parseISODate(legs[focusIndex].date))/86400000);
      stay={destination:preferred,arrivalDate:legs[focusIndex].date,departureDate:legs[leavingIndex].date,
        possibleNights:nights,verified:false};
    }
  }
  const places=Object.fromEntries(legs.flatMap(leg=>[[leg.from,leg.fromLabel],[leg.to,leg.toLabel]]));
  const label=String(name||'').trim().slice(0,90)||'My multimodal alternative';
  return {id:id||`manual-${crypto.randomUUID()}`,manual:true,tripSignature:tripSignature(trip),
    name:label,details:'User-entered multimodal alternative; routes, terminal names and services not independently verified.',
    legs,places,primaryStay:stay,arrivalRule:trip?.arrivalRule||'by',warnings:[
      'Manual mode and terminal entries are not verified against train, ferry or bus schedules. Confirm each service, station and connection.',
      'Only dates are known; same-day transfers and connection buffers have not been checked.'
    ]};
}

export function manualRouteForTrip(route,trip){return route?.manual===true && route.tripSignature===tripSignature(trip);}
