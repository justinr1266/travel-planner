import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGroundRequest,normalizeGoogleTransit,researchGoogleTransit,createGoogleGroundServer,GROUND_FIELD_MASK}
  from '../google-ground-proxy.mjs';
import {localTransitTimeToISO,validDatedTransitResult,suggestedTransferTime,collectTransferLegs}
  from '../google-ground-routes.mjs';

const airport={from:'BCN',to:'station:1',mode:'transfer',date:'2027-01-11',key:'BCN|station:1|2027-01-11|transfer'};
const train={mode:'train',evidence:'gtfs_scheduled',departureLocal:'2027-01-11 12:45',
  arrivalLocal:'2027-01-11 15:25',scheduleTimezone:'Europe/Madrid'};
const JAN11='2027-01-11T08:00:00.000Z';
const NOW=Date.parse('2026-11-17T15:00:00Z');

test('transit date conversion uses station timezone instead of travelers browser zone',()=>{
  assert.equal(localTransitTimeToISO('2027-01-11T09:00','Europe/Madrid'),JAN11);
  assert.equal(localTransitTimeToISO('2027-07-11T09:00','Europe/Madrid'),'2027-07-11T07:00:00.000Z');
  assert.throws(()=>localTransitTimeToISO('2027-03-28T02:30','Europe/Madrid'),/does not exist/);
  assert.throws(()=>localTransitTimeToISO('2027-01-11T09:00','Invalid/Zone'),/IANA/);
});

test('date-specific transfer adjacent to scheduled train derives the correct target direction',()=>{
  const before=suggestedTransferTime({legs:[airport,train]},0);
  assert.equal(before.timeKind,'arrival');
  assert.equal(before.localTime,'2027-01-11T12:45');
  assert.equal(before.timeZone,'Europe/Madrid');
  const after=suggestedTransferTime({legs:[train,airport]},1);
  assert.equal(after.timeKind,'departure');
  assert.equal(after.localTime,'2027-01-11T15:25');
  assert.equal(collectTransferLegs([{legs:[airport,train]},{legs:[airport]}]).length,1);
});

test('Google transit request does not include intermediate waypoints or invented fare settings',()=>{
  const body=buildGroundRequest({origin:'Barcelona Airport',destination:'Barcelona Sants',
    time:JAN11,timeKind:'arrival'},{now:NOW});
  assert.deepEqual(body.origin,{address:'Barcelona Airport'});
  assert.equal(body.travelMode,'TRANSIT');
  assert.equal(body.arrivalTime,JAN11);
  assert.equal(body.departureTime,undefined);
  assert.equal(body.intermediates,undefined);
  assert.match(GROUND_FIELD_MASK,/transitFare/);
  assert.throws(()=>buildGroundRequest({origin:'X',destination:'Y',time:'2027-12-01T12:00:00Z',timeKind:'departure'},{now:NOW}),/100 days/);
});

test('fare absent stays unknown, and non-EUR provider fares do not become EUR trip totals',()=>{
  const without=normalizeGoogleTransit({routes:[{duration:'1800s',legs:[]}]},'2027-01-11');
  assert.equal(without.routes[0].fare,null);
  const record={fare:null,dated:true,acceptedForComparison:true,requestedDate:'2027-01-11'};
  assert.equal(validDatedTransitResult(airport,record),false);
  assert.equal(validDatedTransitResult(airport,{...record,fare:{amount:4.2,currencyCode:'GBP'}}),false);
  assert.equal(validDatedTransitResult(airport,{...record,fare:{amount:4.2,currencyCode:'EUR'}}),true);
  assert.equal(validDatedTransitResult(airport,{...record,acceptedForComparison:false,fare:{amount:4.2,currencyCode:'EUR'}}),false);
  assert.equal(validDatedTransitResult(airport,{...record,requestedDate:'2027-01-12',fare:{amount:4.2,currencyCode:'EUR'}}),false);
});

test('response strips API key and provides only requested transit duration and fare',async()=>{
  let sent;
  const fake=async(url,options)=>{sent={url,options};return {ok:true,json:async()=>({routes:[{duration:'2360s',distanceMeters:10400,
    travelAdvisory:{transitFare:{currencyCode:'EUR',units:'5',nanos:500000000}},
    legs:[{steps:[{travelMode:'TRANSIT',transitDetails:{transitLine:{nameShort:'R2',vehicle:{type:'HEAVY_RAIL'}},
      stopDetails:{departureStop:{name:'Airport'},arrivalStop:{name:'Sants'},departureTime:JAN11}}}]}]}]})}};
  const result=await researchGoogleTransit({origin:'Airport',destination:'Station',localDate:'2027-01-11',time:JAN11,timeKind:'departure'},
    {apiKey:'SECRET-DO-NOT-RETURN',fetchImpl:fake,now:NOW});
  assert.equal(result.routes[0].fare.amount,5.5);
  assert.equal(result.routes[0].durationMinutes,39);
  assert.equal(result.routes[0].transit[0].line,'R2');
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
  assert.equal(sent.options.headers['X-Goog-FieldMask'],GROUND_FIELD_MASK);
});

test('HTTP proxy only accepts Chrome extension origins and returns no-store',async()=>{
  const server=createGoogleGroundServer({apiKey:'fake',fetchImpl:async()=>({ok:true,json:async()=>({routes:[]})})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/ground-transit`;
    const body=JSON.stringify({origin:'Barcelona Airport',destination:'Barcelona Sants',localDate:'2027-01-11',time:JAN11,timeKind:'departure'});
    const origin='chrome-extension://'+'a'.repeat(32);
    const invalid=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});
    assert.equal(invalid.status,403);
    const valid=await fetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body});
    assert.equal(valid.status,200);
    assert.equal(valid.headers.get('cache-control'),'no-store');
    assert.equal((await valid.json()).found,false);
  }finally{server.close();}
});
