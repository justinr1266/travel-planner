import test from 'node:test';
import assert from 'node:assert/strict';
import {protectReviewedTrip} from '../trip-consistency.mjs';
import {normalizeTripWithDiagnostics,DEMO_PLAN} from '../trip-parser.mjs';
import {generatePlannedRoutes} from '../route-engine.mjs';
import {expandRoutesWithGround} from '../ground-routes.mjs';

const request='I want to go to La Palma from january 11th to january 18th, starting in Barcelona and ending in madrid.';
const original=()=>({...DEMO_PLAN,origin:'BCN',destination:'MAD',preferred:'SPC',destination_search:'specified',
  depart_earliest:'2027-01-11',depart_latest:'2027-01-11',arrive_earliest:'2027-01-18',arrive_latest:'2027-01-18',
  fixed_departure:true,fixed_arrival:true,requested_regions:[],alternate_stops:[]});
const form=()=>({origin:'BCN',destination:'MAD',preferred:'GCT',destinationSearch:'specified',
  startDate:'2027-01-11',endDate:'2027-01-18',request});

test('Review and generate always honor a named primary destination even if the form contains GCT',()=>{
  const r=protectReviewedTrip(form(),{parsedPlan:original(),parsedRequest:request});
  assert.equal(r.error,null);
  assert.equal(r.trip.preferred,'SPC');
  assert.match(r.notices.join(' '),/GCT.*SPC/);
  const routes=generatePlannedRoutes(original());
  assert.equal(routes[0].primaryStay.possibleNights,7);
});

test('Groq hallucinations, including GCT, normalize to traveler-named destination',()=>{
  for(const wrong of ['LPQ','GCT','TFN','Menongue','LIS',null]) {
    const raw={...original(),preferred:wrong};
    const normalized=normalizeTripWithDiagnostics(request,raw,{referenceDate:'2026-11-12'});
    assert.equal(normalized.plan.preferred,'SPC');
  }
});

test('Form cannot silently shift a fixed January 18 return to January 19',()=>{
  const r=protectReviewedTrip({...form(),endDate:'2027-01-19'},{parsedPlan:original(),parsedRequest:request});
  assert.match(r.error,/January|2027-01-18/);
  assert.equal(r.trip.endDate,'2027-01-19'); // error rather than silently adjusting the form
});

test('Form date change allowed when the text has changed or no reviewed plan exists',()=>{
  const r=protectReviewedTrip({...form(),endDate:'2027-01-19',request:'Changed itinerary'},
    {parsedPlan:original(),parsedRequest:request});
  assert.equal(r.error,null);
});

test('Ground route keeps January 18 return and potential seven-night stay',()=>{
  const plan=original();
  const flights=generatePlannedRoutes(plan);
  const edge={mode:'train',fromAirport:'BCN',toAirport:'MAD',fromStop:{id:'bar',name:'Barcelona Sants'},
    toStop:{id:'mad',name:'Madrid Atocha'},feedId:'rail',source:'GTFS',validFrom:'2026-11-11',validTo:'2027-01-24'};
  const combined=expandRoutesWithGround(plan,flights,[edge]);
  const ground=combined.find(x=>x.networkEvidence);
  assert.ok(ground,'should generate a ground variant');
  assert.equal(ground.legs.at(-1).date,'2027-01-18');
  assert.equal(ground.primaryStay.possibleNights,7);
  assert.equal(ground.legs.find(x=>x.mode==='train').date,'2027-01-11');
});


test('An unmentioned but real primary airport is not accepted if explicit matching fails',()=>{
  const raw={...original(),preferred:'LPQ'};
  const request='I need a vacation destination near a volcano, leaving Barcelona and ending Madrid.';
  const r=normalizeTripWithDiagnostics(request,raw,{referenceDate:'2026-11-12'});
  assert.equal(r.plan.preferred,null);
  assert.ok(r.plan.questions.some(q=>/not supported by the trip description/i.test(q)));
  assert.ok(r.corrections.some(c=>c.field==='preferred' && c.model==='LPQ' && c.normalized===null));
});

test('An explicitly named alternative destination can be accepted without country-specific exceptions',()=>{
  const request='I want to visit Lisbon, starting in Barcelona and ending in Madrid.';
  const raw={...original(),preferred:'LIS'};
  const r=normalizeTripWithDiagnostics(request,raw,{referenceDate:'2026-11-12'});
  assert.equal(r.plan.preferred,'LIS');
});
