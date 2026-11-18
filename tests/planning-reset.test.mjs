import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PLANNING_RESET_KEYS,resetPlanningSession,resetTripKeepingDescription} from '../planning-reset.mjs';
const source=file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

function fakeStorage(seed){
  const data={...seed};
  return {data,
    async get(key){return {[key]:data[key]};},
    async remove(keys){for(const key of keys)delete data[key];},
    async set(entries){Object.assign(data,entries);}
  };
}

test('full reset clears route cards, flight and train results while preserving prompt, baggage and test mode',async()=>{
  const storage=fakeStorage({
    trip:{origin:'BCN',preferred:'SPC',destination:'MAD',startDate:'2027-01-11',endDate:'2027-01-18',request:'Barcelona to La Palma'},
    bag:{kg:10},priceTestMode:true,routes:[{id:'first'}],manualRoutes:[{id:'manual'}],
    trainCache:{one:{fareEur:19}},broadCache:{flight:{fareEur:30}},offers:{leg:{fare:55}},
    roundTripTickets:{round:{totalEur:120}},flightTimes:{a:'09:00'},groundTimes:{b:'11:00'},
    flightResearch:{a:'abc'},parsedPlan:{origin:'BCN'},lastAiInterpretation:{plan:{}},
    destinationCandidates:[{code:'MAD'}],developerEvents:[{message:'run'}],
    pendingFlightCapture:{text:'sample'},priceImportResetRequest:'older',miscSetting:'safe'
  });
  const result=await resetPlanningSession(storage,{requestId:'reset-1'});
  assert.equal(storage.data.trip.request,'Barcelona to La Palma');
  assert.equal(storage.data.trip.origin,'');
  assert.equal(storage.data.trip.destination,'');
  assert.deepEqual(storage.data.routes,[]);
  assert.deepEqual(storage.data.manualRoutes,[]);
  assert.equal(storage.data.sessionCleared,true);
  assert.equal(storage.data.planningResetRequest,'reset-1');
  for(const key of ['trainCache','broadCache','offers','roundTripTickets','flightTimes','groundTimes',
    'flightResearch','parsedPlan','lastAiInterpretation','pendingFlightCapture','destinationCandidates',
    'developerEvents','priceImportResetRequest'])assert.equal(key in storage.data,false,key);
  assert.deepEqual(storage.data.bag,{kg:10});
  assert.equal(storage.data.priceTestMode,true);
  assert.equal(storage.data.miscSetting,'safe');
  assert.ok(result.clearedKeys>=20);
});

test('reset prevents fallback to previous trip endpoints',()=>{
  const fresh=resetTripKeepingDescription(null);
  assert.equal(fresh.origin,'');assert.equal(fresh.destination,'');assert.equal(fresh.request,'');
  const a=resetTripKeepingDescription({origin:'MAD',request:'My trip'});
  assert.equal(a.request,'My trip');assert.equal(a.origin,'');
});

test('developer has independent full reset; side panel reloads on completion',()=>{
  assert.match(source('developer.html'),/id="resetPlanningSession"/);
  assert.match(source('developer.mjs'),/resetPlanningSession\(chrome\.storage\.local\)/);
  assert.match(source('panel.mjs'),/changes\.planningResetRequest\?\.newValue/);
  assert.match(source('panel.mjs'),/window\.location\.reload\(\)/);
  assert.ok(PLANNING_RESET_KEYS.includes('trainCache'));
});
