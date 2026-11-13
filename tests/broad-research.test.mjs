import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {researchTasks,researchKey,captureBroadSearch,researchAge,estimateRoute,compareBroadRoutes,TRAIN_ESTIMATE_EUR,MAX_BROAD_OPTIONS} from '../broad-research.mjs';
import {buildRoundTripTicket} from '../roundtrip-tickets.mjs';

const flight=(from,to,date)=>({mode:'flight',from,to,date,key:`${from}|${to}|${date}|flight`});
const train=(from,to,date)=>({mode:'train',from,to,date,key:`${from}|${to}|${date}|train`});
const outbound=flight('MAD','SPC','2027-01-11'),returning=flight('SPC','MAD','2027-01-18');
const ground=train('BCN','MAD','2027-01-11');
const route={id:'train-to-island',name:'Via Madrid train',legs:[ground,outbound,returning],primaryStay:{destination:'SPC'}};
const direct={id:'direct',name:'Direct to island',legs:[flight('BCN','SPC','2027-01-11'),returning],primaryStay:{destination:'SPC'}};
const job={key:researchKey(outbound),leg:outbound};
const card=(from,to,date,departure,arrival,price,scope='one_way_search_quote',carrier='Iberia',offset=0,duration='3 hr 5 min')=>
  `<li data-routewise-from="${from}" data-routewise-to="${to}" data-routewise-date="${date}" data-routewise-departure="${departure}" data-routewise-arrival="${arrival}" data-routewise-arrival-offset="${offset}" data-routewise-carrier="${carrier}" data-routewise-stops="0" data-routewise-price="${price}" data-routewise-price-scope="${scope}" data-routewise-duration="${duration}"></li>`;
const capture=(...html)=>({text:html.join('\n'),captureMode:'page',sourceUrl:'https://www.google.com/travel/flights/search'});
const stored=(leg,options)=>({key:researchKey(leg),capturedAt:'2026-11-13T05:00:00Z',
  options:options.map(([dep,arr,eur,offset=0])=>({date:leg.date,from:leg.from,to:leg.to,departureClock:dep,
    arrivalClock:arr,estimatedEur:eur,arrivalDayOffset:offset,carrier:'Test',duration:'3 hr 5 min'}))});

test('unique one-way search jobs are reused across routes and separate return dates',()=>{
  const work=researchTasks([route,{...route,id:'copy'},direct]);
  assert.equal(work.length,3);
  assert.equal(work.find(x=>x.key===researchKey(outbound)).routeCount,2);
  assert.equal(work.find(x=>x.key===researchKey(returning)).routeCount,3);
  assert.equal(work.find(x=>x.key===researchKey(direct.legs[0])).routeCount,1);
  assert.equal(researchKey({...outbound,mode:'train'}),null);
  assert.notEqual(researchKey(outbound),researchKey({...outbound,date:'2027-01-12'}));
});
test('one-way Best cards are cached with actual date and indicative quotes, capped at five',()=>{
  const sample=capture(...Array.from({length:7},(_,i)=>card('MAD','SPC','2027-01-11',`${String(9+i).padStart(2,'0')}:00`,'20:00',90+i)));
  const record=captureBroadSearch(sample,job,{now:'2026-11-13T05:00:00Z'});
  assert.equal(record.options.length,MAX_BROAD_OPTIONS);
  assert.equal(record.resultCount,7);
  assert.deepEqual(record.options.map(x=>x.estimatedEur),[90,91,92,93,94]);
  assert.equal(record.options[0].priceScope,'one_way_indicative');
  assert.equal(record.quoteStatus,'indicative');
  assert.ok(!Object.hasOwn(record.options[0],'checkedAt'));
});
test('unknown price context requires explicit user confirmation and is never verified',()=>{
  const unlabeled=capture(card('MAD','SPC','2027-01-11','12:00','15:00',82,'displayed_search_quote'));
  assert.throws(()=>captureBroadSearch(unlabeled,job),/Confirm.*ONE-WAY/);
  const record=captureBroadSearch(unlabeled,job,{confirmOneWay:true});
  assert.equal(record.options[0].estimatedEur,82);
  assert.equal(record.quoteStatus,'indicative');
});
test('round-trip search quotes cannot enter a one-way cache even if user checks confirmation',()=>{
  const twoWay=capture(card('MAD','SPC','2027-01-11','11:30','13:35',163,'round_trip_search_quote'));
  assert.throws(()=>captureBroadSearch(twoWay,job,{confirmOneWay:true}),/round-trip/);
  const unrelated=capture(card('BCN','SPC','2027-01-11','11:30','13:35',89));
  assert.throws(()=>captureBroadSearch(unrelated,job),/do not match/);
  const wrongDay=capture(card('MAD','SPC','2027-01-12','11:30','13:35',89));
  assert.throws(()=>captureBroadSearch(wrongDay,job),/do not match/);
});
test('repeated matching result cards are de-duplicated but different marketed flights remain separate',()=>{
  const first=card('MAD','SPC','2027-01-11','11:30','13:35',82);
  const record=captureBroadSearch(capture(first,first,card('MAD','SPC','2027-01-11','11:30','13:35',87,'one_way_search_quote','Iberia Express')),job);
  assert.equal(record.options.length,2);
});
test('€20 train estimate plus cheapest feasible one-way flight quotes yields indicative total',()=>{
  const cache={
    [researchKey(outbound)]:stored(outbound,[['07:00','10:30',65],['14:30','17:00',100],['16:40','20:30',90]]),
    [researchKey(returning)]:stored(returning,[['14:15','18:05',82]])
  };
  const result=estimateRoute(route,cache,{},{});
  assert.equal(result.total,167); // €20 + €65 + €82; timetable unavailable, so no buffer assumed
  assert.equal(result.trainCount,1);
  assert.equal(result.estimatedCount,3);
  assert.equal(result.missing,0);
  assert.equal(result.complete,true);
  assert.equal(result.selected[1].option.departureClock,'07:00'); // no ground time; do NOT invent buffer checks
  assert.equal(result.uncheckedConnections,1);
  assert.equal(TRAIN_ESTIMATE_EUR,20);
});
test('known ground timetable excludes cheap flights departing before the buffer',()=>{
  const scheduled={...ground,evidence:'gtfs_scheduled',arrivalLocal:'2027-01-11 11:00',
    scheduleTimezone:'Europe/Madrid'};
  const r={...route,legs:[scheduled,outbound,returning]};
  const cache={
    [researchKey(outbound)]:stored(outbound,[['07:00','10:30',65],['14:30','17:00',100],['16:40','20:30',90]]),
    [researchKey(returning)]:stored(returning,[['14:15','18:05',82]])
  };
  const result=estimateRoute(r,cache,{}, {},{bufferMinutes:180});
  assert.equal(result.selected[1].option.departureClock,'16:40');
  assert.equal(result.total,192);
  assert.equal(result.uncheckedConnections,0);
  assert.equal(result.destinationHours,161.8); // arrival 20:30 Jan 11, departure 14:15 Jan 18
});
test('all flight candidates below a verified connection buffer leave the itinerary incomplete',()=>{
  const scheduled={...ground,evidence:'gtfs_scheduled',arrivalLocal:'2027-01-11 16:00',
    scheduleTimezone:'Europe/Madrid'};
  const r={...route,legs:[scheduled,outbound,returning]};
  const cache={[researchKey(outbound)]:stored(outbound,[['07:00','10:30',65],['14:30','17:00',100]])};
  const result=estimateRoute(r,cache,{}, {},{bufferMinutes:180});
  assert.equal(result.conflicts,1);
  assert.equal(result.missing,2);
  assert.equal(result.complete,false);
});
test('saved one-way fares supersede indicative quotes and linked round-trip tickets count once',()=>{
  const cache={
    [researchKey(outbound)]:stored(outbound,[['11:30','13:35',120]]),
    [researchKey(returning)]:stored(returning,[['14:15','18:05',82]])
  };
  const byLeg=estimateRoute(route,cache,{[outbound.key]:{fare:150,bagFee:10,transferCost:0}},{});
  assert.equal(byLeg.total,20+160+82);
  const accepted={totalEur:'123',seller:'Binter',confirmed:true,baggageVerified:true};
  const ticket=buildRoundTripTicket(accepted,outbound,returning);
  const paired=estimateRoute(route,cache,{[outbound.key]:{fare:150,bagFee:10,transferCost:0}}, {[ticket.id]:ticket});
  assert.equal(paired.total,143);
  assert.equal(paired.verifiedCount,1);
  assert.equal(paired.estimatedCount,1);
  assert.equal(paired.selected[1].kind,'verified_roundtrip');
  assert.equal(paired.selected[2].costEur,0);
});
test('missing transport costs remain incomplete rather than assigned a made-up price',()=>{
  const bus={mode:'bus',from:'BCN',to:'MAD',date:'2027-01-11',key:'BCN|MAD|2027-01-11|bus'};
  const r={id:'bus',legs:[bus,outbound]};
  const cache={[researchKey(outbound)]:stored(outbound,[['11:30','13:35',82]])};
  const result=estimateRoute(r,cache,{},{});
  assert.equal(result.total,null);
  assert.equal(result.known,82);
  assert.equal(result.missing,1);
});
test('complete routes rank by estimated totals and show approximate destination time only from matching dates',()=>{
  const cache={
    [researchKey(outbound)]:stored(outbound,[['11:30','13:35',100]]),
    [researchKey(returning)]:stored(returning,[['14:15','18:05',82]]),
    [researchKey(direct.legs[0])]:stored(direct.legs[0],[['09:00','12:45',130]])
  };
  const choices=compareBroadRoutes([direct,route],cache,{},{});
  assert.equal(choices[0].route.id,'train-to-island');
  assert.equal(choices[0].total,202);
  assert.equal(choices[0].destinationHours,168.7); // Jan 11 13:35 -> Jan 18 14:15
  assert.ok(choices[0].observedDurationMinutes>0);
});
test('cache freshness marks old quotes as stale without deleting them',()=>{
  const record={capturedAt:'2026-11-12T00:00:00Z'};
  assert.equal(researchAge(record,Date.parse('2026-11-12T23:00:00Z')),'fresh');
  assert.equal(researchAge(record,Date.parse('2026-11-13T02:00:00Z')),'stale');
});
test('browser workflow exposes research capture but does not save search prices as offers',()=>{
  const html=readFileSync(new URL('../panel.html',import.meta.url),'utf8');
  const panel=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  assert.match(html,/broadOpenNext/);assert.match(html,/broadCaptureTask/);assert.match(html,/broadConfirmOneWay/);
  assert.match(html,/Preliminary itinerary comparison/);
  assert.match(panel,/captureBroadSearch\(pendingFlightCapture,task/);
  assert.match(panel,/broadCache\[task.key\]=record/);
  assert.match(panel,/broadCache = saved.broadCache/);
  assert.doesNotMatch(panel,/offers\[task\.key\]\s*=/);
});
test('capture from exact RouteWise-opened one-way URL is a sufficient price-scope signal',async()=>{
  const {captureFromOpenedOneWaySearch}=await import('../broad-research.mjs');
  const {googleFlightsSearchUrl,googleFlightsRoundTripUrl}=await import('../search-links.mjs');
  const snap=capture(card('MAD','SPC','2027-01-11','11:30','13:35',82,'displayed_search_quote'));
  snap.sourceUrl=googleFlightsSearchUrl(outbound)+'&tfu=EgIIAA';
  assert.equal(captureFromOpenedOneWaySearch(snap,job),true);
  const result=captureBroadSearch(snap,job);
  assert.equal(result.options[0].estimatedEur,82);
  snap.sourceUrl=googleFlightsRoundTripUrl(outbound,returning);
  assert.equal(captureFromOpenedOneWaySearch(snap,job),false);
  assert.throws(()=>captureBroadSearch(snap,job),/Confirm.*ONE-WAY/);
  snap.sourceUrl='https://evil.example/travel/flights/search?'+new URL(googleFlightsSearchUrl(outbound)).searchParams;
  assert.equal(captureFromOpenedOneWaySearch(snap,job),false);
});
test('consecutive separate-ticket flights cannot silently choose an overlapping connection',()=>{
  const first=flight('BCN','MAD','2027-01-11');
  const next=flight('MAD','SPC','2027-01-11');
  const itinerary={id:'via-mad',legs:[first,next]};
  const cache={
    [researchKey(first)]:stored(first,[['09:00','13:30',40]]),
    [researchKey(next)]:stored(next,[['14:00','17:00',60],['16:00','19:00',95]])
  };
  const result=estimateRoute(itinerary,cache,{},{});
  assert.equal(result.total,135);
  assert.equal(result.selected[1].option.departureClock,'16:00');
  cache[researchKey(next)]=stored(next,[['14:00','17:00',60]]);
  const blocked=estimateRoute(itinerary,cache,{},{});
  assert.equal(blocked.complete,false);
  assert.equal(blocked.conflicts,1);
  assert.equal(blocked.missing,1);
});
