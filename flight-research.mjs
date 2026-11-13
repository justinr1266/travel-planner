// User-initiated flight research. Never reads a website automatically.
// Extracted text is a draft; only explicit user review creates a saved record.
import {normalizedOffer,parseISODate} from './core.mjs';
import {validatedFlightTime} from './connection-windows.mjs';
import {parseGoogleFlightsPage,matchingRoundTripDirection} from './google-flights-text.mjs';
import {parseGoogleFlightsSearchResults} from './google-flights-search.mjs';

const MAX_SELECTION=5000;
const CLOCK=/(?:^|[^\d])((?:[01]?\d|2[0-3]):[0-5]\d)(?:\s*([AP]M))?(?=$|[^\da-z])/gi;

export function captureSelection(text,sourceUrl='',capturedAt=new Date().toISOString()) {
  const selection=String(text??'').trim().slice(0,MAX_SELECTION);
  if(!selection)throw new Error('Highlight flight details before sending them to RouteWise.');
  const url=String(sourceUrl??'').trim();
  let safeUrl='';
  if(url){
    try{const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol))safeUrl=parsed.href;}
    catch{ /* The selection can still be imported without a link. */ }
  }
  return {text:selection,sourceUrl:safeUrl,capturedAt};
}
function toClock(clock,meridiem) {
  let [hour,minutes]=clock.split(':').map(Number);
  if(meridiem){hour=hour%12+(meridiem.toUpperCase()==='PM'?12:0);}
  return `${String(hour).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`;
}
function amount(number) {
  let n=number.replace(/[\s\u00a0]/g,'');
  const comma=n.lastIndexOf(','),dot=n.lastIndexOf('.');
  if(comma>=0&&dot>=0)n=comma>dot?n.replace(/\./g,'').replace(',','.'):n.replace(/,/g,'');
  else if(comma>=0)n=/,\d{1,2}$/.test(n)?n.replace(',','.'):n.replace(/,/g,'');
  else if(dot>=0&&/\.\d{3}$/.test(n))n=n.replace(/\./g,'');
  const value=Number(n);
  return Number.isFinite(value)&&value>=0&&value<=100000?value:null;
}
export function parseFlightSelection(text,{leg=null}={}) {
  const searchResults=parseGoogleFlightsSearchResults(text);
  if(searchResults){
    return {departureClock:'',arrivalClock:'',fareEur:null,carrier:'',flightNumber:'',stops:null,
      warnings:[`${searchResults.options.length} Google Flights search option(s) found. Select a matching flight below.`,
        'Search prices may be round-trip, one-way, or unlabeled. Verify the exact ticket and baggage before saving any fare; use timing-only for this import.'],
      searchResults};
  }
  const roundTrip=parseGoogleFlightsPage(text);
  if(roundTrip){
    const matchedDirection=matchingRoundTripDirection(roundTrip,leg);
    const selected=matchedDirection==='outbound'?roundTrip.outbound:
      matchedDirection==='return'?roundTrip.inbound:null;
    const warnings=[
      matchedDirection?`Matched ${matchedDirection} flight ${selected.from} → ${selected.to}.`:
        'Round-trip page detected. Select a leg with matching airports and date before importing times.',
      'Prices shown are for the complete round-trip ticket. No amount will be saved as an individual leg fare.'
    ];
    if(roundTrip.baggageSellerUnknown)warnings.push('Carry-on coverage for some booking sellers must be checked separately.');
    return {
      departureClock:selected?.departureClock||'',arrivalClock:selected?.arrivalClock||'',
      fareEur:null,carrier:selected?.carrier||'',flightNumber:selected?.flightNumbers.join(' / ')||'',
      stops:selected?.stops??null,warnings,roundTrip,matchedDirection
    };
  }
  const input=String(text??'').slice(0,MAX_SELECTION);
  const clocks=[...input.matchAll(CLOCK)].map(match=>toClock(match[1],match[2]));
  const distinctClocks=[...new Set(clocks)];
  const eur=[];
  const euroPattern=/(?:€\s*([\d][\d\s.,]*\d|\d)|(?<![:\d])([\d][\d\s.,]*\d|\d)\s*(?:€|EUR\b))/gi;
  for(const match of input.matchAll(euroPattern)){
    const value=amount(match[1]||match[2]);
    if(value!==null)eur.push(value);
  }
  const uniqueEur=[...new Set(eur)];
  const nonEur=/(?:\$|\bUSD\b|£|\bGBP\b|\bCHF\b|\bSEK\b)/i.test(input);
  const warnings=[];
  if(clocks.length>2 || distinctClocks.length>2)warnings.push('Multiple times found. Enter the exact departure time manually.');
  if(uniqueEur.length>1)warnings.push('Multiple EUR prices found. Select the correct fare yourself.');
  if(nonEur)warnings.push('Non-EUR currency detected. Enter the EUR amount yourself; RouteWise does not convert currencies.');
  return {
    departureClock:clocks.length===2?clocks[0]:'',
    arrivalClock:clocks.length===2?clocks[1]:'',
    fareEur:uniqueEur.length===1&&!nonEur?uniqueEur[0]:null,
    warnings
  };
}
function validClock(value,label){
  const clock=String(value??'').trim();
  if(clock&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock))throw new Error(`${label} must be HH:MM.`);
  return clock;
}
export function buildReviewedFlight(input,leg,{checkedAt=new Date().toISOString()}={}){
  if(leg?.mode!=='flight'||typeof leg.key!=='string')throw new Error('Choose an existing flight leg before importing.');
  parseISODate(leg.date);
  if(input.confirmed!==true)throw new Error('Confirm the departure airport, arrival airport, date, and chosen flight.');
  const mode=input.mode;
  if(!['timing','fare'].includes(mode))throw new Error('Choose timing or fare review.');
  const departureClock=validClock(input.departureClock,'Departure time');
  const arrivalClock=validClock(input.arrivalClock,'Arrival time');
  const arrivalDayOffset=Number(input.arrivalDayOffset??0);
  if(!Number.isInteger(arrivalDayOffset)||arrivalDayOffset<0||arrivalDayOffset>2)throw new Error('Arrival day must be same day, next day, or two days later.');
  const departureTimezone=String(input.departureTimezone??'').trim();
  if(departureClock&&!departureTimezone&&mode==='timing')throw new Error('Enter the departure airport time zone for the timing check.');
  if(mode==='timing'&&!departureClock)throw new Error('Enter a departure time before saving timing.');
  let flightTime=null;
  if(departureClock&&departureTimezone)flightTime=validatedFlightTime({departureClock,departureTimezone});
  const carrier=String(input.carrier??'').trim().slice(0,90);
  const flightNumber=String(input.flightNumber??'').trim().slice(0,35);
  const stops=String(input.stops??'').trim();
  if(stops&&!/^(?:0|[1-9]\d?)$/.test(stops))throw new Error('Stops must be a whole number from 0 to 99.');
  const sourceUrl=String(input.sourceUrl??'').trim();
  if(sourceUrl){
    const url=new URL(sourceUrl);
    if(!['http:','https:'].includes(url.protocol))throw new Error('Use an http(s) source URL.');
  }
  const research={
    reviewedAt:checkedAt,legKey:leg.key,from:leg.from,to:leg.to,date:leg.date,
    carrier,flightNumber,stops:stops===''?null:Number(stops),
    departureClock,arrivalClock,arrivalDayOffset,departureTimezone,sourceUrl,
    reviewedByUser:true,bagStatus:'unknown'
  };
  if(mode==='timing')return {research,flightTime,offer:null};
  const isGoogleFlightsCapture=Boolean(parseGoogleFlightsPage(input.rawSelectionText)||parseGoogleFlightsSearchResults(input.rawSelectionText));
  if(isGoogleFlightsCapture && input.oneWayFareVerified!==true){
    throw new Error('A Google Flights search quote or round-trip price is not automatically a checked one-way fare. Enter the independently verified one-way EUR price and tick the one-way fare confirmation before saving.');
  }
  if(isGoogleFlightsCapture && !String(input.fareEur??'').trim()){
    throw new Error('Enter the verified one-way EUR amount; the captured Google Flights quote was not copied into the fare field.');
  }
  research.priceVerification=isGoogleFlightsCapture?'independently_user_checked_one_way':'user_checked_one_way';
  const bagStatus=String(input.bagStatus??'unknown');
  if(!['included','extra'].includes(bagStatus))throw new Error('Verify the overhead carry-on allowance or its extra fee before saving a priced option.');
  research.bagStatus=bagStatus;
  const bagFee=bagStatus==='included'?0:input.bagFee;
  const note=[carrier,flightNumber,stops!==''?`${stops} stop(s)`:null,
    arrivalClock?`Arrives ${arrivalClock} local${arrivalDayOffset?` (+${arrivalDayOffset} day${arrivalDayOffset===1?'':'s'})`:''}`:null,
    bagStatus==='included'?'Overhead bag included':'Overhead bag fee checked',
    String(input.notes??'').trim()].filter(Boolean).join(' · ').slice(0,500);
  const offer=normalizedOffer({
    fare:input.fareEur,bagFee,transferCost:input.transferCost??0,
    source:sourceUrl,note,departureClock:flightTime?.departureClock||'',departureTimezone:flightTime?.departureTimezone||''
  });
  return {research,flightTime,offer};
}
