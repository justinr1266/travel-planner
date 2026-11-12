import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRoutes, costSummary, rankRoutes, normalizedOffer, legKey } from '../core.mjs';

const trip = {
  origin: 'BCN', preferred: 'SPC', destination: 'MAD',
  startDate: '2027-02-02', endDate: '2027-02-10'
};

test('generates five distinct candidate routes', () => {
  const routes = generateRoutes(trip);
  assert.equal(routes.length, 5);
  assert.deepEqual(routes.map(r => r.id), ['direct', 'tenerife', 'madrid', 'gran-canaria', 'ferry']);
  assert.equal(routes[0].legs[0].from, 'BCN');
  assert.equal(routes[0].legs.at(-1).to, 'MAD');
  assert.equal(routes[2].legs[0].mode, 'train');
});

test('shared final leg reuses one saved fare across multiple routes', () => {
  const routes = generateRoutes(trip);
  const shared = routes.map(r => r.legs.at(-1).key);
  assert.equal(new Set(shared).size, 1);
  const offers = { [shared[0]]: {fare: 95, bagFee: 30, transferCost: 5} };
  const summaries = routes.map(r => costSummary(r, offers));
  assert.ok(summaries.every(s => s.known === 130));
});

test('never treats an incomplete route as a confirmed cheap route', () => {
  const routes = generateRoutes(trip);
  const offers = {};
  for (const leg of routes[0].legs) offers[leg.key] = {fare: 100, bagFee: 20};
  const ranked = rankRoutes(routes, offers);
  assert.equal(ranked[0].route.id, 'direct');
  assert.equal(ranked[0].summary.total, 240);
  assert.equal(ranked[1].summary.total, null);
});

test('validates offers and rejects bad prices or URLs', () => {
  assert.equal(normalizedOffer({fare:'69.99',bagFee:'30',transferCost:'0'}).fare, 69.99);
  assert.throws(() => normalizedOffer({fare:'-5'}));
  assert.throws(() => normalizedOffer({fare:'12',source:'javascript:alert(1)'}));
});

test('different transport modes produce different unique keys', () => {
  const base = { from:'TFN',to:'SPC',date:'2027-02-06' };
  assert.notEqual(legKey({...base,mode:'flight'}), legKey({...base,mode:'ferry'}));
});

test('invalid dates are rejected', () => {
  assert.throws(() => generateRoutes({...trip,startDate:'2027-02-30'}));
  assert.throws(() => generateRoutes({...trip,endDate:'2027-02-02'}));
});
