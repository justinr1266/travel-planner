import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_PLAN, validateTripPlan } from '../trip-parser.mjs';
import { applyPlanToForm } from '../plan-ui.mjs';
import { parseWithGroq } from '../server.mjs';

const plan = () => structuredClone(DEMO_PLAN);
test('validates demo plan, preserving flexible departure dates and arrival deadline', () => {
  const result = validateTripPlan(plan());
  assert.equal(result.plan.depart_latest, '2027-02-04');
  assert.equal(result.plan.arrive_earliest, null);
  assert.equal(result.plan.bag_type, 'overhead');
  assert.ok(result.warnings.some(x => /Flexible windows/i.test(x)));
});
test('missing dates remain null rather than being guessed', () => {
  const p = plan(); p.depart_earliest = null; p.depart_latest = null;
  const {plan:validated,warnings} = validateTripPlan(p);
  assert.equal(validated.depart_earliest,null);
  assert.ok(warnings.some(x => /incomplete/i.test(x)));
});
test('rejects invalid dates and mismatched date windows', () => {
  assert.throws(()=>validateTripPlan({...plan(),depart_earliest:'2027-02-31'}));
  assert.throws(()=>validateTripPlan({...plan(),depart_earliest:'2027-03-01'}));
});
test('rejects invalid airport or bag dimension', () => {
  assert.throws(()=>validateTripPlan({...plan(),origin:'SFO'}));
  assert.throws(()=>validateTripPlan({...plan(),bag_weight_kg:-1}));
});
test('unknowns retain old form values, and known dates are applied correctly',()=>{
  const current={origin:'MAD',preferred:'TFN',destination:'BCN',startDate:'2027-01-01',endDate:'2027-01-10',request:'notes'};
  const bag={name:'My pack',length:55,width:40,depth:25,kg:9};
  const p=plan();p.destination=null;p.bag_length_cm=52;
  const result=applyPlanToForm(p,current,bag);
  assert.equal(result.trip.origin,'BCN');
  assert.equal(result.trip.destination,'BCN'); // not overridden by null
  assert.equal(result.trip.startDate,'2027-02-02');
  assert.equal(result.trip.endDate,'2027-02-10');
  assert.equal(result.bag.length,52);
  assert.equal(result.bag.width,40);
  assert.ok(result.retained.includes('destination'));
});
test('mocked Groq call uses strict JSON schema and never embeds a key in the extension', async()=>{
  let seen, url, headers;
  const fetchImpl = async (u, options)=>{
    url=u;
    headers=options.headers;
    seen=JSON.parse(options.body);
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan())}}]})};
  };
  const result=await parseWithGroq('Barcelona to La Palma then Madrid',{apiKey:'test-groq-key',fetchImpl});
  assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(headers.Authorization,'Bearer test-groq-key');
  assert.equal(seen.response_format.json_schema.strict,true);
  assert.equal(seen.model,'openai/gpt-oss-20b');
  assert.equal(seen.messages[1].content,'Barcelona to La Palma then Madrid');
  assert.equal(result.plan.preferred,'SPC');
});
test('Groq API errors are sanitized and missing keys rejected',async()=>{
  await assert.rejects(()=>parseWithGroq('something',{apiKey:'',fetchImpl:async()=>({})}),/GROQ_API_KEY/);
  await assert.rejects(()=>parseWithGroq('something',{apiKey:'test',fetchImpl:async()=>({ok:false,status:401})}),/authentication failed/);
  await assert.rejects(()=>parseWithGroq('something',{apiKey:'test',fetchImpl:async()=>({ok:false,status:429})}),/rate limit/);
});
test('rejects an incomplete Groq response instead of accepting partial results',async()=>{
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:JSON.stringify(plan())}}]})});
  await assert.rejects(()=>parseWithGroq('Barcelona to Madrid',{apiKey:'test',fetchImpl}),/incomplete/);
});
test('country-only destination is preserved without inventing Lisbon or retaining La Palma', () => {
  const p = plan();
  p.preferred = null;
  p.requested_regions = ['Portugal'];
  p.alternate_stops = [];
  const {plan:validated,warnings} = validateTripPlan(p);
  assert.deepEqual(validated.requested_regions,['Portugal']);
  assert.equal(validated.preferred,null);
  assert.ok(warnings.some(x => /region was specified/i.test(x)));
  const current = {origin:'BCN',preferred:'SPC',destination:'MAD',requestedRegion:'Canary Islands',startDate:'2027-02-02',endDate:'2027-02-10'};
  const applied = applyPlanToForm(validated,current,{});
  assert.equal(applied.trip.requestedRegion,'Portugal');
  assert.equal(applied.trip.preferred,'');
});
test('invalid country/region lists are rejected', () => {
  assert.throws(()=>validateTripPlan({...plan(),requested_regions:'Portugal'}),/regions/);
  assert.throws(()=>validateTripPlan({...plan(),requested_regions:['']}),/regions/);
});
