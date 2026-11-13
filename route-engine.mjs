// Generic, data-driven candidate itineraries. NOT a timetable or live-fare search.
// The LLM suggests places, airport directory validates those places, this module
// builds the same simple itinerary patterns for any region/country.
import { legKey, parseISODate } from './core.mjs';
import { LOCATION_RECORDS, resolveLocation, resolveSuggestedDestination } from './location-resolver.mjs';

const DAY=86400000;
function addDays(iso,number) {const d=parseISODate(iso);d.setUTCDate(d.getUTCDate()+number);return d.toISOString().slice(0,10);}
function daysBetween(a,b) {return Math.round((parseISODate(b)-parseISODate(a))/DAY);}

function itineraryDates(nodes,start,end,primary,goal) {
  const n=nodes.length-1,days=daysBetween(start,end);
  if(days<1)return null;
  const focus=nodes.indexOf(primary);
  if(goal==='more_time_at_preferred' && focus>0 && focus<n)
    return Array.from({length:n},(_,i)=>i<focus?start:end);
  return Array.from({length:n},(_,i)=>addDays(start,n===1?0:Math.round(days*i/(n-1))));
}
export function potentialPrimaryStay(nodes,dates,primary) {
  const index=nodes.indexOf(primary);
  if(!primary || index<1 || index>=nodes.length-1)return null;
  return {destination:primary,arrivalDate:dates[index-1],departureDate:dates[index],
    possibleNights:daysBetween(dates[index-1],dates[index]),verified:false};
}

export function generatePlannedRoutes(plan,{maxRoutes=5,destinationCandidates=[],connectionCandidates=null,records=LOCATION_RECORDS}={}) {
  if (!plan?.origin || !plan?.destination) throw new Error('Specify an origin and final destination.');
  if(!Number.isInteger(maxRoutes)||maxRoutes<1||maxRoutes>20)throw new Error('Invalid route limit.');
  const origin=resolveLocation(plan.origin,{records})?.code;
  const final=resolveLocation(plan.destination,{records})?.code;
  if(!origin || !final)throw new Error('Origin or final destination not in airport directory. Run npm run sync:airports or review location.');
  if(!plan.depart_earliest||!plan.depart_latest||!plan.arrive_latest)
    throw new Error('Specify a departure window and final arrival date.');
  if(plan.fixed_arrival && plan.arrive_earliest && plan.arrive_earliest!==plan.arrive_latest)
    throw new Error('Fixed arrival must have a single exact date.');
  if(daysBetween(plan.depart_earliest,plan.depart_latest)<0)throw new Error('Departure window is reversed.');
  if(daysBetween(plan.depart_earliest,plan.arrive_latest)<1)throw new Error('Final arrival must be later than departure.');
  const preferred=plan.preferred ? resolveLocation(plan.preferred,{records})?.code : null;
  if(plan.preferred && !preferred)throw new Error('Primary destination was not found in the airport directory.');
  // For region/open discovery, each validated candidate becomes the primary
  // destination. Apply the minimum nights to its computed stay, not to a
  // pre-selected location that does not exist yet.
  if(plan.min_nights_at_preferred != null && !preferred && plan.destination_search === 'specified')
    throw new Error('Minimum nights at primary destination requires a specific preferred destination.');
  if(preferred && [origin,final].includes(preferred))throw new Error('Primary destination must differ from trip endpoints.');
  // One route builder for every geography: a direct search pattern plus optional
  // connection proposals. Groq suggests hubs, the directory checks their codes,
  // and the same path constructor handles Barcelona, Sweden, or anywhere else.
  // These are airport PATH HYPOTHESES, not claims of operating flight service.
  const suggestions=[];
  if(preferred) {
    const name=resolveLocation(preferred,{records}).city;
    suggestions.push({code:preferred,name,outboundVia:[],inboundVia:[],source:'direct'});
    // Explicit optional intermediate stops from the traveler retain priority.
    // An outbound hub may equal the final city (BCN -> MAD -> SPC -> MAD).
    if(plan.max_connections!==0) for(const altName of plan.alternate_stops || []) {
      const alt=resolveLocation(altName,{records})?.code;
      if(alt && ![origin,preferred].includes(alt))
        suggestions.push({code:preferred,name,outboundVia:[alt],inboundVia:[],source:'traveler'});
    }
    if(plan.max_connections!==0 && connectionCandidates) {
      // Only one proposed connection per direction until real schedules exist.
      // 'Max connections' is interpreted PER JOURNEY, not across the vacation.
      function checkedHubs(items,excluded) {
        const result=[],seen=new Set();
        for(const item of Array.isArray(items) ? items : []) {
          const code=(typeof item==='string' ? resolveLocation(item,{records}) :
            resolveSuggestedDestination(item,{records}))?.code;
          if(!code || resolveLocation(code,{records})?.kind==='metro' || excluded.includes(code) || seen.has(code)) continue;
          seen.add(code); result.push(code);
          if(result.length===4) break;
        }
        return result;
      }
      const outbound=checkedHubs(connectionCandidates.outbound,[origin,preferred]);
      const inbound=checkedHubs(connectionCandidates.inbound,[preferred,final]);
      // Present the most useful variety FIRST: direct, outbound via, return
      // via, both via, then alternate hubs. Deduplication below handles overlap.
      if(outbound[0]) suggestions.push({code:preferred,name,outboundVia:[outbound[0]],inboundVia:[],source:'ai'});
      if(inbound[0]) suggestions.push({code:preferred,name,outboundVia:[],inboundVia:[inbound[0]],source:'ai'});
      if(outbound[0] && inbound[0]) suggestions.push({code:preferred,name,outboundVia:[outbound[0]],inboundVia:[inbound[0]],source:'ai'});
      for(let i=1;i<Math.max(outbound.length,inbound.length);i++) {
        if(outbound[i]) suggestions.push({code:preferred,name,outboundVia:[outbound[i]],inboundVia:[],source:'ai'});
        if(inbound[i]) suggestions.push({code:preferred,name,outboundVia:[],inboundVia:[inbound[i]],source:'ai'});
      }
    }
  } else {
    for(const item of destinationCandidates) {
      const found=resolveSuggestedDestination(item,{region:(plan.requested_regions||[])[0]||'',records});
      if(!found||[origin,final].includes(found.code)) continue;
      suggestions.push({code:found.code,name:found.city,outboundVia:[],inboundVia:[],source:'discovery'});
    }
  }
  const goal=['lowest_cost','fastest','balance'].includes(plan.priority) ? plan.priority : 'more_time_at_preferred';
  const departureDays=daysBetween(plan.depart_earliest,plan.depart_latest)+1;
  const routes=[],seen=new Set();
  for(const item of suggestions) {
    if(routes.length>=maxRoutes)break;
    const nodes=[origin,...item.outboundVia,item.code,...item.inboundVia,final];
    if(nodes.some((code,i)=>i>0 && code===nodes[i-1]))continue;
    const signature=nodes.join('|');if(seen.has(signature))continue;
    const departure=goal==='more_time_at_preferred' ? plan.depart_earliest : addDays(plan.depart_earliest,routes.length%departureDays);
    const dates=itineraryDates(nodes,departure,plan.arrive_latest,item.code,goal);
    if(!dates)continue;
    const stay=potentialPrimaryStay(nodes,dates,item.code);
    if(plan.min_nights_at_preferred!=null && stay.possibleNights<plan.min_nights_at_preferred)continue;
    const legs=nodes.slice(1).map((to,index)=>{
      const leg={from:nodes[index],to,date:dates[index],mode:'flight'};
      leg.key=legKey(leg);return leg;
    });
    const warnings=['These flight legs are hypotheses, not verified flight services or prices. Train and ferry alternatives require a transport data source.'];
    if(item.outboundVia.length || item.inboundVia.length)
      warnings.push('Connection airports are suggestions only; check flight availability, layover length, terminal changes and booking protection.');
    if(legs.slice(1).some((leg,i)=>leg.date===legs[i].date))warnings.push('Same-day connections need timetable, minimum transfer time and missed-connection checks.');
    warnings.push('Primary-destination nights are optimistic date-only estimates, not verified arrival/departure times.');
    const cities=Object.fromEntries(nodes.map(code=>[code,resolveLocation(code,{records})?.city||code]));
    routes.push({
      id:`generic-${routes.length+1}-${item.code.toLowerCase()}`,
      name:`Visit ${item.name}` + (item.outboundVia.length?` · outbound via ${cities[item.outboundVia[0]]}`:'') +
        (item.inboundVia.length?` · return via ${cities[item.inboundVia[0]]}`:''),
      details:item.source==='ai' ? 'AI-proposed connection airport(s). Flight service and connections unverified.' :
        item.source==='traveler' ? 'Traveler-specified intermediate stop. Connections unverified.' :
        'Location-aware candidate only. Travel inventory and availability unverified.',
      legs,places:cities,primaryStay:stay,warnings,objective:goal,
      arrivalRule:plan.fixed_arrival?'fixed':'by'
    });
    seen.add(signature);
  }
  if (!routes.length && !preferred && suggestions.length && plan.min_nights_at_preferred != null)
    throw new Error(`No candidate destinations allow at least ${plan.min_nights_at_preferred} tentative nights within these dates.`);
  if(!routes.length)throw new Error(preferred
    ? 'No route candidates fit the preferred destination and stay constraints.'
    : 'No validated destination candidates were supplied. Ask Groq for destinations and sync the worldwide airport directory if needed.');
  return routes;
}
