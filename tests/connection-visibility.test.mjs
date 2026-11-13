import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionWindows,validatedFlightTime,validatedGroundTime} from '../connection-windows.mjs';
import {connectionPanelData,connectionOverview} from '../connection-view.mjs';
import {rankRoutes,costSummary} from '../core.mjs';
const railKey='station:BCN|station:MAD|2027-01-11|train';
const flightKey='MAD|SPC|2027-01-11|flight';
const route={id:'rail',legs:[
  {from:'BCN',to:'station:BCN',date:'2027-01-11',mode:'transfer'},
  {from:'station:BCN',to:'station:MAD',date:'2027-01-11',mode:'train',evidence:'gtfs_trip_pattern',key:railKey},
  {from:'station:MAD',to:'MAD',date:'2027-01-11',mode:'transfer'},
  {from:'MAD',to:'SPC',date:'2027-01-11',mode:'flight',key:flightKey}
]};
test('a rail pattern shows a visible 3-hour buffer before a flight even without times',()=>{
  const windows=connectionWindows(route);
  assert.equal(windows.length,1);
  assert.equal(windows[0].status,'ground_time_needed');
  const panel=connectionPanelData(windows[0]);
  assert.equal(panel.arrival,'Not available');
  assert.equal(panel.target,'Waiting for ground time');
  assert.equal(panel.buffer,'3 hours');
  assert.match(connectionOverview([route]),/1 need a ground arrival time/);
});
test('manual ground arrival and flight times calculate a result without saving a fare',()=>{
  const ground=validatedGroundTime({arrivalDate:'2027-01-11',arrivalClock:'11:00',arrivalTimezone:'Europe/Madrid'});
  const flight=validatedFlightTime({departureClock:'15:30',departureTimezone:'Europe/Madrid'});
  const options={groundTimes:{[railKey]:ground},flightTimes:{[flightKey]:flight}};
  const [window]=connectionWindows(route,{},options);
  assert.equal(window.status,'meets_buffer');
  assert.equal(window.earliestDepartureLocal,'2027-01-11 14:00');
  assert.equal(window.groundTimeSource,'entered');
  assert.equal(costSummary(route,{}).pricedLegs,0);
  assert.equal(rankRoutes([route],{},options)[0].timingConflict,false);
  const tight=connectionWindows(route,{}, {...options,bufferMinutes:300})[0];
  assert.equal(tight.status,'below_buffer');
  assert.equal(rankRoutes([route],{}, {...options,bufferMinutes:300})[0].timingConflict,true);
});
test('ground arrival input must contain valid local date, time, timezone',()=>{
  assert.throws(()=>validatedGroundTime({arrivalDate:'2027-02-30',arrivalClock:'11:00',arrivalTimezone:'Europe/Madrid'}),/valid ground arrival/);
  assert.throws(()=>validatedGroundTime({arrivalDate:'2027-01-11',arrivalClock:'25:00',arrivalTimezone:'Europe/Madrid'}),/valid ground arrival/);
  assert.throws(()=>validatedGroundTime({arrivalDate:'2027-01-11',arrivalClock:'11:00',arrivalTimezone:'Wrong/City'}),/IANA/);
});
test('flight-only routes say the buffer does not apply',()=>{
  const direct={legs:[{from:'BCN',to:'SPC',mode:'flight',date:'2027-01-11',key:'BCN|SPC|2027-01-11|flight'}]};
  assert.equal(connectionWindows(direct).length,0);
  assert.match(connectionOverview([direct]),/does not affect their ranking/);
});
