// Trainline/Omio research is a user-reviewed browser workflow, not a rail API.
// A captured search result is indicative until the traveler confirms its fare.
const ISO=/^\d{4}-\d{2}-\d{2}$/;
const EURO=/(?:€\s*(\d{1,5}(?:[., ]\d{3})*(?:[.,]\d{1,2})?)|\bEUR\s*(\d{1,5}(?:[., ]\d{3})*(?:[.,]\d{1,2})?)|(?<![\d:])(\d{1,5}(?:[., ]\d{3})*(?:[.,]\d{1,2})?)\s*€)/gi;
const MAX_PRICE=5000;

function normalizedStation(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ');}
export function trainResearchKey(leg){
  if(leg?.mode!=='train'||!ISO.test(leg.date||''))return null;
  const from=normalizedStation(leg.fromLabel||leg.from),to=normalizedStation(leg.toLabel||leg.to);
  if(!from||!to||from.toLowerCase()===to.toLowerCase())return null;
  return `train|${from.toLocaleLowerCase('en')}|${to.toLocaleLowerCase('en')}|${leg.date}`;
}
export function trainResearchTasks(routes){
  const found=new Map();
  for(const route of Array.isArray(routes)?routes:[]){
    const seen=new Set();
    for(const leg of route.legs||[]){
      const key=trainResearchKey(leg);
      if(!key||seen.has(key))continue;
      seen.add(key);
      if(!found.has(key))found.set(key,{key,leg:{...leg},from:normalizedStation(leg.fromLabel||leg.from),
        to:normalizedStation(leg.toLabel||leg.to),date:leg.date,routeCount:0});
      found.get(key).routeCount++;
    }
  }
  return [...found.values()];
}

// Official Omio affiliate documentation specifies the departurePosTerm,
// arrivalPosTerm and departureDate query parameters for its search-link format.
// The traveler must still verify the resulting site's date, stops and mode.
export function trainSearchUrl(task){
  const leg=task?.leg||task;
  if(!trainResearchKey(leg))throw new Error('Choose a dated train segment.');
  const url=new URL('https://www.omio.com/links/626fa8a9-f982-43d0-ace9-9a13f6b14612');
  url.searchParams.set('departurePosTerm',normalizedStation(leg.fromLabel||leg.from));
  url.searchParams.set('arrivalPosTerm',normalizedStation(leg.toLabel||leg.to));
  url.searchParams.set('departureDate',leg.date);
  url.searchParams.set('travelMode','TRAIN');
  url.searchParams.set('currency','EUR');
  return url.toString();
}

export function parseEuroAmount(value){
  const input=String(value||'').replace(/[\u00a0\u202f]/g,' ').trim().replace(/\s/g,'');
  if(!/^[\d.,]+$/.test(input))return null;
  const comma=input.lastIndexOf(','),dot=input.lastIndexOf('.');
  let normalized=input;
  if(comma>=0&&dot>=0){
    const sep=comma>dot?',':'.';
    normalized=input.replace(new RegExp(`[^\\d${sep==='.'?'\\.':','}]`,'g'),'').replace(sep,'.');
  } else if(comma>=0){
    normalized=/,\d{1,2}$/.test(input)?input.replace(',','.'):input.replaceAll(',','');
  } else if(dot>=0 && !/\.\d{1,2}$/.test(input)){
    normalized=input.replaceAll('.','');
  }
  const n=Number(normalized);
  return Number.isFinite(n)&&n>0&&n<=MAX_PRICE?Math.round(n*100)/100:null;
}
function amounts(text){
  EURO.lastIndex=0;
  const out=[];
  for(const match of text.matchAll(EURO)){
    const n=parseEuroAmount(match[1]||match[2]||match[3]);
    if(n!==null)out.push(n);
  }
  return out;
}
function clock(text){return text.match(/(?:^|\D)([01]\d|2[0-3]):([0-5]\d)(?=\D|$)/)?.slice(1,3).join(':')||'';}
// Omio times use 12-hour AM/PM markup. Normalize them before saving, so
// 5:45 PM never becomes a bogus 05:45 arrival.
function providerClock(value){
  const match=String(value||'').match(/(?:^|\D)(\d{1,2}):([0-5]\d)\s*(AM|PM)?\b/i);
  if(!match)return '';
  let hour=Number(match[1]);
  if(match[3]){
    if(hour<1||hour>12)return '';
    hour=hour%12+(match[3].toUpperCase()==='PM'?12:0);
  }else if(hour>23)return '';
  return `${String(hour).padStart(2,'0')}:${match[2]}`;
}
// Match literal stations, ignoring only spelling accents and punctuation.
// A different station in the same city is *not* interchangeable.
function stationForMatch(value){
  return normalizedStation(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function safeSource(url){
  try{
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||!['www.omio.com','omio.com','www.thetrainline.com','thetrainline.com'].includes(parsed.hostname))return '';
    return parsed.toString().slice(0,2048);
  }catch{return '';}
}
export function parseTrainCapture(capture,task){
  if(!trainResearchKey(task?.leg||task))throw new Error('Not a train search.');
  const sourceUrl=safeSource(capture?.sourceUrl);
  if(!sourceUrl)throw new Error('Import a train result from Omio or Trainline.');
  const options=[],seen=new Set();
  const journeys=Array.isArray(capture?.journeys)?capture.journeys:[];
  let excludedStationMismatch=0;
  if(journeys.length){
    const leg=task?.leg||task;
    const expectedFrom=stationForMatch(leg.fromLabel||leg.from);
    const expectedTo=stationForMatch(leg.toLabel||leg.to);
    for(const journey of journeys.slice(0,120)){
      if(!journey||typeof journey!=='object')continue;
      // Never use a fare for Valencia Joaquin Sorolla to price Valencia Nord.
      if(stationForMatch(journey.fromStation)!==expectedFrom ||
         stationForMatch(journey.toStation)!==expectedTo){
        excludedStationMismatch++;
        continue;
      }
      const fares=amounts(String(journey.priceText||''));
      // Only the explicit card price is trusted; do not read ads or other text.
      if(!fares.length)continue;
      const fareEur=fares[0];
      const departureClock=providerClock(journey.departureText);
      const arrivalClock=providerClock(journey.arrivalText);
      if(!departureClock||!arrivalClock)continue;
      const operator=String(journey.provider||'').slice(0,100);
      const fromStation=String(journey.fromStation||'').slice(0,160);
      const toStation=String(journey.toStation||'').slice(0,160);
      const duration=String(journey.durationText||'').slice(0,60);
      const changes=String(journey.changesText||'').slice(0,80);
      const key=`${operator}|${fareEur}|${departureClock}|${arrivalClock}|${fromStation}|${toStation}`;
      if(seen.has(key))continue;
      seen.add(key);
      options.push({fareEur,departureClock,arrivalClock,operator,fromStation,toStation,
        duration,changes,stationMatch:true,
        snippet:`${operator} · ${departureClock} ${fromStation} → ${arrivalClock} ${toStation} · ${duration} · ${changes} · €${fareEur}`.slice(0,340)});
      if(options.length>=80)break;
    }
  }else{
    const texts=Array.isArray(capture?.cards)?capture.cards:[];
    // Legacy/unstructured snippets are available for manual review but are
    // never considered proof of an exact station match.
    for(const snippet of texts){
      const text=String(snippet||'').slice(0,1700);
      if(text.length<3||!/(€|\bEUR\b)/i.test(text)||/<(?:div|span|section)\b/i.test(text))continue;
      const fares=amounts(text);
      const times=[...text.matchAll(/(?:^|\D)((?:[01]\d|2[0-3]):[0-5]\d)(?=\D|$)/g)].map(m=>m[1]);
      const fareEur=fares.length?Math.min(...fares):null;
      if(fareEur===null)continue;
      const departureClock=times[0]||clock(text),arrivalClock=times[1]||'';
      const key=`${fareEur}|${departureClock}|${arrivalClock}`;
      if(seen.has(key))continue;
      seen.add(key);
      options.push({fareEur,departureClock,arrivalClock,stationMatch:false,snippet:text.slice(0,340)});
      if(options.length>=40)break;
    }
  }
  return {key:trainResearchKey(task.leg||task),sourceUrl,options:options.sort((a,b)=>a.fareEur-b.fareEur),
    journeyCardsSeen:journeys.length,excludedStationMismatch,
    capturedAt:new Date().toISOString(),quoteStatus:'indicative'};
}

// A machine-imported price may be cached *only* when the final page retains
// the precise origin, destination and date of the link RouteWise opened.
// If Omio redirects and drops those fields, require traveler review instead.
export function captureMatchesTrainSearch(capture,task){
  try{
    const expected=new URL(trainSearchUrl(task));
    const actual=new URL(capture?.sourceUrl);
    if(actual.hostname!==expected.hostname||actual.pathname!==expected.pathname)return false;
    return ['departurePosTerm','arrivalPosTerm','departureDate','travelMode'].every(field=>
      actual.searchParams.get(field)===expected.searchParams.get(field));
  }catch{return false;}
}

export function checkedTrainQuote(capture,task,{confirmation=false,optionIndex=0}={}){
  if(!confirmation)throw new Error('Confirm the same train stations, one-way date, currency, passenger and ticket conditions.');
  const parsed=parseTrainCapture(capture,task);
  const option=parsed.options[optionIndex];
  if(!option)throw new Error('No EUR-priced train journey card was captured. Paste or manually record a checked fare instead.');
  return {...parsed,selected:{...option},options:parsed.options};
}

export function indicativeTrainQuote(cache,leg){
  const record=cache?.[trainResearchKey(leg)];
  const item=record?.selected;
  return record?.quoteStatus==='indicative' && Number.isFinite(item?.fareEur)&&item.fareEur>0
    ? {fareEur:item.fareEur,sourceUrl:record.sourceUrl,capturedAt:record.capturedAt,
      departureClock:item.departureClock||'',arrivalClock:item.arrivalClock||''}:null;
}
