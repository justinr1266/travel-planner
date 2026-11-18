import {connectionWindows} from './connection-windows.mjs';
import {matchingTicketsForRoute} from './roundtrip-tickets.mjs';
// RouteWise's deterministic, testable planning core. No AI-generated prices.
import { airportDirectory } from './location-resolver.mjs';
import {validDatedTransitResult,routeTransferQuoteKey} from './google-ground-routes.mjs';
export const AIRPORTS = Object.freeze(airportDirectory());
export function airportName(code) {return AIRPORTS[code] ?? code;}

export function parseISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new Error('Use YYYY-MM-DD dates.');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Enter a valid calendar date.');
  }
  return date;
}

function addDays(dateString, days) {
  const date = parseISODate(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function legKey(leg) {
  return [leg.from, leg.to, leg.date, leg.mode].join('|');
}

// Legacy wrapper retained for v0.2-era callers. No destination/country templates.
export function generateRoutes(trip) {
  const {origin,preferred,destination,startDate,endDate}=trip;
  if (![origin,preferred,destination].every(code=>Object.hasOwn(AIRPORTS,code))) throw new Error('Resolve each location to an airport code first.');
  if (origin===preferred || preferred===destination) throw new Error('The destination must differ from trip endpoints.');
  if (parseISODate(endDate)<=parseISODate(startDate)) throw new Error('Final arrival must be later than departure.');
  const legs=[{from:origin,to:preferred,date:startDate,mode:'flight'},
              {from:preferred,to:destination,date:endDate,mode:'flight'}];
  for (const leg of legs) leg.key=legKey(leg);
  return [{id:'generic-direct',name:'Visit '+airportName(preferred),details:'Candidate flight legs only, unverified.',legs}];
}

export function costSummary(route, offers, tickets={}, groundQuotes={}) {
  let known = 0;
  let missing = 0;
  let pricedLegs = 0;
  const ticketMatches=matchingTicketsForRoute(route,tickets);
  const covered=new Set();
  for(const {ticket,outboundIndex,returnIndex} of ticketMatches){
    known+=ticket.totalEur; // Once for BOTH legs, never once per leg.
    covered.add(route.legs[outboundIndex].key);
    covered.add(route.legs[returnIndex].key);
  }
  for (const leg of route.legs) {
    if(covered.has(leg.key)){pricedLegs++;continue;}
    const offer = offers[leg.key];
    if ((!offer || !Number.isFinite(offer.fare)) && validDatedTransitResult(leg,groundQuotes[routeTransferQuoteKey(route,leg)])) {
      known += groundQuotes[routeTransferQuoteKey(route,leg)].fare.amount;
      pricedLegs++;
    } else if (!offer || !Number.isFinite(offer.fare)) {
      missing += 1;
    } else {
      known += offer.fare + (offer.bagFee || 0) + (offer.transferCost || 0);
      pricedLegs++;
    }
  }
  known=Math.round(known*100)/100;
  return {
    complete: missing === 0,
    missing,
    known,
    total: missing === 0 ? known : null,
    pricedLegs,
    ...(ticketMatches.length?{ticketCount:ticketMatches.length}:{} )
  };
}

export function rankRoutes(routes, offers, {bufferMinutes=180,flightTimes={},groundTimes={},tickets={},groundQuotes={}}={}) {
  return routes.map((route, index) => ({ route, summary: costSummary(route, offers, tickets, groundQuotes), index,
    timingConflict: connectionWindows(route, offers, {bufferMinutes,flightTimes,groundTimes}).some(w=>
      w.status==='below_buffer'||w.status==='window_next_day')}))
    .sort((a, b) => {
      // A sourced flight time that fails the chosen buffer should not outrank
      // an alternative solely because its recorded fare is lower.
      if(a.timingConflict!==b.timingConflict)return a.timingConflict?1:-1;
      if (a.summary.complete !== b.summary.complete) return a.summary.complete ? -1 : 1;
      if (a.summary.complete) return a.summary.total - b.summary.total || a.index - b.index;
      // An unpriced 5-leg mixed trip is not intrinsically worse than an
      // unpriced 2-leg flight. Keep the route-quality/diversity ordering until
      // actual fares are recorded; never use missing-leg count as a cost proxy.
      if (!a.summary.pricedLegs && !b.summary.pricedLegs) return a.index - b.index;
      const completionA=a.summary.pricedLegs/a.route.legs.length;
      const completionB=b.summary.pricedLegs/b.route.legs.length;
      return completionB-completionA || a.index-b.index;
    });
}

export function normalizedOffer(fields) {
  function nonNegative(value, label) {
    const number = Number(value);
    if (value === '' || value === null || !Number.isFinite(number) || number < 0) {
      throw new Error(`${label} must be zero or greater.`);
    }
    return Math.round(number * 100) / 100;
  }
  const source = (fields.source ?? '').trim();
  if (source) {
    const url = new URL(source);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Source must be an http(s) URL.');
  }
  const departureClock=String(fields.departureClock??'').trim();
  const departureTimezone=String(fields.departureTimezone??'').trim();
  if(departureClock && !/^([01]\d|2[0-3]):[0-5]\d$/.test(departureClock))
    throw new Error('Flight departure time must be HH:MM in 24-hour time.');
  if(departureTimezone) {
    if(!departureClock)throw new Error('Enter a flight departure time before its time zone.');
    try {new Intl.DateTimeFormat('en-US',{timeZone:departureTimezone});}
    catch {throw new Error('Use a valid IANA time zone, such as Europe/Madrid.');}
  }
  return {
    departureClock,departureTimezone,
    fare: nonNegative(fields.fare, 'Base fare'),
    bagFee: nonNegative(fields.bagFee ?? 0, 'Baggage cost'),
    transferCost: nonNegative(fields.transferCost ?? 0, 'Transfer cost'),
    source,
    note: String(fields.note ?? '').trim().slice(0, 500),
    checkedAt: new Date().toISOString()
  };
}
