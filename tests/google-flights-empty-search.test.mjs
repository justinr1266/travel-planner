import test from 'node:test';
import assert from 'node:assert/strict';
import {sameExactGoogleFlightsSearch} from '../google-flights-search.mjs';

test('no-options message must originate from exact expected search and EUR currency',()=>{
  const expected='https://www.google.com/travel/flights/search?tfs=REU_SPC_2027&curr=EUR';
  assert.equal(sameExactGoogleFlightsSearch(expected,expected),true);
  assert.equal(sameExactGoogleFlightsSearch(expected+'&hl=en',expected),true);
  assert.equal(sameExactGoogleFlightsSearch(expected.replace('REU_SPC','BCN_SPC'),expected),false);
  assert.equal(sameExactGoogleFlightsSearch(expected.replace('EUR','USD'),expected),false);
  assert.equal(sameExactGoogleFlightsSearch(expected.replace('/travel/flights/search','/travel/flights'),expected),false);
  assert.equal(sameExactGoogleFlightsSearch('https://evil.test/travel/flights/search?tfs=REU_SPC_2027&curr=EUR',expected),false);
  assert.equal(sameExactGoogleFlightsSearch('nonsense',expected),false);
});
