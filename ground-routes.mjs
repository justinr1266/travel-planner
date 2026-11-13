// Combine GTFS-evidenced intercity trip patterns with existing hypothetical
// flight paths. All route dates remain optimistic; transfer times unverified.
import {legKey} from './core.mjs';
import {chooseDiverseRoutes} from './route-quality.mjs';

const modeKind={train:'station',bus:'bus_stop',ferry:'port'};
function stopTerminal(stop,kind,feedId){
  return {id:`${kind}:gtfs:${encodeURIComponent(feedId||'feed')}:${encodeURIComponent(stop.id)}`,
    label:stop.name,kind};
}
function leg(from,to,mode,date,fields={}){
  const result={from:from.id,to:to.id,fromLabel:from.label,toLabel:to.label,
    fromKind:from.kind,toKind:to.kind,mode,date,verifiedSchedule:false,...fields};
  result.key=legKey(result);
  return result;
}
function groundSegment(edge,date){
  if(!modeKind[edge.mode])return null;
  const kind=modeKind[edge.mode];
  const fromAirport={id:edge.fromAirport,label:edge.fromAirport,kind:'airport'};
  const toAirport={id:edge.toAirport,label:edge.toAirport,kind:'airport'};
  const fromStop=stopTerminal(edge.fromStop,kind,edge.feedId);
  const toStop=stopTerminal(edge.toStop,kind,edge.feedId);
  const transferWarning='Unverified airport-to-station/port transfer: allow time and verify a real local connection.';
  const time=edge.timetable?.status==='scheduled' && edge.timetable.departureLocal?.startsWith(date+' ')?edge.timetable:null;
  return [
    leg(fromAirport,fromStop,'transfer',date,{evidence:'transfer_needed',verificationNote:transferWarning}),
    leg(fromStop,toStop,edge.mode,date,{evidence:time?'gtfs_scheduled':'gtfs_trip_pattern',sourceName:edge.source,
      sourceUrl:edge.sourceUrl,feedValidFrom:edge.validFrom,feedValidTo:edge.validTo,
      ...(time?{departureLocal:time.departureLocal,arrivalLocal:time.arrivalLocal,
        scheduleTimezone:time.timezone,scheduledTripId:time.tripId,verifiedSchedule:true}:{})}),
    leg(toStop,toAirport,'transfer',date,{evidence:'transfer_needed',verificationNote:transferWarning})
  ];
}
const dateNote='GTFS proves a published trip pattern, NOT a service on these exact dates. Check operating days, times, capacity, and fares.';
function groundRoute(base,legs,edge,tag){
  const places={...base.places};
  for(const l of legs){if(l.fromLabel)places[l.from]=l.fromLabel;if(l.toLabel)places[l.to]=l.toLabel;}
  const cover=edge.validFrom||edge.validTo?` Feed coverage: ${edge.validFrom||'?'} to ${edge.validTo||'?'}.`:'';
  const scheduleLeg=legs.find(l=>l.evidence==='gtfs_scheduled');
  const scheduled=Boolean(scheduleLeg);
  const timetableNote=scheduled?`GTFS reports ${edge.mode} ${scheduleLeg.departureLocal}–${scheduleLeg.arrivalLocal} (${scheduleLeg.scheduleTimezone}); train/coach/ferry timetable only, NOT a verified connection to an onward flight.`:dateNote+cover;
  return {...base,id:`ground-${tag}-${base.id}-${edge.feedId}-${edge.fromStop.id}-${edge.toStop.id}`,
    name:`${base.name} · ${edge.mode} via ${edge.fromStop.name}–${edge.toStop.name}`,
    details:scheduled?`${edge.source}: GTFS schedule matched the requested date (ground leg only).`:`${edge.source}: GTFS trip-pattern evidence, not date-specific service.`,
    legs,places,networkEvidence:{kind:scheduled?'gtfs_scheduled':'gtfs_trip_pattern',dateVerified:scheduled,
      groundKey:`${edge.mode}|${edge.fromAirport}|${edge.toAirport}`,toAirport:edge.toAirport,
      source:edge.source,sourceUrl:edge.sourceUrl,
      attribution:edge.attribution||'',validFrom:edge.validFrom,validTo:edge.validTo},
    warnings:[...(base.warnings||[]).filter(x=>!x.startsWith('These flight legs are hypotheses')),
      timetableNote,'Airport/station and airport/port transfers are placeholders; no transfer schedule or connection window verified.',
      'Remaining flight legs are still hypotheses; check service and booking separately.']};
}
function routeSignature(route){return route.legs.map(l=>`${l.mode}|${l.from}|${l.to}|${l.date}`).join('~');}
export function expandRoutesWithGround(plan,flightRoutes,groundEdges,{maxRoutes=5,bufferMinutes=180}={}){
  if(!Array.isArray(flightRoutes)||!flightRoutes.length)return [];
  const candidates=[],seen=new Set(flightRoutes.map(routeSignature));
  const push=(route)=>{const signature=routeSignature(route);if(!seen.has(signature)){seen.add(signature);candidates.push(route);}};
  for(const edge of Array.isArray(groundEdges)?groundEdges:[]){
    if(!modeKind[edge.mode]||!edge.fromStop?.id||!edge.toStop?.id||!edge.fromAirport||!edge.toAirport)continue;
    for(const base of flightRoutes){
      // A GTFS trip pattern can replace an existing flight between the same cities.
      for(let i=0;i<base.legs.length;i++){
        const current=base.legs[i];
        if(current.mode!=='flight'||current.from!==edge.fromAirport||current.to!==edge.toAirport)continue;
        const replacement=groundSegment(edge,current.date);
        if(!replacement)continue;
        push(groundRoute(base,[...base.legs.slice(0,i),...replacement,...base.legs.slice(i+1)],edge,'replace'));
      }
      // Route discovery, not just replacing existing legs: if a published rail,
      // coach or ferry pattern reaches a second city from the trip's origin,
      // search onward flights from that city's airport to the vacation spot.
      const first=base.legs[0];
      if(plan?.max_connections===0 || first?.mode!=='flight'||first?.from!==edge.fromAirport ||
        edge.fromAirport!==plan?.origin || first?.to!==plan?.preferred ||
        [plan.origin,plan.preferred].includes(edge.toAirport))continue;
      const replacement=groundSegment(edge,first.date);
      if(!replacement)continue;
      const viaAirport={id:edge.toAirport,label:edge.toAirport,kind:'airport'};
      const toVacation={id:first.to,label:base.places?.[first.to]||first.to,kind:'airport'};
      const flight=leg(viaAirport,toVacation,'flight',first.date);
      push(groundRoute(base,[...replacement,flight,...base.legs.slice(1)],edge,'via'));
    }
    if(candidates.length>=70)break;
  }
  return chooseDiverseRoutes(flightRoutes,candidates,{maxRoutes,final:plan?.destination,bufferMinutes});
}
