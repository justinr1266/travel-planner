// Structured, user-pasted Google Flights "Selected flights" page text.
// This is NOT live DOM extraction. Nothing here fetches or accesses a website.

function euroValue(raw) {
  const number = String(raw).replace(/[\s\u00a0]/g, '').replace(/,/g, '');
  const result = Number(number);
  return Number.isFinite(result) && result >= 0 && result <= 100000 ? result : null;
}
function clock24(hours, minutes, ampm) {
  const hour = Number(hours) % 12 + (/^pm$/i.test(ampm) ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${minutes}`;
}
function monthDay(header) {
  const match = String(header).match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i);
  if (!match) return null;
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month = months.indexOf(match[1].slice(0,3).toLowerCase()) + 1;
  const day = Number(match[2]);
  if (!month || day < 1 || day > 31) return null;
  return `${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
function parseDirection(block) {
  const lines = String(block).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const events = [];
  for (let i=0;i<lines.length;i++) {
    // Google Flights copy frequently joins "AM" with the following airport:
    // "7:00 AMAdolfo Suárez Madrid-Barajas Airport (MAD)".
    const m = lines[i].match(/^(\d{1,2}):([0-5]\d)\s*(AM|PM)\s*(.*?)\(([A-Z]{3})\)\s*$/i);
    if (m) events.push({clock:clock24(m[1],m[2],m[3]), airport:m[5].toUpperCase(),index:i});
  }
  if (events.length < 2 || events.length % 2 !== 0) return null;
  const segments = [];
  for (let i=0;i<events.length;i+=2) {
    const from=events[i],to=events[i+1];
    const information=lines.slice(to.index+1, events[i+2]?.index ?? lines.length);
    const carrier=information.find(line => /^[\p{L}][\p{L} &'’.\-]{2,90}$/u.test(line) &&
      !/^(economy|premium economy|business|first|average legroom|below average legroom|avg emissions|travel time|stream media|in-seat power|contrail warming potential|plane and crew|emissions estimate|low|high|medium)$/i.test(line)) || '';
    const numberLine=information.find(line => /(?:^|[^a-z])([A-Z]{2})\s*\d{2,4}\b/.test(line));
    const number=numberLine?.match(/(?:^|[^a-z])([A-Z]{2})\s*(\d{2,4})\b/) || null;
    segments.push({from:from.airport,to:to.airport,departureClock:from.clock,arrivalClock:to.clock,
      carrier,flightNumber:number?`${number[1]} ${number[2]}`:''});
  }
  const connected=segments.every((segment,index)=>index===0 || segments[index-1].to===segment.from);
  if (!connected) return null;
  const via=segments.slice(0,-1).map(segment=>segment.to);
  const weekday=lines[0]?.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/i)?.[1]||null;
  return {dateLabel:lines[0]||'',monthDay:monthDay(lines[0]),weekday:weekday?weekday.toLowerCase():null,
    from:segments[0].from,to:segments.at(-1).to,
    departureClock:segments[0].departureClock,arrivalClock:segments.at(-1).arrivalClock,
    stops:segments.length-1,via,carrier:segments.find(segment=>segment.carrier)?.carrier||'',
    flightNumbers:segments.map(segment=>segment.flightNumber).filter(Boolean),segments};
}
export function parseGoogleFlightsPage(text) {
  const input=String(text??'').slice(0,24000);
  const outboundStart=input.search(/(?:^|\n)Departing flight\s*\n/i);
  const returnStart=input.search(/(?:^|\n)Returning flight\s*\n/i);
  if (outboundStart<0 || returnStart<=outboundStart) return null;
  const bookingStart=input.search(/(?:^|\n)Booking options\s*\n/i);
  const outbound=parseDirection(input.slice(outboundStart,returnStart).replace(/^\s*Departing flight\s*\n/i,''));
  const inbound=parseDirection(input.slice(returnStart,bookingStart>returnStart?bookingStart:undefined).replace(/^\s*Returning flight\s*\n/i,''));
  if(!outbound || !inbound || outbound.from!==inbound.to || outbound.to!==inbound.from) return null;
  const intro=input.slice(0,outboundStart);
  const lowestMatch=intro.match(/€\s*([\d,.]+)\s*\n\s*Lowest total price\b/i);
  const lowestTotalEur=lowestMatch?euroValue(lowestMatch[1]):null;
  const bookingText=bookingStart>=0?input.slice(bookingStart):'';
  const bookingOptions=[];
  const bookingRegex=/^Book with ([^\r\n]+)\r?\n\s*€\s*([\d,.]+)/gmi;
  for(const match of bookingText.matchAll(bookingRegex)) {
    const euro=euroValue(match[2]);
    if(euro===null)continue;
    const seller=match[1].replace(/Airline$/,'').trim();
    if(seller)bookingOptions.push({seller,fareEur:euro});
  }
  const bagNote=input.match(/\b\d+\s+free carry-on(?![a-z])/)?.[0]||'';
  return {type:'google_flights_round_trip',outbound,inbound,lowestTotalEur,
    bookingOptions:bookingOptions.slice(0,15),carryOnNote:bagNote,
    baggageSellerUnknown:/Bag fee info isn't available when booking with/i.test(input)};
}
export function matchingRoundTripDirection(roundTrip,leg) {
  if(!roundTrip || !leg || leg.mode!=='flight')return null;
  for(const [key,direction] of [['outbound',roundTrip.outbound],['return',roundTrip.inbound]]) {
    const date=String(leg.date??'');
    if(direction.from===leg.from && direction.to===leg.to &&
       /^\d{4}-\d\d-\d\d$/.test(date) && date.slice(5)===direction.monthDay){
      const weekday=['sun','mon','tue','wed','thu','fri','sat'][new Date(`${date}T00:00:00Z`).getUTCDay()];
      if(!direction.weekday || direction.weekday===weekday)return key;
    }
  }
  return null;
}
