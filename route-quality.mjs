import {connectionWindows} from './connection-windows.mjs';
// Quality and diversity of *unpriced candidate patterns*. These heuristics never
// assert that a proposed flight or transfer exists. Verified fares are ranked
// separately by core.rankRoutes after travelers save them.
import {findRoundTripPairs} from './search-links.mjs';

function groundKey(route){return route.networkEvidence?.groundKey||'';}
export function candidateQuality(route,{final=null,bufferMinutes=180}={}){
  const flights=route.legs.filter(l=>l.mode==='flight');
  const transfers=route.legs.filter(l=>l.mode==='transfer');
  const ground=route.legs.filter(l=>['train','bus','ferry'].includes(l.mode));
  const n=route.networkEvidence;
  let points=100 - Math.max(0,flights.length-2)*20 - transfers.length*5 - ground.length*8;
  if(n?.dateVerified)points+=85; // real published train/bus/ferry schedule on date
  else if(n)points+=12; // trip pattern only, no date guarantee
  if(findRoundTripPairs(route.legs).length)points+=20; // ticket search convenience, not a price claim
  if(n?.toAirport && n.toAirport===final)points+=12; // avoid return detours when appropriate
  if(route.legs.length>6)points-=Math.max(0,route.legs.length-6)*10;
  if(connectionWindows(route,{}, {bufferMinutes}).some(w=>w.status==='window_next_day'))points-=110;
  return points;
}
function category(route){
  if(route.networkEvidence)return 'ground';
  if(route.legs.length===2)return 'direct';
  return 'connecting';
}
export function chooseDiverseRoutes(flightRoutes,groundCandidates,{maxRoutes=5,final=null,bufferMinutes=180}={}){
  if(!groundCandidates.length)return flightRoutes.slice(0,maxRoutes);
  const ordered=[...flightRoutes,...groundCandidates]
    .map((route,index)=>({route,index,quality:candidateQuality(route,{final,bufferMinutes})}))
    .sort((a,b)=>b.quality-a.quality || a.index-b.index);
  const result=[],used=new Set(),usedGround=new Set(),counts={direct:0,connecting:0,ground:0};
  const add=entry=>{
    const {route}=entry;
    if(used.has(route.id))return false;
    const group=groundKey(route);
    if(group && usedGround.has(group))return false;
    used.add(route.id);if(group)usedGround.add(group);
    result.push(route);counts[category(route)]++;return true;
  };
  // Preserve the simplest option as a reference, even if a dated rail service
  // scores higher. Present one alternative flight and one ground strategy when
  // available. Don't force five results if no distinct strategies remain.
  if(flightRoutes.length)add({route:flightRoutes[0]});
  if(result.length<maxRoutes){const flight=ordered.find(e=>category(e.route)==='connecting'&&!used.has(e.route.id));if(flight)add(flight);}
  if(result.length<maxRoutes){const ground=ordered.find(e=>category(e.route)==='ground');if(ground)add(ground);}
  while(result.length<maxRoutes){
    const choices=ordered.filter(e=>!used.has(e.route.id)&&!usedGround.has(groundKey(e.route)));
    if(!choices.length)break;
    // Prioritize novelty: avoid filling all remaining slots with variants
    // of the same ground city or the same underlying hypothetical flight.
    choices.sort((a,b)=>
      (b.quality-counts[category(b.route)]*16) -
      (a.quality-counts[category(a.route)]*16) || a.index-b.index);
    if(!add(choices[0]))break;
  }
  return result.slice(0,maxRoutes);
}
