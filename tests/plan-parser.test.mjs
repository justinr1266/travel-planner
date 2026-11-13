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
  assert.ok(validateTripPlan({...plan(),origin:'NOT_A_REAL_AIRPORT_CODE'}).warnings.some(w=>/airport directory/i.test(w))); // Always invalid, even after worldwide airport sync
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
test('Groq cannot invent a minimum-night stay when the request never mentions nights',async()=>{
  const raw={...plan(),origin:'BCN',destination:'BCN',preferred:null,
    requested_regions:['Sweden'],destination_search:'region',min_nights_at_preferred:1};
  const request='From Barcelona, explore Sweden January 21 to January 24.';
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{
    finish_reason:'stop',message:{content:JSON.stringify(raw)}
  }]})});
  const result=await parseWithGroq(request,{apiKey:'test',fetchImpl,referenceDate:'2026-11-12'});
  assert.equal(result.plan.min_nights_at_preferred,null);
  assert.ok(result.debug.corrections.some(change=>change.field==='min_nights_at_preferred' && change.normalized===null));
});
test('An explicitly mentioned nights constraint is preserved for discovery',async()=>{
  const raw={...plan(),origin:'BCN',destination:'BCN',preferred:null,
    requested_regions:['Sweden'],destination_search:'region',min_nights_at_preferred:2};
  const request='Explore Sweden for at least two nights between January 21 and January 24.';
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{
    finish_reason:'stop',message:{content:JSON.stringify(raw)}
  }]})});
  const result=await parseWithGroq(request,{apiKey:'test',fetchImpl,referenceDate:'2026-11-12'});
  assert.equal(result.plan.min_nights_at_preferred,2);
});
test('invalid country/region lists are rejected', () => {
  assert.throws(()=>validateTripPlan({...plan(),requested_regions:'Portugal'}),/regions/);
  assert.throws(()=>validateTripPlan({...plan(),requested_regions:['']}),/regions/);
});

test('Explicit maximum destination time and exact on-date survive AI misclassification', async () => {
  const request = "I'm starting in Barcelona and want to visit La Palma, spending as much time as possible there, before ending in Madrid on January 18, 2027. I want to leave Barcelona January 11.";
  const wrongAI=plan();
  wrongAI.depart_earliest='2027-01-11';wrongAI.depart_latest='2027-01-11';
  wrongAI.arrive_earliest=null;wrongAI.arrive_latest='2027-01-18';
  wrongAI.fixed_arrival=false;wrongAI.priority='unspecified';
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(wrongAI)}}]})});
  const {plan:extracted}=await parseWithGroq(request,{apiKey:'test-key',fetchImpl});
  assert.equal(extracted.priority,'more_time_at_preferred');
  assert.equal(extracted.fixed_arrival,true);
  assert.equal(extracted.arrive_earliest,'2027-01-18');
  const applied=applyPlanToForm(extracted,{origin:'BCN',preferred:'SPC',destination:'MAD',requestedRegion:'Canary Islands',goal:'balance',arrivalRule:'by'},{});
  assert.equal(applied.trip.goal,'more_time_at_preferred');
  assert.equal(applied.trip.arrivalRule,'fixed');
});

test('A true by-date deadline remains flexible',async()=>{
  const request='Leave Barcelona January 11, 2027, spend as much time as possible in La Palma, but arrive in Madrid by January 18, 2027.';
  const wrongAI={...plan(),depart_earliest:'2027-01-11',depart_latest:'2027-01-11',arrive_latest:'2027-01-18',arrive_earliest:null,fixed_arrival:false};
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(wrongAI)}}]})});
  const {plan:extracted}=await parseWithGroq(request,{apiKey:'test-key',fetchImpl});
  assert.equal(extracted.fixed_arrival,false);
  assert.equal(extracted.arrive_earliest,null);
});

test('Unspecified priority defaults to time-first without changing a deliberate user goal',()=>{
  const p=plan();p.priority='unspecified';
  const previous={origin:'BCN',preferred:'SPC',destination:'MAD',goal:'lowest_cost',arrivalRule:'fixed'};
  const applied=applyPlanToForm(p,previous,{});
  assert.equal(applied.trip.goal,'lowest_cost');
  assert.equal(applied.trip.arrivalRule,'by');
});


test('Returning from an island on a date does not change a different final-city arrival deadline', async () => {
  const request='Returning from La Palma on January 17, but arrive in Madrid by January 18, 2027.';
  const wrongAI={...plan(),depart_earliest:'2027-01-11',depart_latest:'2027-01-11',arrive_latest:'2027-01-18',arrive_earliest:null,fixed_arrival:false};
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(wrongAI)}}]})});
  const {plan:extracted}=await parseWithGroq(request,{apiKey:'test-key',fetchImpl});
  assert.equal(extracted.fixed_arrival,false);
  assert.equal(extracted.arrive_earliest,null);
});

test('An AI fixed arrival with no earliest date normalizes to the exact known latest date',async()=>{
  const request='Finish in Madrid on January 18, 2027.';
  const wrongAI={...plan(),depart_earliest:'2027-01-11',depart_latest:'2027-01-11',arrive_latest:'2027-01-18',arrive_earliest:null,fixed_arrival:true};
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(wrongAI)}}]})});
  const {plan:extracted}=await parseWithGroq(request,{apiKey:'test-key',fetchImpl});
  assert.equal(extracted.arrive_earliest,'2027-01-18');
});

test('Open-ended Milan weekend request survives missing endpoint and return from Groq',async()=>{
  const request = "I'm starting in Milan and want to visit any cool vacation spots on my weekend abroad. i want to leave on january 21 and get back to milan on january 24";
  const poorAI={...plan(),origin:null,preferred:null,destination:null,destination_search:'specified',
    requested_regions:[],depart_earliest:'2027-01-21',depart_latest:'2027-01-21',
    arrive_earliest:null,arrive_latest:null,fixed_departure:true,fixed_arrival:null,
    questions:[],priority:'unspecified'};
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(poorAI)}}]})});
  const {plan:extracted,warnings}=await parseWithGroq(request,{apiKey:'test',fetchImpl});
  assert.equal(extracted.origin,'MIL');
  assert.equal(extracted.destination,'MIL');
  assert.equal(extracted.preferred,null);
  assert.equal(extracted.destination_search,'open');
  assert.equal(extracted.depart_earliest,'2027-01-21');
  assert.equal(extracted.arrive_latest,'2027-01-24');
  assert.equal(extracted.arrive_earliest,'2027-01-24');
  assert.equal(extracted.fixed_arrival,true);
  assert.ok(!extracted.questions.some(q=>/confirm.*year/i.test(q)));
  assert.ok(warnings.some(w=>/Destination suggestions/i.test(w)));
  const applied=applyPlanToForm(extracted,{origin:'BCN',destination:'MAD',preferred:'SPC',requestedRegion:'Canary Islands',goal:'balance',arrivalRule:'by',startDate:'2027-02-02',endDate:'2027-02-10'},{});
  assert.equal(applied.trip.origin,'MIL');
  assert.equal(applied.trip.destination,'MIL');
  assert.equal(applied.trip.preferred,'');
  assert.equal(applied.trip.destinationSearch,'open');
  assert.equal(applied.trip.endDate,'2027-01-24');
  assert.equal(applied.trip.arrivalRule,'fixed');
});

test('Explicit named La Palma trip remains specified, not open-ended',async()=>{
  const request='Starting in Barcelona, visit La Palma and finish in Madrid by January 18, 2027.';
  const source={...plan(),destination_search:'specified',depart_earliest:'2027-01-11',depart_latest:'2027-01-11',arrive_latest:'2027-01-18',arrive_earliest:null,fixed_arrival:false};
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(source)}}]})});
  const {plan:extracted}=await parseWithGroq(request,{apiKey:'test',fetchImpl});
  assert.equal(extracted.destination_search,'specified');
  assert.equal(extracted.fixed_arrival,false);
});

test('Open-ended request clears a destination guessed by the model', async()=>{
  const request='Starting in Milan, any cool weekend vacation spots, returning to Milan on January 24, 2027; leaving January 21, 2027.';
  const incorrect={...plan(),origin:'MIL',destination:'MIL',preferred:'LIS',requested_regions:[],
    destination_search:'specified',depart_earliest:'2027-01-21',depart_latest:'2027-01-21',
    arrive_earliest:null,arrive_latest:null,fixed_arrival:false};
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(incorrect)}}]})});
  const {plan:extracted}=await parseWithGroq(request,{apiKey:'test',fetchImpl});
  assert.equal(extracted.destination_search,'open');
  assert.equal(extracted.preferred,null);
  assert.equal(extracted.arrive_latest,'2027-01-24');
});


test('applying a country-only trip preserves region discovery mode',()=>{
  const s={...plan(),origin:'MIL',preferred:null,destination:'MIL',requested_regions:['Sweden'],destination_search:'region'};
  const result=applyPlanToForm(s,{origin:'MIL',destination:'MIL',preferred:'SPC',requestedRegion:'Canary Islands',destinationSearch:'specified'},{});
  assert.equal(result.trip.destinationSearch,'region');
  assert.equal(result.trip.requestedRegion,'Sweden');
  assert.equal(result.trip.preferred,'');
});

test('explicit La Palma remains primary across six inconsistent Groq responses', async()=>{
  const request='I want to go to La Palma from january 11th to january 18th, starting in Barcelona and ending in madrid.';
  const variants=['SPC','Menongue','TFN','TFS','La Palma','LIS'];
  for(const modelPreferred of variants) {
    const raw={...plan(),origin:'Barcelona',destination:'Madrid',preferred:modelPreferred,
      requested_regions:[],destination_search:'specified',priority:'unspecified',
      depart_earliest:'2026-01-11',depart_latest:'2026-01-11',
      arrive_earliest:'2026-01-18',arrive_latest:'2026-01-18',
      fixed_departure:true,fixed_arrival:true};
    const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]})});
    const result=await parseWithGroq(request,{apiKey:'test',fetchImpl,referenceDate:'2026-11-12'});
    assert.equal(result.plan.origin,'BCN',`origin with model preferred ${modelPreferred}`);
    assert.equal(result.plan.destination,'MAD',`end with model preferred ${modelPreferred}`);
    assert.equal(result.plan.preferred,'SPC',`preferred with model preferred ${modelPreferred}`);
    assert.equal(result.plan.destination_search,'specified');
    assert.equal(result.plan.depart_earliest,'2027-01-11');
    assert.equal(result.plan.arrive_latest,'2027-01-18');
    if(modelPreferred!=='SPC') {
      const correction=result.debug.corrections.find(c=>c.field==='preferred');
      assert.equal(correction.source,'explicit traveler destination');
      assert.match(correction.evidence,/go to La Palma/i);
    }
  }
});

test('explicit named vacation beats unrelated Groq suggestion even when the request includes open-ended words',async()=>{
  const raw={...plan(),origin:'BCN',destination:'MAD',preferred:'TFN',requested_regions:[],destination_search:'open'};
  const request='I want to visit La Palma, and I am open to any cool stops along the way, starting in Barcelona and ending in Madrid.';
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(raw)}}]})});
  const {plan:extracted}=await parseWithGroq(request,{apiKey:'test',fetchImpl});
  assert.equal(extracted.preferred,'SPC');
  assert.equal(extracted.destination_search,'specified');
});
