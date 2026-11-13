import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseGoogleFlightsPage,matchingRoundTripDirection} from '../google-flights-text.mjs';
import {parseFlightSelection,buildReviewedFlight} from '../flight-research.mjs';
const sample=readFileSync(fileURLToPath(new URL('./fixtures/google-flights-mad-spc-rt.txt',import.meta.url)),'utf8');
const outbound={key:'MAD|SPC|2027-01-11|flight',from:'MAD',to:'SPC',date:'2027-01-11',mode:'flight'};
const inbound={key:'SPC|MAD|2027-01-18|flight',from:'SPC',to:'MAD',date:'2027-01-18',mode:'flight'};
const base={confirmed:true,mode:'fare',departureClock:'07:00',departureTimezone:'Europe/Madrid',arrivalClock:'10:30',bagStatus:'included',fareEur:'123',sourceUrl:'https://www.google.com/travel/flights/search'};

test('pasted full Google Flights page extracts both directions and connecting segments',()=>{
  const trip=parseGoogleFlightsPage(sample);
  assert.equal(trip.type,'google_flights_round_trip');
  assert.deepEqual([trip.outbound.from,trip.outbound.to,trip.outbound.departureClock,trip.outbound.arrivalClock,trip.outbound.stops],['MAD','SPC','07:00','10:30',1]);
  assert.deepEqual([trip.inbound.from,trip.inbound.to,trip.inbound.departureClock,trip.inbound.arrivalClock,trip.inbound.stops],['SPC','MAD','08:30','14:05',1]);
  assert.deepEqual(trip.outbound.via,['TFN']);
  assert.deepEqual(trip.inbound.via,['TFN']);
  assert.equal(trip.outbound.carrier,'Binter Canarias');
  assert.deepEqual(trip.outbound.flightNumbers,['NT 6073','NT 616']);
  assert.equal(trip.lowestTotalEur,123);
  assert.deepEqual(trip.bookingOptions.slice(0,3),[
    {seller:'Binter Canarias',fareEur:156},
    {seller:'Booking.com',fareEur:126},
    {seller:'BudgetAir',fareEur:123}]);
  assert.equal(trip.carryOnNote,'1 free carry-on');
  assert.equal(trip.baggageSellerUnknown,true);
});
test('only the selected matching route leg gets times; no round-trip price enters single-leg form',()=>{
  const a=parseFlightSelection(sample,{leg:outbound});
  assert.equal(a.matchedDirection,'outbound');
  assert.equal(a.departureClock,'07:00');
  assert.equal(a.arrivalClock,'10:30');
  assert.equal(a.stops,1);
  assert.equal(a.fareEur,null);
  const b=parseFlightSelection(sample,{leg:inbound});
  assert.equal(b.matchedDirection,'return');
  assert.equal(b.departureClock,'08:30');
  assert.equal(b.arrivalClock,'14:05');
  assert.equal(b.fareEur,null);
  const wrongDay=parseFlightSelection(sample,{leg:{...outbound,date:'2027-01-12'}});
  assert.equal(wrongDay.matchedDirection,null);
  assert.equal(wrongDay.departureClock,'');
  const wrongAirport=parseFlightSelection(sample,{leg:{...outbound,to:'TFN'}});
  assert.equal(wrongAirport.matchedDirection,null);
  assert.equal(wrongAirport.arrivalClock,'');
});
test('a round-trip total cannot be added as an individual fare even when the user marks baggage included',()=>{
  assert.throws(()=>buildReviewedFlight({...base,rawSelectionText:sample},outbound),/round-trip price/i);
  assert.equal(buildReviewedFlight({...base,mode:'timing',rawSelectionText:sample},outbound).offer,null);
});
test('non-Google copied flight summaries retain the original parser behavior',()=>{
  const parsed=parseFlightSelection('MAD to SPC 07:00 – 10:30 €80');
  assert.equal(parsed.departureClock,'07:00');
  assert.equal(parsed.arrivalClock,'10:30');
  assert.equal(parsed.fareEur,80);
  assert.equal(parseGoogleFlightsPage('07:00 – 10:30 €80'),null);
});
test('does not match unknown or unsupported date patterns by airport alone',()=>{
  const trip=parseGoogleFlightsPage(sample);
  assert.equal(matchingRoundTripDirection(trip,{...outbound,date:'2028-01-11'}),null);
  // A copied Google Flights date may omit the year, so reject a different
  // calendar year when its weekday disagrees with the displayed weekday.
  assert.equal(matchingRoundTripDirection(trip,{...outbound,date:'2027-02-11'}),null);
});
