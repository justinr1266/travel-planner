// Google Maps transit research helpers. No fare or schedule is invented here.
// Provider results are intentionally ephemeral: do not persist in chrome.storage.
const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME=/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export function isTransferLeg(leg){ return leg?.mode==='transfer'; }
export function groundResearchKey(leg){return isTransferLeg(leg)?String(leg.key||[leg.from,leg.to,leg.date,'transfer'].join('|')):null;}

export function suggestedTransferTime(route,index){
  const leg=route?.legs?.[index];
  if(!isTransferLeg(leg))return null;
  const prev=route.legs[index-1],next=route.legs[index+1];
  if(next?.evidence==='gtfs_scheduled' && next?.departureLocal && next?.scheduleTimezone){
    return {timeKind:'arrival',localTime:next.departureLocal.replace(' ','T').slice(0,16),timeZone:next.scheduleTimezone,
      note:'Arrive at the train or ferry station before departure; add a boarding margin.'};
  }
  if(prev?.evidence==='gtfs_scheduled' && prev?.arrivalLocal && prev?.scheduleTimezone){
    return {timeKind:'departure',localTime:prev.arrivalLocal.replace(' ','T').slice(0,16),timeZone:prev.scheduleTimezone,
      note:'Departure from the station must allow time to get off the arriving service.'};
  }
  return {timeKind:'departure',localTime:'',timeZone:'',note:'Enter a local date, time, and time zone for this transfer.'};
}

// Convert a wall-clock time in its actual transit location, not the user's
// browser time zone. Reject impossible local times at DST transitions.
export function localTransitTimeToISO(localTime,timeZone){
  const match=String(localTime||'').match(LOCAL_TIME);
  if(!match||!ISO_DATE.test(match[1]))throw new Error('Enter a valid local departure or arrival date and time.');
  const wall=Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  if(!Number.isFinite(wall)||new Date(wall).toISOString().slice(0,16)!==localTime)throw new Error('Invalid date or time.');
  let formatter;
  try{formatter=new Intl.DateTimeFormat('en-GB', {timeZone:String(timeZone||''),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
  catch{throw new Error('Enter the local IANA time zone, e.g. Europe/Madrid.');}
  let candidate=wall;
  for(let i=0;i<4;i++){
    const vals=Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(p=>[p.type,p.value]));
    const formatted=Date.parse(`${vals.year}-${vals.month}-${vals.day}T${vals.hour}:${vals.minute}:00Z`);
    candidate+=wall-formatted;
  }
  const roundTrip=Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(p=>[p.type,p.value]));
  const check=`${roundTrip.year}-${roundTrip.month}-${roundTrip.day}T${roundTrip.hour}:${roundTrip.minute}`;
  if(check!==localTime)throw new Error('That local time does not exist in the chosen time zone (daylight-saving change).');
  return new Date(candidate).toISOString();
}

export function routeTransferQuoteKey(route,leg){return JSON.stringify([String(route?.id||''),String(leg?.key||'')]);}

export function validDatedTransitResult(leg,result){
  return Boolean(isTransferLeg(leg) && result?.dated===true && result.acceptedForComparison===true && result.requestedDate===leg.date &&
    result.fare?.currencyCode==='EUR' && Number.isFinite(result.fare?.amount) && result.fare.amount>=0);
}

export function collectTransferLegs(routes){
  const byKey=new Map();
  for(const route of routes||[]){
    for(let i=0;i<(route.legs||[]).length;i++){
      const leg=route.legs[i],key=groundResearchKey(leg);
      if(!key||byKey.has(key))continue;
      byKey.set(key,{key,leg,route,index:i});
    }
  }
  return [...byKey.values()];
}
