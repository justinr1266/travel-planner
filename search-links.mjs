// User-directed Google Flights search links. No scraping or background queries.
// The `tfs` protobuf URL representation is undocumented and could change.
import { parseISODate } from './core.mjs';

function varint(value) {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return bytes;
}
function scalar(field, value) {
  return [...varint(field * 8), ...varint(value)];
}
function bytesField(field, bytes) {
  return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
}
function stringField(field, value) {
  return bytesField(field, [...new TextEncoder().encode(value)]);
}
function airport(code) {
  return [...scalar(1, 1), ...stringField(2, code)];
}
function validateFlightLeg(leg) {
  if (leg?.mode !== 'flight') throw new Error('A Google Flights link requires a flight leg.');
  for (const [label, code] of [['origin',leg.from], ['destination',leg.to]]) {
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) {
      throw new Error(`Invalid ${label} airport code.`);
    }
  }
  if (leg.from === leg.to) throw new Error('Origin and destination must differ.');
  parseISODate(leg.date);
}
function encodeSegment(leg) {
  return [
    ...stringField(2, leg.date),
    ...bytesField(13, airport(leg.from)),
    ...bytesField(14, airport(leg.to))
  ];
}
function buildGoogleFlightsUrl(legs, tripType) {
  // field 19: 1 = round trip, 2 = one way.
  // field 3 repeats for each direction; this is a *search*, not a booking.
  const payload = [
    ...scalar(2, 0),
    ...legs.flatMap(leg => bytesField(3, encodeSegment(leg))),
    ...scalar(8, 1),
    ...scalar(9, 1),
    ...scalar(19, tripType)
  ];
  const base64 = btoa(String.fromCharCode(...payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const url = new URL('https://www.google.com/travel/flights/search');
  url.searchParams.set('tfs', base64);
  url.searchParams.set('curr', 'EUR');
  url.searchParams.set('hl', 'en');
  return url.toString();
}

export function googleFlightsSearchUrl(leg) {
  validateFlightLeg(leg);
  return buildGoogleFlightsUrl([leg], 2);
}

export function googleFlightsRoundTripUrl(outbound, returning) {
  validateFlightLeg(outbound);
  validateFlightLeg(returning);
  if (outbound.from !== returning.to || outbound.to !== returning.from) {
    throw new Error('Round-trip flights must return to the original departure airport.');
  }
  if (parseISODate(returning.date) <= parseISODate(outbound.date)) {
    throw new Error('Return date must be after departure date.');
  }
  return buildGoogleFlightsUrl([outbound, returning], 1);
}

// Find outbound/return legs within ONE proposed scenario, even if a train came
// before the outbound. Pair each leg at most once and never invent dates.
export function findRoundTripPairs(legs) {
  if (!Array.isArray(legs)) return [];
  const paired = new Set();
  const matches = [];
  for (let i = 0; i < legs.length; i += 1) {
    const outbound = legs[i];
    if (outbound?.mode !== 'flight' || paired.has(i)) continue;
    for (let j = i + 1; j < legs.length; j += 1) {
      const returning = legs[j];
      if (returning?.mode !== 'flight' || paired.has(j)) continue;
      if (outbound.from !== returning.to || outbound.to !== returning.from) continue;
      try { googleFlightsRoundTripUrl(outbound, returning); }
      catch { continue; }
      paired.add(i);
      paired.add(j);
      matches.push({outboundIndex: i, returnIndex: j});
      break;
    }
  }
  return matches;
}
