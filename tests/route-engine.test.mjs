import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePlannedRoutes} from '../route-engine.mjs';
import {DEMO_PLAN} from '../trip-parser.mjs';
const base=()=>structuredClone(DEMO_PLAN);
const swedishRecords=[
  ['MIL','Milan','IT','Milan (all airports)','metro'],
  ['ARN','Stockholm','SE','Stockholm Arlanda Airport','airport'],
  ['GOT','Gothenburg','SE','Gothenburg Landvetter Airport','airport'],
  ['MMX','Malmo','SE','Malmo Airport','airport'],
  ['BER','Berlin','DE','Berlin Brandenburg Airport','airport']
];
const swedishPlan=()=>({origin:'MIL',destination:'MIL',preferred:null,destination_search:'region',requested_regions:['Sweden'],
    depart_earliest:'2027-01-21',depart_latest:'2027-01-21',arrive_earliest:'2027-01-24',arrive_latest:'2027-01-24',fixed_arrival:true,
    priority:'more_time_at_preferred',min_nights_at_preferred:null});
const suggestions=[
  {code:'ARN',city:'Stockholm',country:'Sweden'},
  {code:'GOT',city:'Gothenburg',country:'Sweden'},
  {code:'MMX',city:'Malmo',country:'Sweden'}
];
test('A named destination yields a generic route without Canary or Portugal templates',()=>{
  const routes=generatePlannedRoutes({...base(),alternate_stops:[]});
  assert.equal(routes.length,1);
  assert.deepEqual(routes[0].legs.map(l=>[l.from,l.to,l.date]),
    [['BCN','SPC','2027-02-02'],['SPC','MAD','2027-02-10']]);
});
test('Suggestions for any country generate identical structural routes and do not invent stops',()=>{
  const routes=generatePlannedRoutes(swedishPlan(),{destinationCandidates:suggestions,records:swedishRecords});
  assert.equal(routes.length,3);
  assert.deepEqual(routes[0].legs.map(l=>[l.from,l.to,l.date]),
    [['MIL','ARN','2027-01-21'],['ARN','MIL','2027-01-24']]);
  assert.deepEqual(routes.map(r=>r.primaryStay.possibleNights),[3,3,3]);
  assert.ok(routes.every(r=>r.warnings.some(w=>/not verified/i.test(w))));
});
test('Region discovery applies minimum nights to each suggested primary destination',()=>{
  // Regression: Sweden returned min_nights_at_preferred=1 without a preselected city.
  const routes=generatePlannedRoutes({...swedishPlan(),min_nights_at_preferred:1},
    {destinationCandidates:suggestions,records:swedishRecords});
  assert.equal(routes.length,3);
  assert.ok(routes.every(route=>route.primaryStay.possibleNights>=1));
});
test('Open-ended discovery also accepts a minimum stay without naming a city',()=>{
  const routes=generatePlannedRoutes({...swedishPlan(),destination_search:'open',requested_regions:[],min_nights_at_preferred:2},
    {destinationCandidates:suggestions,records:swedishRecords});
  assert.equal(routes.length,3);
});
test('Impossible minimum-stay duration is rejected with an accurate explanation',()=>{
  assert.throws(()=>generatePlannedRoutes({...swedishPlan(),min_nights_at_preferred:4},
    {destinationCandidates:suggestions,records:swedishRecords}),/at least 4 tentative nights/);
});
test('Specified destination with no primary still requires one for minimum-night rules',()=>{
  assert.throws(()=>generatePlannedRoutes({...swedishPlan(),destination_search:'specified',min_nights_at_preferred:1},
    {destinationCandidates:suggestions,records:swedishRecords}),/specific preferred destination/);
});
test('AI cannot smuggle a code from the wrong country',()=>{
  const routes=generatePlannedRoutes(swedishPlan(),{destinationCandidates:[...suggestions,{code:'BER',city:'Berlin',country:'Germany'}],records:swedishRecords});
  assert.equal(routes.length,3);
});
test('Open-ended searches require suggested destinations rather than a hard-coded five-city list',()=>{
  const plan={...swedishPlan(),destination_search:'open',requested_regions:[]};
  assert.throws(()=>generatePlannedRoutes(plan,{records:swedishRecords}),/destination candidates/);
  const routes=generatePlannedRoutes(plan,{destinationCandidates:suggestions,records:swedishRecords});
  assert.equal(routes.length,3);
});
test('Destination time is maximized while dates remain clearly unverified',()=>{
  const routes=generatePlannedRoutes({...base(),depart_earliest:'2027-01-11',depart_latest:'2027-01-13',arrive_latest:'2027-01-18'});
  assert.equal(routes[0].legs[0].date,'2027-01-11');
  assert.equal(routes[0].primaryStay.possibleNights,7);
  assert.equal(routes[0].primaryStay.verified,false);
});
test('Traveler-specified optional stops remain valid, including the eventual final city as an outbound hub',()=>{
  const routes=generatePlannedRoutes({...base(),alternate_stops:['MAD']});
  assert.equal(routes.length,2);
  assert.deepEqual(routes[1].legs.map(l=>l.to),['MAD','SPC','MAD']);
  const other=generatePlannedRoutes({...base(),alternate_stops:['LIS']});
  assert.equal(other.length,2);
  assert.deepEqual(other[1].legs.map(l=>l.to),['LIS','SPC','MAD']);
});
test('Reject reversed or missing date ranges, incompatible nights, unknown locations',()=>{
  assert.throws(()=>generatePlannedRoutes({...base(),depart_earliest:null}),/departure window/);
  assert.throws(()=>generatePlannedRoutes({...base(),depart_latest:'2027-01-01'}),/reversed/);
  assert.throws(()=>generatePlannedRoutes({...base(),min_nights_at_preferred:25}),/route candidates/);
  assert.throws(()=>generatePlannedRoutes({...base(),origin:'ZQX'}),/airport directory/);
});
test('Fixed return date must not be a date range',()=>{
  assert.throws(()=>generatePlannedRoutes({...base(),fixed_arrival:true,arrive_earliest:'2027-02-09'}),/single exact date/);
});
