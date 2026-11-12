import test from 'node:test';
import assert from 'node:assert/strict';
import {DEMO_PLAN} from '../trip-parser.mjs';
import {generatePlannedRoutes} from '../route-engine.mjs';

const sample = () => ({...structuredClone(DEMO_PLAN),requested_regions:['Canary Islands']});
const portugal = () => ({...sample(),preferred:null,requested_regions:['Portugal']});

test('Portugal without a specified city produces five Portuguese candidates, never Canary Islands', () => {
  const routes = generatePlannedRoutes(portugal());
  assert.equal(routes.length,5);
  assert.ok(routes.every(r => r.legs.some(l => ['LIS','OPO','FAO'].includes(l.to))));
  assert.ok(routes.every(r => r.legs.every(l => !['SPC','TFN','LPA'].includes(l.to))));
  assert.ok(routes.every(r => r.legs.at(-1).to === 'MAD'));
});
test('Flexible departure window is reflected in tentative route departure dates', () => {
  const routes = generatePlannedRoutes(portugal());
  assert.deepEqual(routes.slice(0,3).map(r=>r.legs[0].date),['2027-02-02','2027-02-03','2027-02-04']);
  assert.ok(routes.every(r=>r.legs.at(-1).date==='2027-02-10'));
});
test('Route engine can retain Canary Islands and La Palma preference', () => {
  const routes = generatePlannedRoutes(sample());
  assert.equal(routes.length,5);
  assert.ok(routes.every(r=>r.legs.some(l=>l.to==='SPC')));
  assert.ok(routes.some(r=>r.legs.some(l=>l.mode==='train')));
});
test('Rejects unsupported region rather than pretending to return valid routes', () => {
  assert.throws(()=>generatePlannedRoutes({...portugal(),requested_regions:['Morocco']}),/configured/);
});
test('Honors an impossible minimum-stay constraint by not inventing a route', () => {
  assert.throws(()=>generatePlannedRoutes({...sample(),min_nights_at_preferred:20}),/No candidate patterns/);
});
test('Unknown dates and inverted windows do not get guessed', () => {
  assert.throws(()=>generatePlannedRoutes({...sample(),depart_earliest:null}),/departure window/);
  assert.throws(()=>generatePlannedRoutes({...sample(),depart_latest:'2027-01-01'}),/reversed/);
});
test('Respects a named preferred city in all returned routes', () => {
  const routes = generatePlannedRoutes({...portugal(),preferred:'OPO'});
  assert.ok(routes.length > 0);
  assert.ok(routes.every(r => r.legs.some(l => l.to === 'OPO')));
});
test('Minimum-nights constraint without a preferred destination is rejected', () => {
  assert.throws(() => generatePlannedRoutes({...portugal(), min_nights_at_preferred:3}),/specific preferred/);
});
