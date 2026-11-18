import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateRoute} from '../broad-research.mjs';
import {trainResearchKey} from '../train-research.mjs';

const train={mode:'train',from:'station:gtfs:x',to:'station:gtfs:y',
  fromLabel:'Barcelona Sants',toLabel:'Madrid Atocha',date:'2027-01-11',
  key:'station:gtfs:x|station:gtfs:y|2027-01-11|train'};
const route={id:'train-only',legs:[train]};
const trainCache={[trainResearchKey(train)]:{quoteStatus:'indicative',
  selected:{fareEur:45.9,departureClock:'08:20',arrivalClock:'11:10'},
  sourceUrl:'https://www.omio.com/search',capturedAt:new Date().toISOString()}};

test('train without provider quote remains unknown, not a zero or fixed estimate',()=>{
  const row=estimateRoute(route);
  assert.equal(row.known,0);assert.equal(row.total,null);
  assert.equal(row.missing,1);assert.equal(row.estimatedCount,0);
});
test('imported train quote enters provisional total as estimate, not a saved fare',()=>{
  const row=estimateRoute(route,{}, {},{}, {trainCache});
  assert.equal(row.total,45.9);assert.equal(row.missing,0);
  assert.equal(row.verifiedCount,0);assert.equal(row.estimatedCount,1);
  assert.equal(row.selected[0].kind,'train_estimate');
});
test('user-checked offer supersedes indicative quote without double charging',()=>{
  const offers={[train.key]:{fare:50,bagFee:0,transferCost:0}};
  const row=estimateRoute(route,{},offers,{}, {trainCache});
  assert.equal(row.total,50);assert.equal(row.verifiedCount,1);
  assert.equal(row.estimatedCount,0);assert.equal(row.selected[0].kind,'verified');
});
