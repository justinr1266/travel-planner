import test from 'node:test';
import assert from 'node:assert/strict';
import {captureSelection,parseFlightSelection,buildReviewedFlight} from '../flight-research.mjs';
const leg={from:'MAD',to:'SPC',date:'2027-01-11',mode:'flight',key:'MAD|SPC|2027-01-11|flight'};
const base={confirmed:true,mode:'timing',departureClock:'14:30',departureTimezone:'Europe/Madrid',arrivalClock:'16:45',sourceUrl:'https://www.google.com/travel/flights/search'};
test('selection capture retains only selected text and safe source URL',()=>{
  const item=captureSelection('  Flight 14:30 — 16:45  ','https://www.google.com/travel/flights/search','2026-11-12T23:00:00Z');
  assert.equal(item.text,'Flight 14:30 — 16:45');
  assert.match(item.sourceUrl,/google.com/);
  assert.equal(captureSelection('x'.repeat(6000)).text.length,5000);
  assert.equal(captureSelection('abc','javascript:alert(1)').sourceUrl,'');
  assert.throws(()=>captureSelection('   '),/Highlight/);
});
test('selected 24-hour flight details only suggest two times and unique EUR price',()=>{
  assert.deepEqual(parseFlightSelection('Madrid → La Palma 14:30 – 16:45 €123'),{
    departureClock:'14:30',arrivalClock:'16:45',fareEur:123,warnings:[]});
});
test('12-hour clock and decimal currencies',()=>{
  const value=parseFlightSelection('7:05 AM — 9:25 PM price 1.234,50 €');
  assert.equal(value.departureClock,'07:05');assert.equal(value.arrivalClock,'21:25');assert.equal(value.fareEur,1234.50);
});
test('ambiguous numbers and foreign currency are never silently imported as euros',()=>{
  assert.equal(parseFlightSelection('€120 €210 09:00 12:00 14:00').fareEur,null);
  assert.equal(parseFlightSelection('€120 €210 09:00 12:00 14:00').departureClock,'');
  assert.equal(parseFlightSelection('$120 USD 09:00 — 12:00').fareEur,null);
  assert.equal(parseFlightSelection('€120 or $160').fareEur,null);
});
test('no fare required for reviewed flight timing and matching leg is attached',()=>{
  const data=buildReviewedFlight(base,leg);
  assert.equal(data.offer,null);
  assert.deepEqual(data.flightTime,{departureClock:'14:30',departureTimezone:'Europe/Madrid'});
  assert.equal(data.research.legKey,leg.key);
});
test('review is required before any time or fare can be saved',()=>{
  assert.throws(()=>buildReviewedFlight({...base,confirmed:false},leg),/Confirm/);
  assert.throws(()=>buildReviewedFlight({...base,departureTimezone:''},leg),/time zone/);
  assert.throws(()=>buildReviewedFlight(base,{...leg,mode:'train'}),/flight leg/);
});
test('confirmed EUR fare saves via existing cost model only after bag verified',()=>{
  const data=buildReviewedFlight({...base,mode:'fare',fareEur:'125.00',bagStatus:'extra',bagFee:'30',carrier:'Iberia',stops:'0'},leg);
  assert.equal(data.offer.fare,125);assert.equal(data.offer.bagFee,30);
  assert.equal(data.offer.source,base.sourceUrl);
  assert.match(data.offer.note,/Iberia/);
  assert.match(data.offer.note,/Overhead bag fee checked/);
  assert.equal(data.offer.departureClock,'14:30');
  assert.equal(data.research.bagStatus,'extra');
});
test('priced review never treats unknown baggage as free',()=>{
  assert.throws(()=>buildReviewedFlight({...base,mode:'fare',fareEur:'125',bagStatus:'unknown'},leg),/overhead/);
  assert.throws(()=>buildReviewedFlight({...base,mode:'fare',fareEur:'125',bagStatus:'extra',bagFee:''},leg),/Baggage cost/);
});
test('invalid source URL, negative price and invalid stops cannot be saved',()=>{
  assert.throws(()=>buildReviewedFlight({...base,sourceUrl:'file:///x'},leg),/http/);
  assert.throws(()=>buildReviewedFlight({...base,stops:'-1'},leg),/Stops/);
  assert.throws(()=>buildReviewedFlight({...base,mode:'fare',fareEur:'-10',bagStatus:'included'},leg),/Base fare/);
});
test('flight offer without a departure time can still be reviewed and priced',()=>{
  const result=buildReviewedFlight({...base,mode:'fare',departureClock:'',departureTimezone:'',arrivalClock:'',fareEur:'67',bagStatus:'included'},leg);
  assert.equal(result.flightTime,null);assert.equal(result.offer.fare,67);
});
