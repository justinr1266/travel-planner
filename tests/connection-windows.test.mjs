import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionWindows,connectionWindowText} from '../connection-windows.mjs';
import {normalizedOffer,costSummary,rankRoutes} from '../core.mjs';
import {candidateQuality} from '../route-quality.mjs';

function route(arrival='2027-01-11 11:00',flightDate='2027-01-11') {
  return {id:'mixed',legs:[
    {from:'station:gtfs:renfe:BS',to:'station:gtfs:renfe:MA',date:'2027-01-11',mode:'train',
      evidence:'gtfs_scheduled',arrivalLocal:arrival,departureLocal:'2027-01-11 08:00',scheduleTimezone:'Europe/Madrid'},
    {from:'station:gtfs:renfe:MA',to:'MAD',date:'2027-01-11',mode:'transfer'},
    {from:'MAD',to:'SPC',date:flightDate,mode:'flight',key:`MAD|SPC|${flightDate}|flight`}
  ]};
}
function offer(clock,zone='Europe/Madrid'){
  return {'MAD|SPC|2027-01-11|flight':{fare:90,departureClock:clock,departureTimezone:zone}};
}
test('timed GTFS arrival yields an onward flight target after the airport planning buffer',()=>{
  const [window]=connectionWindows(route());
  assert.equal(window.status,'needs_flight_time');
  assert.equal(window.earliestDepartureLocal,'2027-01-11 14:00');
  assert.match(connectionWindowText(window),/14:00/);
  assert.equal(window.flightFrom,'MAD');
});
test('saved flight time in same IANA time zone can meet the planning buffer',()=>{
  const [window]=connectionWindows(route(),offer('15:15'));
  assert.equal(window.status,'meets_buffer');
  assert.match(connectionWindowText(window),/passes/i);
});
test('saved flight leaving before buffer target is marked as a time conflict',()=>{
  const [window]=connectionWindows(route(),offer('12:45'));
  assert.equal(window.status,'below_buffer');
  assert.match(connectionWindowText(window),/conflict/i);
});
test('different and missing time zones never produce a false time conflict',()=>{
  assert.equal(connectionWindows(route(),offer('13:00','Atlantic/Canary'))[0].status,'different_timezones');
  assert.equal(connectionWindows(route(),offer('13:00',''))[0].status,'different_timezones');
});
test('a 23:10 ground arrival plus three hours moves possible onward flight to following day',()=>{
  const result=connectionWindows(route('2027-01-11 23:10'))[0];
  assert.equal(result.status,'window_next_day');
  assert.equal(result.earliestDepartureLocal,'2027-01-12 02:10');
  assert.match(connectionWindowText(result),/after the candidate flight date/);
  assert.ok(candidateQuality(route('2027-01-11 23:10'))<candidateQuality(route()));
});
test('changing the planning buffer changes the threshold without changing any route dates',()=>{
  assert.equal(connectionWindows(route(),{}, {bufferMinutes:120})[0].earliestDepartureLocal,'2027-01-11 13:00');
  assert.equal(connectionWindows(route(),offer('13:30'),{bufferMinutes:120})[0].status,'meets_buffer');
  assert.throws(()=>connectionWindows(route(),{}, {bufferMinutes:0}),/30–720/);
});
test('unknown GTFS times visibly request ground arrival instead of inventing a departure target',()=>{
  const plan=route();plan.legs[0].evidence='gtfs_trip_pattern';
  assert.equal(connectionWindows(plan)[0].status,'ground_time_needed');
  assert.equal(connectionWindows(plan)[0].earliestDepartureLocal,null);
  plan.legs[0].evidence='gtfs_scheduled';delete plan.legs[0].arrivalLocal;
  assert.equal(connectionWindows(plan)[0].status,'ground_time_needed');
});
test('optional flight time and IANA zone survive fare validation and do not alter totals',()=>{
  const checked=normalizedOffer({fare:'70',bagFee:'10',transferCost:'0',source:'',note:'',departureClock:'16:30',departureTimezone:'Europe/Madrid'});
  assert.equal(checked.departureClock,'16:30');
  assert.equal(checked.departureTimezone,'Europe/Madrid');
  assert.equal(costSummary({legs:[route().legs[2]]},{[route().legs[2].key]:checked}).total,80);
  assert.throws(()=>normalizedOffer({fare:70,departureClock:'29:15'}),/HH:MM/);
  assert.throws(()=>normalizedOffer({fare:70,departureClock:'13:15',departureTimezone:'Wrong/Zone'}),/IANA/);
});

test('a cheaper but time-conflicting priced route is ranked after a nonconflicting alternative',()=>{
  const bad=route();bad.id='bad';
  const good={id:'direct',legs:[{from:'BCN',to:'SPC',mode:'flight',date:'2027-01-11',key:'BCN|SPC|2027-01-11|flight'}]};
  const all={...offer('12:30'),'BCN|SPC|2027-01-11|flight':{fare:130},
    [bad.legs[0].key||'rail']:{fare:0},[bad.legs[1].key||'transfer']:{fare:0}};
  bad.legs[0].key='rail';bad.legs[1].key='transfer';
  assert.deepEqual(rankRoutes([bad,good],all).map(item=>item.route.id),['direct','bad']);
  // A shorter deliberately selected buffer removes the conflict.
  assert.deepEqual(rankRoutes([bad,good],all,{bufferMinutes:60}).map(item=>item.route.id),['bad','direct']);
});
