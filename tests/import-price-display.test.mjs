import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildReviewedFlight} from '../flight-research.mjs';
import {costSummary,rankRoutes} from '../core.mjs';

const leg={from:'MAD',to:'SPC',date:'2027-01-11',mode:'flight',key:'MAD|SPC|2027-01-11|flight'};
const returnLeg={from:'SPC',to:'MAD',date:'2027-01-18',mode:'flight',key:'SPC|MAD|2027-01-18|flight'};
const fixture=readFileSync(new URL('./fixtures/google-flights-search-mad-spc.txt',import.meta.url),'utf8');
const input={confirmed:true,mode:'fare',carrier:'Iberia Express',departureClock:'11:30',
  departureTimezone:'Europe/Madrid',arrivalClock:'13:35',stops:'0',
  sourceUrl:'https://www.google.com/travel/flights',bagStatus:'included',
  fareEur:'92',rawSelectionText:fixture};

test('a captured Google Flights quote requires separately checked one-way price',()=>{
  assert.throws(()=>buildReviewedFlight(input,leg),/round-trip price/);
  assert.throws(()=>buildReviewedFlight({...input,oneWayFareVerified:true,fareEur:''},leg),/Enter the verified one-way/);
  assert.throws(()=>buildReviewedFlight({...input,oneWayFareVerified:true,bagStatus:'unknown'},leg),/overhead carry-on/);
});
test('a confirmed independent one-way price attaches to exact leg and updates all route instances',()=>{
  const saved=buildReviewedFlight({...input,oneWayFareVerified:true},leg);
  assert.equal(saved.offer.fare,92);
  assert.equal(saved.offer.bagFee,0);
  assert.equal(saved.research.priceVerification,'independently_user_checked_one_way');
  const offers={[leg.key]:saved.offer};
  const twoLeg={id:'a',legs:[leg,returnLeg]};
  const sameLegElsewhere={id:'b',legs:[{...leg},returnLeg]};
  const otherLeg={id:'c',legs:[returnLeg]};
  assert.deepEqual(costSummary(twoLeg,offers),{complete:false,missing:1,known:92,total:null,pricedLegs:1});
  assert.equal(costSummary(sameLegElsewhere,offers).known,92);
  assert.equal(costSummary(otherLeg,offers).known,0);
  assert.equal(rankRoutes([twoLeg,sameLegElsewhere],offers).length,2);
});
test('a checked one-way fare can save without an airport timezone, but does not fabricate a timing check',()=>{
  const saved=buildReviewedFlight({...input,departureTimezone:'',oneWayFareVerified:true},leg);
  assert.equal(saved.offer.fare,92);
  assert.equal(saved.offer.departureClock,'');
  assert.equal(saved.flightTime,null);
  assert.equal(saved.research.departureClock,'11:30');
});
test('saving only the captured departure time does not add a price',()=>{
  const result=buildReviewedFlight({...input,mode:'timing',oneWayFareVerified:false},leg);
  assert.equal(result.offer,null);
  assert.equal(result.flightTime.departureClock,'11:30');
});
test('UI explicitly provides a checked-fare input, confirmation, and visible updated price state',()=>{
  const html=readFileSync(new URL('../panel.html',import.meta.url),'utf8');
  const js=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  assert.match(html,/id="flightImportOneWayVerified"/);
  assert.match(html,/id="flightImportQuoteNotice"/);
  assert.match(html,/id="priceSaveNotice"/);
  assert.match(js,/oneWayFareVerified:\$\('flightImportOneWayVerified'\)\.checked/);
  assert.match(js,/announceSavedFare\(leg,reviewed.offer\)/);
  assert.match(js,/data-leg-key=/);
  assert.match(js,/Known subtotal/);
});
