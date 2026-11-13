// Ground-to-flight connection windows, based on published GTFS ground times
// and optionally user-saved flight departure times. No live flight inventory.
// Wall-clock arithmetic is only compared when both times share an IANA zone.

export const DEFAULT_CONNECTION_BUFFER_MINUTES = 180;

// Departure times can be recorded without buying or pricing a ticket.
// A saved fare time is used only when no standalone time has been entered.
export function validatedFlightTime({departureClock='',departureTimezone=''}={}) {
  const clock=String(departureClock??'').trim();
  const zone=String(departureTimezone??'').trim();
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock))
    throw new Error('Enter a departure time in HH:MM (24-hour) format.');
  if(!zone || zone.length>80)throw new Error('Enter the departure airport time zone (e.g. Europe/Madrid).');
  try { new Intl.DateTimeFormat('en-US',{timeZone:zone}); }
  catch { throw new Error('Enter a valid IANA time zone, such as Europe/Madrid.'); }
  return {departureClock:clock,departureTimezone:zone};
}


// Optional ground-arrival evidence, entered separately from ticket prices.
// Useful when the GTFS feed supplies a route pattern but not a dated trip.
export function validatedGroundTime({arrivalDate='',arrivalClock='',arrivalTimezone=''}={}) {
  const day=String(arrivalDate??'').trim();
  const clock=String(arrivalClock??'').trim();
  const zone=String(arrivalTimezone??'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock) ||
     parseLocalStamp(`${day} ${clock}`)===null)
    throw new Error('Enter a valid ground arrival date and time.');
  if(!zone || zone.length>80)throw new Error('Enter the ground arrival time zone (e.g. Europe/Madrid).');
  try {new Intl.DateTimeFormat('en-US',{timeZone:zone});}
  catch {throw new Error('Enter a valid IANA time zone for the ground arrival.');}
  return {arrivalDate:day,arrivalClock:clock,arrivalTimezone:zone};
}


function parseLocalStamp(value) {
  if (!/^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d$/.test(value || '')) return null;
  const [day,clock] = value.split(' ');
  const [year,month,date] = day.split('-').map(Number);
  const [hour,minute] = clock.split(':').map(Number);
  if(hour>23) return null;
  const timestamp=Date.UTC(year,month-1,date,hour,minute);
  if(!Number.isFinite(timestamp)) return null;
  const check=new Date(timestamp).toISOString().slice(0,16).replace('T',' ');
  return check===value?timestamp:null;
}
function addLocalMinutes(stamp,minutes) {
  const timestamp=parseLocalStamp(stamp);
  if(timestamp===null) return null;
  return new Date(timestamp+minutes*60000).toISOString().slice(0,16).replace('T',' ');
}
function validBuffer(value) {
  return Number.isInteger(value)&&value>=30&&value<=720;
}

// Returns one assessment per GTFS-timed ground leg that directly precedes a
// flight, allowing any number of unverified local transfer placeholders.
export function connectionWindows(route,offers={}, {bufferMinutes=DEFAULT_CONNECTION_BUFFER_MINUTES,flightTimes={},groundTimes={}}={}) {
  if(!validBuffer(bufferMinutes)) throw new Error('Connection buffer must be 30–720 minutes.');
  const legs=Array.isArray(route?.legs)?route.legs:[];
  const windows=[];
  for(let i=0;i<legs.length;i++) {
    const ground=legs[i];
    // Every ground-to-flight connection should have a visible assessment,
    // including those with no date-specific GTFS timetable.
    if(!['train','bus','ferry'].includes(ground?.mode))continue;
    let j=i+1;
    while(j<legs.length && legs[j]?.mode==='transfer')j++;
    const flight=legs[j];
    if(flight?.mode!=='flight')continue;
    const groundKey=ground.key || [ground.from,ground.to,ground.date,ground.mode].join('|');
    const savedGround=groundTimes?.[groundKey];
    const manualArrival=savedGround?.arrivalDate && savedGround?.arrivalClock
      ? `${savedGround.arrivalDate} ${savedGround.arrivalClock}`:null;
    const scheduledArrival=ground.evidence==='gtfs_scheduled' ? ground.arrivalLocal:null;
    const groundArrivalLocal=manualArrival || scheduledArrival || null;
    const timezone=manualArrival?savedGround?.arrivalTimezone:(scheduledArrival?ground.scheduleTimezone:null);
    const earliestDepartureLocal=groundArrivalLocal?addLocalMinutes(groundArrivalLocal,bufferMinutes):null;
    const saved=(Object.hasOwn(flightTimes||{},flight.key) ? flightTimes[flight.key] : offers?.[flight.key]) || {};
    const departureClock=typeof saved.departureClock==='string'?saved.departureClock:'';
    const departureTimezone=typeof saved.departureTimezone==='string'?saved.departureTimezone:'';
    const flightLocal=/^\d{4}-\d{2}-\d{2}$/.test(flight.date||'') && /^([01]\d|2[0-3]):[0-5]\d$/.test(departureClock)
      ? `${flight.date} ${departureClock}`:null;
    let status='ground_time_needed';
    if(earliestDepartureLocal) {
      if(!timezone||!timezone.includes('/'))status='unknown_timezone';
      else if(flightLocal && departureTimezone!==timezone)status='different_timezones';
      else if(flightLocal)status=flightLocal>=earliestDepartureLocal?'meets_buffer':'below_buffer';
      else if(earliestDepartureLocal.slice(0,10)>flight.date)status='window_next_day';
      else status='needs_flight_time';
    }
    windows.push({groundLegIndex:i,groundKey,groundMode:ground.mode,groundTimeSource:manualArrival?'entered':scheduledArrival?'gtfs':'missing',
      flightLegIndex:j,flightFrom:flight.from,
      groundArrivalLocal,earliestDepartureLocal,timeZoneSource:manualArrival?'entered':scheduledArrival?'gtfs':'missing',
      timezone,flightDate:flight.date,flightLocal,departureTimezone,bufferMinutes,status});
  }
  return windows;
}

export function connectionWindowText(window) {
  if(!window)return '';
  if(window.status==='ground_time_needed')return `This ${window.groundMode} connection needs an arrival time before the ${window.bufferMinutes}-minute buffer can be calculated.`;
  if(window.status==='meets_buffer') return `Time check passes: ${window.flightLocal} is after the ${window.bufferMinutes}-minute planning buffer (same time zone).`;
  if(window.status==='below_buffer')return `Time conflict: ${window.flightLocal} leaves before the ${window.earliestDepartureLocal} connection target (${window.timezone}).`;
  if(window.status==='different_timezones')return `Flight and ground times use different or unspecified time zones; compare them before using this connection.`;
  if(window.status==='unknown_timezone')return `Ground timetable zone is unspecified; a safe onward-flight time cannot be calculated.`;
  if(window.status==='window_next_day')return `Planning buffer pushes the onward departure to ${window.earliestDepartureLocal} (${window.timezone}), after the candidate flight date.`;
  return `Earliest suggested onward flight: ${window.earliestDepartureLocal} (${window.timezone}; ${window.bufferMinutes}-minute buffer). Enter its departure time and time zone to check it (no fare required).`;
}
