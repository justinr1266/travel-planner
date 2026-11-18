import test from 'node:test';
import assert from 'node:assert/strict';
import {trainResultFingerprint,matchingTrainJourneys,waitForStableTrainResults} from '../train-import-readiness.mjs';

const journey=(fare='€19')=>({fromStation:'Barcelona Sants',toStation:'Valencia-Estacio Del Nord',
  departureText:'7:15 AM',arrivalText:'10:10 AM',priceText:fare,provider:'Renfe'});
const page=(journeys=[journey()],extras={})=>({ok:true,sourceUrl:'https://www.omio.com/links/sample',
  readyState:'complete',tabComplete:true,cardSource:'omio_result_cards',journeys,...extras});

function fakeClock(){
  let time=0;
  return {now:()=>time,sleep:async ms=>{time+=ms;},time:()=>time};
}

test('no response or partially loaded tab cannot produce a ready train capture',async()=>{
  const clock=fakeClock();
  const responses=[null,page([journey()],{readyState:'interactive'}),page([journey()],{tabComplete:false}),page([journey()],{pageBusy:true})];
  let calls=0;
  const result=await waitForStableTrainResults({
    read:async()=>responses[calls++]||null,now:clock.now,sleep:clock.sleep,
    timeoutMs:6000,pollMs:1000,settleMs:2000,stableReads:2
  });
  assert.equal(result.status,'timeout');
  assert.equal(trainResultFingerprint(page([],{})),null);
});

test('late arriving Omio journeys reset the stabilization clock',async()=>{
  const clock=fakeClock();
  const initial=page([journey('€46')]);
  const final=page([journey('€46'),journey('€19')]);
  let calls=0;
  const result=await waitForStableTrainResults({
    read:async()=>calls++<3?initial:final,now:clock.now,sleep:clock.sleep,
    timeoutMs:25000,pollMs:1000,settleMs:4000,stableReads:3
  });
  assert.equal(result.status,'ready');
  assert.deepEqual(result.capture.journeys,final.journeys);
  assert.ok(clock.time()>=6000,'must wait for the FINAL results to stabilize');
});

test('price changes reset the stabilization clock, not just card count',async()=>{
  const clock=fakeClock();
  let calls=0;
  const result=await waitForStableTrainResults({
    read:async()=>calls++<4?page([journey('€46')]):page([journey('€39')]),
    now:clock.now,sleep:clock.sleep,timeoutMs:25000,pollMs:1000,settleMs:4000,stableReads:3
  });
  assert.equal(result.status,'ready');
  assert.equal(result.capture.journeys[0].priceText,'€39');
  assert.ok(clock.time()>=8000);
});

test('redirect or transient capture failure resets the stabilization clock',async()=>{
  const clock=fakeClock();
  let calls=0;
  const result=await waitForStableTrainResults({
    read:async()=>{calls++;if(calls===4)throw new Error('Navigating');return page();},
    now:clock.now,sleep:clock.sleep,timeoutMs:25000,pollMs:1000,settleMs:4000,stableReads:3
  });
  assert.equal(result.status,'ready');
  assert.ok(clock.time()>=7000);
});

test('stop interrupts the wait without recording a fare',async()=>{
  const clock=fakeClock();
  let calls=0;
  const result=await waitForStableTrainResults({
    read:async()=>{calls++;return null;},
    shouldStop:()=>calls>=3,now:clock.now,sleep:clock.sleep,
    timeoutMs:25000,pollMs:1000
  });
  assert.equal(result.status,'stopped');
  assert.equal(calls,3);
});

test('non-journey fallbacks do not count as finished Omio results',()=>{
  assert.equal(trainResultFingerprint(page([],{cardSource:'text_fallback',cards:['€19 from nearby'] })),null);
  assert.equal(trainResultFingerprint(page([],{cardSource:'omio_result_cards'})),null);
});

const requested={mode:'train',fromLabel:'Barcelona Sants',toLabel:'Valencia-Estacio Del Nord',date:'2027-01-11'};
test('unrelated Omio fare changes do not stall a stabilized exact-station price',async()=>{
  const clock=fakeClock();let count=0;
  const matching=journey('€19');
  const result=await waitForStableTrainResults({task:requested,
    read:async()=>page([matching,{...journey(`€${40+count++}`),toStation:'Valencia-Joaquín Sorolla'}]),
    now:clock.now,sleep:clock.sleep,timeoutMs:20000,pollMs:1000,settleMs:4000,stableReads:3});
  assert.equal(result.status,'ready');
  assert.equal(matchingTrainJourneys(result.capture,requested).length,1);
  assert.ok(clock.time()>=4000);
});

test('changed fare at exact station still resets the stability timer',async()=>{
  const clock=fakeClock();let count=0;
  const result=await waitForStableTrainResults({task:requested,
    read:async()=>page([journey(count++<3?'€20':'€19'),{...journey('€43'),toStation:'Valencia-Joaquín Sorolla'}]),
    now:clock.now,sleep:clock.sleep,timeoutMs:20000,pollMs:1000,settleMs:4000,stableReads:3});
  assert.equal(result.status,'ready');
  assert.equal(result.capture.journeys[0].priceText,'€19');
  assert.ok(clock.time()>=6000);
});

test('perpetually changing cards are returned for review, not auto-saved',async()=>{
  const clock=fakeClock();let count=0;
  const result=await waitForStableTrainResults({task:requested,
    read:async()=>page([journey(`€${20+count++}`)]),
    now:clock.now,sleep:clock.sleep,timeoutMs:5500,pollMs:1000,settleMs:3000,stableReads:2});
  assert.equal(result.status,'review');
  assert.ok(result.capture.journeys.length);
});
