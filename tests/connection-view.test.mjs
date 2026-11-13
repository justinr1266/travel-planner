import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionWindows,validatedFlightTime} from '../connection-windows.mjs';
import {connectionPanelData} from '../connection-view.mjs';
import {costSummary,rankRoutes} from '../core.mjs';

const flightKey='MAD|SPC|2027-01-11|flight';
const groundRoute={id:'ground',legs:[
  {from:'station:sants',to:'station:atocha',date:'2027-01-11',mode:'train',evidence:'gtfs_scheduled',
    arrivalLocal:'2027-01-11 11:00',scheduleTimezone:'Europe/Madrid'},
  {from:'station:atocha',to:'MAD',date:'2027-01-11',mode:'transfer'},
  {from:'MAD',to:'SPC',date:'2027-01-11',mode:'flight',key:flightKey}
]};

test('connection panel exposes ground arrival, buffer and earliest flight target immediately, no offer required',()=>{
  const windows=connectionWindows(groundRoute);
  const shown=connectionPanelData(windows[0]);
  assert.equal(windows.length,1);
  assert.equal(shown.arrival,'2027-01-11 11:00');
  assert.equal(shown.buffer,'3 hours');
  assert.equal(shown.target,'2027-01-11 14:00');
  assert.equal(shown.title,'Flight time needed');
  assert.equal(shown.tone,'neutral');
  assert.equal(shown.flightTime,null);
  assert.equal(costSummary(groundRoute,{}).pricedLegs,0);
});

test('independent time-only input checks a flight without adding a fake priced leg',()=>{
  const saved=validatedFlightTime({departureClock:'16:15',departureTimezone:'Europe/Madrid'});
  const windows=connectionWindows(groundRoute,{}, {flightTimes:{[flightKey]:saved}});
  assert.equal(windows[0].status,'meets_buffer');
  assert.equal(connectionPanelData(windows[0]).title,'Buffer met');
  assert.equal(costSummary(groundRoute,{}).complete,false);
  assert.equal(costSummary(groundRoute,{}).pricedLegs,0);
});

test('independent time takes precedence over optional saved fare time',()=>{
  const fareOffer={[flightKey]:{fare:100,departureClock:'17:30',departureTimezone:'Europe/Madrid'}};
  const check=validatedFlightTime({departureClock:'12:00',departureTimezone:'Europe/Madrid'});
  assert.equal(connectionWindows(groundRoute,fareOffer)[0].status,'meets_buffer');
  assert.equal(connectionWindows(groundRoute,fareOffer,{flightTimes:{[flightKey]:check}})[0].status,'below_buffer');
  assert.equal(connectionPanelData(connectionWindows(groundRoute,fareOffer,{flightTimes:{[flightKey]:check}})[0]).tone,'bad');
});

test('time-only conflicts affect ranking while leaving recorded prices unchanged',()=>{
  const direct={id:'direct',legs:[{from:'BCN',to:'SPC',mode:'flight',date:'2027-01-11',key:'BCN|SPC|2027-01-11|flight'}]};
  const fares={[flightKey]:{fare:10},'BCN|SPC|2027-01-11|flight':{fare:100}};
  assert.deepEqual(rankRoutes([groundRoute,direct],fares).map(x=>x.route.id),['direct','ground']);
  const times={[flightKey]:validatedFlightTime({departureClock:'12:30',departureTimezone:'Europe/Madrid'})};
  const ranked=rankRoutes([groundRoute,direct],fares,{flightTimes:times});
  assert.equal(ranked[1].timingConflict,true);
  assert.equal(ranked[1].summary.pricedLegs,1);
  assert.equal(ranked[1].summary.known,10);
});

test('connection view explains next-day targets and changing buffers',()=>{
  const late=structuredClone(groundRoute);
  late.legs[0].arrivalLocal='2027-01-11 23:30';
  let shown=connectionPanelData(connectionWindows(late)[0]);
  assert.equal(shown.title,'Next-day flight needed');
  assert.equal(shown.target,'2027-01-12 02:30');
  shown=connectionPanelData(connectionWindows(groundRoute,{}, {bufferMinutes:240})[0]);
  assert.equal(shown.buffer,'4 hours');
  assert.equal(shown.target,'2027-01-11 15:00');
});

test('different time zones never show a false pass/fail',()=>{
  const saved=validatedFlightTime({departureClock:'15:00',departureTimezone:'Atlantic/Canary'});
  const shown=connectionPanelData(connectionWindows(groundRoute,{}, {flightTimes:{[flightKey]:saved}})[0]);
  assert.equal(shown.title,'Time zones differ');
  assert.equal(shown.tone,'neutral');
});

test('time-only input validates time and IANA zone before saving',()=>{
  assert.deepEqual(validatedFlightTime({departureClock:'09:04',departureTimezone:'Europe/Madrid'}),
    {departureClock:'09:04',departureTimezone:'Europe/Madrid'});
  assert.throws(()=>validatedFlightTime({departureClock:'25:00',departureTimezone:'Europe/Madrid'}),/HH:MM/);
  assert.throws(()=>validatedFlightTime({departureClock:'10:00',departureTimezone:''}),/time zone/);
  assert.throws(()=>validatedFlightTime({departureClock:'10:00',departureTimezone:'Wrong/Zone'}),/IANA/);
});
