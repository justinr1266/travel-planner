// User-pasted Google Flights *search-result* cards (plain copied text or card HTML).
// This is deterministic, offline parsing; it does not request or scrape any website.
// Search-result prices may be round-trip, one-way, or unstated. NEVER save
// a search-result quote as a checked individual-leg fare without review.

const MAX_INPUT=250000;
const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const WEEKDAYS=['sun','mon','tue','wed','thu','fri','sat'];
const AIRPORT=/^[A-Z]{3}$/;
const TIME='(\\d{1,2}:[0-5]\\d\\s*[AP]M)';

function clock24(value) {
  const match=String(value).match(/^(\d{1,2}):([0-5]\d)\s*([AP]M)$/i);
  if(!match || +match[1]>12 || +match[1]<1)return '';
  const hour=+match[1]%12+(match[3].toUpperCase()==='PM'?12:0);
  return `${String(hour).padStart(2,'0')}:${match[2]}`;
}
function moneyValue(value) {
  const amount=Number(String(value).replace(/[\s,\u00a0]/g,''));
  return Number.isFinite(amount)&&amount>=0&&amount<=100000?amount:null;
}
function monthDay(label){
  const match=String(label).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})\b/i);
  if(!match)return null;
  const month=MONTHS.indexOf(match[1].toLowerCase().slice(0,3))+1,day=+match[2];
  if(!month||day<1||day>31)return null;
  return `${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function datePart(input){
  const match=String(input).match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if(!match)return null;
  const date=match[0];
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date?date:null;
}
function weekdayLabel(label){
  const match=String(label).match(/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/i);
  return match?match[1].toLowerCase().slice(0,3):null;
}
function decodeEntities(value){
  return String(value).replace(/&(?:amp|quot|apos|lt|gt|nbsp|#39|#x27|#34);/gi,ent=>({
    '&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' ','&#39;':"'",'&#x27;':"'",'&#34;':'"'
  }[ent.toLowerCase()]||ent));
}
function tagAttr(tag,name){
  const rx=new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i');
  const found=tag.match(rx);
  return found?decodeEntities(found[1]??found[2]):'';
}
function cardLabel(html){
  for(const tag of html.match(/<[^<>]{1,5000}>/g)||[]){
    if(tagAttr(tag,'role')==='link'&&/^From\s+\d+/i.test(tagAttr(tag,'aria-label')))return tagAttr(tag,'aria-label');
  }
  return '';
}
function htmlIata(html){
  // Explicit endpoints from the user-invoked RouteWise card capture. These
  // outrank emissions metadata, which can describe an individual connection.
  const opening=html.match(/<li\b[^>]{0,1500}>/i)?.[0]||'';
  const from=tagAttr(opening,'data-routewise-from').toUpperCase();
  const to=tagAttr(opening,'data-routewise-to').toUpperCase();
  if(AIRPORT.test(from)&&AIRPORT.test(to)){
    return {from,to,dateISO:datePart(tagAttr(opening,'data-routewise-date'))};
  }
  // First preference: the emissions itinerary identifier provides both IATA
  // endpoints and a full date. It is metadata, NOT evidence of availability.
  const lookup=html.match(/(?:itinerary=|itinerary%3D)([A-Z]{3})-([A-Z]{3})-[A-Z0-9-]+-(20\d{6})(?:[&"'%]|$)/i);
  if(lookup){
    const iso=`${lookup[3].slice(0,4)}-${lookup[3].slice(4,6)}-${lookup[3].slice(6)}`;
    return {from:lookup[1].toUpperCase(),to:lookup[2].toUpperCase(),dateISO:datePart(iso)};
  }
  // Fallback: visible endpoint codes, not Google-specific CSS class names.
  const codes=[...html.matchAll(/<(?:div|span)\b[^>]*>\s*([A-Z]{3})\s*<\/(?:div|span)>/gi)]
    .map(match=>match[1].toUpperCase()).filter(code=>AIRPORT.test(code));
  return {from:codes[0]||'',to:codes[1]||'',dateISO:null};
}
function parseCapturedCard(html){
  // Normalized, user-triggered snapshots from the on-page overlay. These
  // explicit attributes are more stable than Google Flights CSS selectors or
  // assumptions about whether Google labels an amount "round trip".
  const opening=html.match(/<li\b[^>]{0,4000}>/i)?.[0]||'';
  const from=tagAttr(opening,'data-routewise-from').toUpperCase();
  const to=tagAttr(opening,'data-routewise-to').toUpperCase();
  const departureClock=tagAttr(opening,'data-routewise-departure');
  const arrivalClock=tagAttr(opening,'data-routewise-arrival');
  const carrier=tagAttr(opening,'data-routewise-carrier').trim();
  if(!AIRPORT.test(from)||!AIRPORT.test(to)||from===to||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(departureClock)||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(arrivalClock)||!carrier)return null;
  const dateISO=datePart(tagAttr(opening,'data-routewise-date'));
  const dateLabel=tagAttr(opening,'data-routewise-date-label');
  const md=dateISO?.slice(5)||monthDay(dateLabel);
  if(!md)return null;
  const stops=Number(tagAttr(opening,'data-routewise-stops'));
  const arrivalDayOffset=Number(tagAttr(opening,'data-routewise-arrival-offset')||'0');
  if(!Number.isInteger(stops)||stops<0||stops>10||
    !Number.isInteger(arrivalDayOffset)||arrivalDayOffset<0||arrivalDayOffset>2)return null;
  const quoted=tagAttr(opening,'data-routewise-price');
  const displayedPriceEur=quoted?moneyValue(quoted):null;
  const scope=tagAttr(opening,'data-routewise-price-scope');
  const priceScope=['round_trip_search_quote','one_way_search_quote','displayed_search_quote'].includes(scope)?scope:'displayed_search_quote';
  return {from,to,dateISO,dateLabel,monthDay:md,weekday:weekdayLabel(dateLabel),
    departureClock,arrivalClock,arrivalDayOffset,carrier,
    operatedBy:tagAttr(opening,'data-routewise-operator'),stops,via:[],duration:tagAttr(opening,'data-routewise-duration'),
    displayedPriceEur,
    quotedRoundTripEur:priceScope==='round_trip_search_quote'?displayedPriceEur:null,
    quotedOneWayEur:priceScope==='one_way_search_quote'?displayedPriceEur:null,
    priceScope,sourceFormat:'html'};
}
function parseHtmlCard(html){
  const label=cardLabel(html);
  if(!label)return null;
  const quoted=label.match(/^From\s+([\d,]+)\s+euros?\b/i);
  const route=label.match(/Leaves\s+(.+?)\s+at\s+(\d{1,2}:[0-5]\d\s*[AP]M)\s+on\s+((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Za-z]+\s+\d{1,2})\s+and arrives at\s+(.+?)\s+at\s+(\d{1,2}:[0-5]\d\s*[AP]M)\s+on\s+((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Za-z]+\s+\d{1,2})/i);
  if(!route)return null;
  const identifiers=htmlIata(html);
  if(!identifiers.from||!identifiers.to)return null;
  const departureClock=clock24(route[2]),arrivalClock=clock24(route[5]);
  if(!departureClock||!arrivalClock)return null;
  const nonstop=/\bNonstop flight\b/i.test(label);
  const stops=nonstop?0:Number(label.match(/\b(\d+)\s+stops?\s+flight\b/i)?.[1]??NaN);
  if(!Number.isInteger(stops)||stops<0||stops>10)return null;
  const marketing=label.match(/\b(?:Nonstop|\d+\s+stops?)\s+flight with\s+(.+?)\.\s+(?:Operated by\s+.+?\.\s+)?Leaves\b/i);
  const operating=label.match(/Operated by\s+(.+?)\.\s+Leaves\b/i);
  const carrier=marketing?.[1]?.trim()||'';
  if(!carrier)return null;
  const depMonthDay=monthDay(route[3]),arrMonthDay=monthDay(route[6]);
  if(!depMonthDay||!arrMonthDay)return null;
  if(identifiers.dateISO && identifiers.dateISO.slice(5)!==depMonthDay)return null;
  const arrivalDayOffset=depMonthDay===arrMonthDay?0:1;
  const priceScope=/\bround trip\b/i.test(label)?'round_trip_search_quote':
    /\bone way\b/i.test(label)?'one_way_search_quote':'displayed_search_quote';
  const displayedPriceEur=quoted?moneyValue(quoted[1]):null;
  return {from:identifiers.from,to:identifiers.to,dateISO:identifiers.dateISO,
    dateLabel:route[3],monthDay:depMonthDay,weekday:weekdayLabel(route[3]),
    departureClock,arrivalClock,arrivalDayOffset,
    carrier,operatedBy:operating?.[1]?.trim()||'',
    stops,via:[],duration:label.match(/Total duration\s+(.+?)\./i)?.[1]||'',
    displayedPriceEur,quotedRoundTripEur:priceScope==='round_trip_search_quote'?displayedPriceEur:null,
    quotedOneWayEur:priceScope==='one_way_search_quote'?displayedPriceEur:null,priceScope,
    sourceFormat:'html'};
}
function htmlResults(input){
  if(!/<li\b/i.test(input))return null;
  const cards=[...input.matchAll(/<li\b[\s\S]*?<\/li>/gi)];
  if(!cards.length)return null;
  const options=cards.slice(0,80).map(card=>parseCapturedCard(card[0])||parseHtmlCard(card[0])).filter(Boolean);
  return options.length?{type:'google_flights_search_results',sourceFormat:'html',options}:null;
}
function plainTextResults(input){
  if(!/\bTop (?:departing )?flights\b/i.test(input))return null;
  const start=input.search(/\bTop (?:departing )?flights\b/i);
  const end=input.slice(start).search(/\nView more flights\b|\nAbout\n/i);
  const area=input.slice(start,end>=0?start+end:undefined);
  const dateISO=datePart(input.match(/departing\s+20\d\d-\d\d-\d\d/i)?.[0]||'');
  const dateLabel=input.match(/\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),?\s+[A-Za-z]{3}\s+\d{1,2}\b/)?.[0]||'';
  const weekday=weekdayLabel(dateLabel),md=dateISO?.slice(5)||monthDay(dateLabel);
  const timeBlock=new RegExp(`(?:^|\\n)\\s*${TIME}\\s*[–—-]\\s*\\n\\s*${TIME}(\\+\\d+)?\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\d{1,2}:[0-5]\\d\\s*[AP]M\\s*[–—-]|$)`,'gi');
  const options=[];
  for(const match of area.matchAll(timeBlock)){
    const body=match[4];
    const route=body.match(/\b([A-Z]{3})\s*[–—-]\s*([A-Z]{3})\b/);
    const fare=body.match(/€\s*([\d,]+)(\s*\n\s*round trip\b)?/i);
    if(!route||!fare)continue;
    const fields=body.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    const durationIndex=fields.findIndex(x=>/^(?:\d+\s*hr(?:\s*\d+\s*min)?|\d+\s*min)$/.test(x));
    const names=durationIndex>=0?fields.slice(0,durationIndex):fields.slice(0,1);
    const carrierRaw=names.join(' ').trim();
    const [carrier,operatedBy='']=carrierRaw.split(/Operated by/i).map(x=>x.trim());
    const nonstop=/\bNonstop\b/i.test(body);
    const count=body.match(/\b(\d+)\s+stops?\b/i);
    const stops=nonstop?0:count?+count[1]:null;
    if(stops===null||stops>10||!carrier)continue;
    const via=[];
    if(stops>0){
      const afterStop=body.split(/\b\d+\s+stops?\b/i)[1]||'';
      const viaMatch=afterStop.match(/\b(?:\d+\s*hr(?:\s*\d+\s*min)?|\d+\s*min)\s+([A-Z]{3})\b/i);
      if(viaMatch)via.push(viaMatch[1].toUpperCase());
    }
    const departureClock=clock24(match[1]),arrivalClock=clock24(match[2]);
    if(!departureClock||!arrivalClock)continue;
    const priceScope=fare[2]?'round_trip_search_quote':/\bone way\b/i.test(body)?'one_way_search_quote':'displayed_search_quote';
    const displayedPriceEur=moneyValue(fare[1]);
    options.push({from:route[1],to:route[2],dateISO,dateLabel,monthDay:md,weekday,
      departureClock,arrivalClock,arrivalDayOffset:match[3]?+match[3].slice(1):0,
      carrier,operatedBy,stops,via,duration:durationIndex>=0?fields[durationIndex]:'',
      displayedPriceEur,quotedRoundTripEur:priceScope==='round_trip_search_quote'?displayedPriceEur:null,
      quotedOneWayEur:priceScope==='one_way_search_quote'?displayedPriceEur:null,priceScope,
      sourceFormat:'text'});
  }
  return options.length?{type:'google_flights_search_results',sourceFormat:'text',options}:null;
}
export function parseGoogleFlightsSearchResults(raw){
  const input=String(raw??'').slice(0,MAX_INPUT);
  return htmlResults(input)||plainTextResults(input);
}
export function searchOptionMatchesLeg(option,leg){
  if(!option||!leg||leg.mode!=='flight'||option.from!==leg.from||option.to!==leg.to)return false;
  const date=String(leg.date??'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  if(option.dateISO)return option.dateISO===date;
  if(!option.monthDay||option.monthDay!==date.slice(5))return false;
  if(option.weekday&&WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!==option.weekday)return false;
  return true;
}

// Cross-check a no-results signal from the page script before excluding routes.
// The tfs token includes the airports/date; the currency must remain EUR.
export function sameExactGoogleFlightsSearch(actualUrl,expectedUrl){
  try {
    const actual=new URL(actualUrl),expected=new URL(expectedUrl);
    const token=expected.searchParams.get('tfs');
    return actual.origin==='https://www.google.com' && expected.origin===actual.origin &&
      actual.pathname==='/travel/flights/search' && expected.pathname===actual.pathname &&
      !!token && actual.searchParams.get('tfs')===token &&
      actual.searchParams.get('curr')==='EUR' && expected.searchParams.get('curr')==='EUR';
  }catch{return false;}
}
