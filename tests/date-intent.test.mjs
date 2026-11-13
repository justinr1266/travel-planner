import test from 'node:test';
import assert from 'node:assert/strict';
import {extractDateIntent} from '../date-intent.mjs';
import {normalizeTripWithDiagnostics,DEMO_PLAN,validateTripPlan} from '../trip-parser.mjs';
import {parseWithGroq} from '../server.mjs';

const referenceDate='2026-11-12';
const modelPlan=()=>({...structuredClone(DEMO_PLAN),origin:null,preferred:null,destination:null,
  requested_regions:['Sweden'],destination_search:'specified',depart_earliest:null,
  depart_latest:null,arrive_earliest:null,arrive_latest:null,fixed_departure:null,
  fixed_arrival:null,questions:[]});

test('Sweden Jan 21–24 weekend uses the next occurrence without asking for year confirmation',()=>{
  const request='I want to go on a weekend trip to Sweden from January 21 to January 24, starting and ending in Milan';
  const outcome=normalizeTripWithDiagnostics(request,modelPlan(),{referenceDate});
  const {plan,warnings}=validateTripPlan(outcome.plan);
  assert.equal(plan.origin,'MIL');
  assert.equal(plan.destination,'MIL');
  assert.deepEqual(plan.requested_regions,['Sweden']);
  assert.equal(plan.destination_search,'region');
  assert.equal(plan.preferred,null);
  assert.deepEqual([plan.depart_earliest,plan.depart_latest,plan.arrive_earliest,plan.arrive_latest],
    ['2027-01-21','2027-01-21','2027-01-24','2027-01-24']);
  assert.equal(plan.fixed_departure,true);
  assert.equal(plan.fixed_arrival,true);
  assert.equal(outcome.yearInferred,true);
  assert.ok(!plan.questions.some(x=>/confirm.*year/i.test(x)));
  assert.ok(warnings.some(x=>/airport directory/i.test(x)));
  assert.ok(outcome.corrections.some(x=>x.field==='depart_earliest'));
});

test('date range with explicit year needs no inferred-year warning',()=>{
  const parsed=extractDateIntent('Visit Sweden from January 21 to January 24, 2027',{referenceDate});
  assert.equal(parsed.fields.depart_earliest,'2027-01-21');
  assert.equal(parsed.fields.arrive_latest,'2027-01-24');
  assert.equal(parsed.inferredYear,false);
  assert.deepEqual(parsed.notes,[]);
});

test('departure flexibility stays distinct from the final deadline',()=>{
  const parsed=extractDateIntent('Leave Barcelona February 2–4, 2027, and arrive in Madrid by February 10, 2027',{referenceDate});
  assert.deepEqual(parsed.fields,{
    depart_earliest:'2027-02-02',depart_latest:'2027-02-04',fixed_departure:false,
    arrive_earliest:null,arrive_latest:'2027-02-10',fixed_arrival:false
  });
});

test('separate outbound and exact return clauses retain their explicitly stated year',()=>{
  const parsed=extractDateIntent('Leave Barcelona January 11 and finish in Madrid on January 18, 2027',{referenceDate});
  assert.equal(parsed.fields.depart_earliest,'2027-01-11');
  assert.equal(parsed.fields.arrive_latest,'2027-01-18');
  assert.equal(parsed.fields.fixed_arrival,true);
  assert.equal(parsed.inferredYear,false);
});

test('dates in a different year are never silently assigned to an invalid date',()=>{
  const parsed=extractDateIntent('From February 30 to March 5',{referenceDate});
  assert.equal(parsed.fields.depart_earliest,undefined);
});

test('open-ended destination clears hallucinated region and prior named stop',()=>{
  const model={...modelPlan(),preferred:'LIS',requested_regions:['Sweden']};
  const result=normalizeTripWithDiagnostics('Starting and ending in Milan, any fun weekend destination January 21 to January 24',model,{referenceDate});
  assert.equal(result.plan.destination_search,'open');
  assert.equal(result.plan.preferred,null);
  assert.deepEqual(result.plan.requested_regions,[]);
  assert.equal(result.plan.origin,'MIL');
  assert.equal(result.plan.destination,'MIL');
});

test('model raw values remain separate from corrected values in diagnostic response',async()=>{
  const bad=modelPlan();
  const request='I want to go on a weekend trip to Sweden from January 21 to January 24, starting and ending in Milan';
  let auth;
  const fetchImpl=async (url,opts)=>{
    auth=opts.headers.Authorization;
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(bad)}}]})};
  };
  const result=await parseWithGroq(request,{apiKey:'dummy-key',referenceDate,fetchImpl});
  assert.equal(result.plan.depart_earliest,'2027-01-21');
  assert.equal(result.debug.rawModel.depart_earliest,null);
  assert.equal(result.debug.referenceDate,referenceDate);
  assert.equal(result.debug.yearInferred,true);
  assert.equal(result.debug.corrections.find(x=>x.field==='depart_earliest').normalized,'2027-01-21');
  assert.equal(auth,'Bearer dummy-key');
  assert.ok(!JSON.stringify(result.debug).includes('dummy-key'));
});

test('does not manufacture dates when the user provides none',()=>{
  const result=extractDateIntent('I want to visit Sweden when flights are inexpensive',{referenceDate});
  assert.deepEqual(result.fields,{});
  assert.equal(result.inferredYear,false);
});


test('next-occurrence default chooses December 2026 after a November 2026 reference',()=>{
  const result=extractDateIntent('From December 5 to December 8',{referenceDate});
  assert.equal(result.fields.depart_earliest,'2026-12-05');
  assert.equal(result.fields.arrive_latest,'2026-12-08');
  assert.equal(result.inferredYear,true);
  assert.deepEqual(result.notes,[]);
});

test('next-occurrence default carries New Year across an unspecified-year range',()=>{
  const result=extractDateIntent('Trip from December 30 to January 2',{referenceDate});
  assert.deepEqual([result.fields.depart_earliest,result.fields.arrive_latest],['2026-12-30','2027-01-02']);
});

test('explicitly provided year always takes precedence',()=>{
  const result=extractDateIntent('Trip from January 21, 2028 to January 24, 2028',{referenceDate});
  assert.deepEqual([result.fields.depart_earliest,result.fields.arrive_latest],['2028-01-21','2028-01-24']);
  assert.equal(result.inferredYear,false);
});

test('unspecified year on a date that is today uses today',()=>{
  const result=extractDateIntent('Leave on November 12, return November 15',{referenceDate});
  assert.equal(result.fields.depart_earliest,'2026-11-12');
  assert.equal(result.fields.arrive_latest,'2026-11-15');
});
