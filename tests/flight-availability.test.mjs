import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {flightAvailabilityKey,hasNoFlightsResult,excludeUnavailableFlightRoutes} from '../flight-availability.mjs';
import {researchKey,researchTasks} from '../broad-research.mjs';
import {PLANNING_RESET_KEYS} from '../planning-reset.mjs';
const f=(from,to,date)=>({mode:'flight',from,to,date});
const notFound=f('REU','SPC','2027-01-11');
const routes=[{id:'via-reu',legs:[notFound,f('SPC','MAD','2027-01-18')]},
  {id:'direct',legs:[f('BCN','SPC','2027-01-11')]},
  {id:'another-reu',legs:[{...notFound}]},
  {id:'train',legs:[{mode:'train',from:'REU',to:'SPC',date:'2027-01-11'}]}];
const key=researchKey(notFound);
const excluded={[key]:{status:'no_flights',source:'user_review'}};
test('availability keys match the flight search task keys',()=>{
  assert.equal(flightAvailabilityKey(notFound),key);
  assert.equal(key,'REU|SPC|2027-01-11|economy|EUR|1adult');
});
test('reviewed no-service date removes every candidate using that flight but preserves others',()=>{
  assert.deepEqual(excludeUnavailableFlightRoutes(routes,excluded).map(route=>route.id),['direct','train']);
  assert.deepEqual(researchTasks(excludeUnavailableFlightRoutes(routes,excluded)).map(task=>task.key),
    [researchKey(f('BCN','SPC','2027-01-11'))]);
});
test('other dates, directions, and transport modes are not excluded',()=>{
  const changed=[{legs:[f('REU','SPC','2027-01-12')]},{legs:[f('SPC','REU','2027-01-11')]},
    {legs:[{...notFound,mode:'train'}]}];
  assert.equal(excludeUnavailableFlightRoutes(changed,excluded).length,3);
});
test('no price, timeout and unreviewed empty search cannot mark no flights',()=>{
  for(const entry of [undefined,{status:'import_error'},{status:'no_price'},{status:'no_flights',source:'automatic_unverified'}]){
    const exclusions=entry?{[key]:entry}:{};
    assert.equal(hasNoFlightsResult(key,exclusions),false);
    assert.equal(excludeUnavailableFlightRoutes(routes,exclusions).length,routes.length);
  }
});
test('undo and full reset restore all routes',()=>{
  const current={...excluded};
  assert.equal(excludeUnavailableFlightRoutes(routes,current).length,2);
  delete current[key];
  assert.equal(excludeUnavailableFlightRoutes(routes,current).length,4);
  assert.ok(PLANNING_RESET_KEYS.includes('unavailableFlights'));
});
test('panel has a confirmation, restore control, storage and exclusion-aware view',()=>{
  const src=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  assert.match(src,/data-broad-no-flights/);
  assert.match(src,/data-broad-restore/);
  assert.match(src,/window\.confirm/);
  assert.match(src,/function visibleRoutes\(\).*excludeUnavailableFlightRoutes/);
  assert.match(src,/await persist\(\);render\(\);/);
});

test('exact Google Flights no-options results exclude routes, while generic import errors do not',()=>{
  const auto={[key]:{status:'no_flights',source:'google_flights_exact_search',observedAt:'2026-11-18T20:00:00Z'}};
  assert.deepEqual(excludeUnavailableFlightRoutes(routes,auto).map(r=>r.id),['direct','train']);
  assert.equal(hasNoFlightsResult(key,{[key]:{status:'no_flights',source:'unverified'}}),false);
});
