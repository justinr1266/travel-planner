import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeManualLeg,buildManualRoute,draftFromRoute,insertedTransfer,manualRouteForTrip,tripSignature} from '../multimodal.mjs';
import {transportSearch} from '../transport-links.mjs';
import {generatePlannedRoutes} from '../route-engine.mjs';
import {costSummary,rankRoutes} from '../core.mjs';
import {findRoundTripPairs} from '../search-links.mjs';

const trip=()=>({origin:'BCN',preferred:'SPC',destination:'MAD',startDate:'2027-01-11',endDate:'2027-01-18',arrivalRule:'fixed',request:'Visit La Palma'});
const rail={mode:'train',date:'2027-01-11',from:'Barcelona Sants',fromKind:'station',to:'Madrid Atocha',toKind:'station'};
const transfer={mode:'transfer',date:'2027-01-11',from:'Madrid Atocha',fromKind:'station',to:'MAD',toKind:'airport'};
const outward={mode:'flight',date:'2027-01-11',from:'MAD',fromKind:'airport',to:'SPC',toKind:'airport'};
const returning={mode:'flight',date:'2027-01-18',from:'SPC',fromKind:'airport',to:'MAD',toKind:'airport'};
const multi=()=>buildManualRoute({name:'Rail + flights',rows:[rail,transfer,outward,returning],trip:trip()});

test('generic terminal IDs preserve modality without pretending to verify stations or ports',()=>{
  const leg=normalizeManualLeg(rail);
  assert.equal(leg.mode,'train');
  assert.equal(leg.fromKind,'station');
  assert.equal(leg.from,'station:barcelona%20sants');
  assert.equal(leg.toLabel,'Madrid Atocha');
  assert.equal(leg.verifiedSchedule,false);
  const port=normalizeManualLeg({mode:'ferry',date:'2027-01-11',from:'Santa Cruz de Tenerife Port',fromKind:'port',to:'Santa Cruz de La Palma Port',toKind:'port'});
  assert.equal(port.fromKind,'port');
  assert.notEqual(port.key,leg.key);
});
test('a manually built train + station transfer + flight journey is connected and preserves the return flight pair',()=>{
  const route=multi();
  assert.deepEqual(route.legs.map(leg=>leg.mode),['train','transfer','flight','flight']);
  assert.equal(route.legs[0].to,route.legs[1].from);
  assert.equal(route.legs[1].to,route.legs[2].from);
  assert.equal(route.primaryStay.possibleNights,7);
  const pair=findRoundTripPairs(route.legs);
  assert.deepEqual(pair,[{outboundIndex:2,returnIndex:3}]);
  assert.equal(route.warnings.length>0,true);
  assert.ok(route.manual);
});
test('same-city arrival and airport departure require an explicitly modeled transfer',()=>{
  assert.throws(()=>buildManualRoute({rows:[rail,outward,returning],trip:trip()}),/do not connect/i);
});
test('nonflight modes enforce terminal types without fixed city pairs',()=>{
  assert.throws(()=>normalizeManualLeg({...rail,fromKind:'airport'}),/requires appropriate terminal types/i);
  assert.throws(()=>normalizeManualLeg({...rail,from:'BCN'}),/airport code/i);
  assert.throws(()=>normalizeManualLeg({...outward,from:'Barcelona Sants',fromKind:'station'}),/requires appropriate terminal types/i);
  assert.throws(()=>normalizeManualLeg({mode:'ferry',date:'2027-01-11',from:'SPC',to:'TFN',fromKind:'airport',toKind:'airport'}),/requires appropriate terminal types/i);
  assert.throws(()=>normalizeManualLeg({...transfer,to:'MIL',toKind:'airport'}),/physical airport/i);
});
test('manual routes validate chronology, dates, and a leg limit',()=>{
  assert.throws(()=>buildManualRoute({rows:[{...rail,date:'2027-01-12'},transfer,outward,returning],trip:trip()}),/departs before/i);
  assert.throws(()=>buildManualRoute({rows:[rail,transfer,outward,{...returning,date:'2027-01-17'}],trip:trip()}),/exact final date/i);
  assert.throws(()=>buildManualRoute({rows:[rail,transfer,outward,{...returning,date:'2027-01-19'}],trip:trip()}),/after the final arrival/i);
  assert.throws(()=>buildManualRoute({rows:Array.from({length:17},()=>rail),trip:trip()}),/1–16/);
});
test('manual rail and transfer prices are counted exactly once alongside flights',()=>{
  const route=multi();
  const prices=[40,8,85,110];
  const offers=Object.fromEntries(route.legs.map((leg,i)=>[leg.key,{fare:prices[i],bagFee:0,transferCost:0}]));
  const summary=costSummary(route,offers);
  assert.equal(summary.complete,true);
  assert.equal(summary.total,243);
  const absent={...offers};delete absent[route.legs[1].key];
  assert.equal(costSummary(route,absent).total,null);
  assert.equal(rankRoutes([route],absent)[0].summary.pricedLegs,3);
});
test('the route builder copies a generated itinerary and inserts a connecting transfer',()=>{
  const plan={...trip(),destination_search:'specified',depart_earliest:'2027-01-11',depart_latest:'2027-01-11',arrive_latest:'2027-01-18',arrive_earliest:'2027-01-18',fixed_arrival:true,max_connections:null};
  const routes=generatePlannedRoutes(plan,{connectionCandidates:{outbound:[{code:'MAD',city:'Madrid',country:'Spain'}],inbound:[]}});
  const draft=draftFromRoute(routes[1]);
  draft[0]={...rail};
  draft.splice(1,0,insertedTransfer(draft,0));
  assert.equal(draft[1].mode,'transfer');
  assert.equal(draft[1].from,'Madrid Atocha');
  assert.equal(draft[1].to,'MAD');
  assert.deepEqual(buildManualRoute({rows:draft,trip:trip()}).legs.map(x=>x.mode),['train','transfer','flight','flight']);
});
test('saved manual itineraries are associated with their original trip, never mixed with another one',()=>{
  const saved=multi();
  assert.ok(manualRouteForTrip(saved,trip()));
  assert.equal(saved.tripSignature,tripSignature(trip()));
  assert.equal(manualRouteForTrip(saved,{...trip(),startDate:'2027-02-11'}),false);
  assert.deepEqual(draftFromRoute(saved)[0],rail);
});
test('mode-aware search uses Google Flights for air, transit directions for rail/bus/transfer, Ferryhopper for ferry',()=>{
  const flight=transportSearch(normalizeManualLeg(outward));
  assert.ok(flight.url.includes('google.com/travel/flights/search'));
  assert.equal(flight.datePreFilled,true);
  for(const leg of [rail,{...transfer,mode:'bus'},transfer]){
    const search=transportSearch(normalizeManualLeg(leg));
    const url=new URL(search.url);
    assert.equal(url.hostname,'www.google.com');
    assert.equal(url.searchParams.get('travelmode'),'transit');
    assert.equal(search.datePreFilled,false);
  }
  assert.equal(transportSearch(normalizeManualLeg({mode:'ferry',date:'2027-01-11',from:'Port of Oslo',fromKind:'port',to:'Port of Copenhagen',toKind:'port'})).url,'https://www.ferryhopper.com/');
});
test('arbitrary city-named station and port entries do not require location-specific route rules',()=>{
  const rows=[{mode:'ferry',from:'Port of Bergen',fromKind:'port',to:'Port of Stavanger',toKind:'port',date:'2027-01-11'},
    {mode:'bus',from:'Port of Stavanger',fromKind:'port',to:'Stavanger Bus Terminal',toKind:'bus_stop',date:'2027-01-11'}];
  const route=buildManualRoute({rows,trip:{startDate:'2027-01-11',endDate:'2027-01-13',arrivalRule:'by'}});
  assert.deepEqual(route.legs.map(l=>l.mode),['ferry','bus']);
  assert.equal(route.primaryStay,null);
});
