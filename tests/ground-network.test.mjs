import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {csvRows,gtfsZipFiles,buildGtfsNetwork,discoverGroundEdges,modeForGtfsRoute,
  saveTransitNetwork,loadTransitNetwork,EMPTY_NETWORK,timetableForEdge} from '../gtfs-network.mjs';
import {discoverGroundNetwork,createServer} from '../server.mjs';
import {expandRoutesWithGround} from '../ground-routes.mjs';
import {chooseDiverseRoutes} from '../route-quality.mjs';
import {connectionWindows} from '../connection-windows.mjs';
import {generatePlannedRoutes} from '../route-engine.mjs';
import {findRoundTripPairs} from '../search-links.mjs';
import {costSummary} from '../core.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const files={
 'stops.txt':`stop_id,stop_name,stop_lat,stop_lon\nBS,"Barcelona, Sants",41.379,2.14\nMA,Madrid Atocha,40.406,-3.688\nTP,Santa Cruz Tenerife Port,28.47,-16.25\nLP,Santa Cruz La Palma Port,28.68,-17.76\n`,
 'routes.txt':`route_id,route_type\nR,2\nF,4\nL,3\nX,0\n`,
 'trips.txt':`route_id,service_id,trip_id\nR,DAY,train1\nF,DAY,ferry1\nL,DAY,bus1\nX,DAY,tram1\n`,
 'stop_times.txt':`trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrain1,08:00:00,08:00:00,BS,1\ntrain1,11:00:00,11:00:00,MA,2\nferry1,12:00:00,12:00:00,TP,1\nferry1,15:00:00,15:00:00,LP,2\nbus1,09:00:00,09:00:00,MA,1\nbus1,13:00:00,13:00:00,BS,2\ntram1,09:00:00,09:00:00,MA,1\ntram1,13:00:00,13:00:00,BS,2\n`,
 'calendar.txt':`service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nDAY,1,1,1,1,1,1,1,20261101,20270930\n`
};
const airports=[
 ['BCN','Barcelona','ES','Barcelona Airport','airport',41.297,2.083],
 ['MAD','Madrid','ES','Madrid Barajas Airport','airport',40.494,-3.567],
 ['SPC','La Palma','ES','La Palma Airport','airport',28.626,-17.755],
 ['TFN','Tenerife North','ES','Tenerife North Airport','airport',28.482,-16.341]
];
function zipStored(contents){
  let position=0;const local=[],central=[];
  for(const [name,content] of Object.entries(contents)){
    const nameBytes=Buffer.from(name),raw=Buffer.from(content),compressed=deflateRawSync(raw);
    const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(8,8);
    lh.writeUInt32LE(compressed.length,18);lh.writeUInt32LE(raw.length,22);lh.writeUInt16LE(nameBytes.length,26);
    local.push(lh,nameBytes,compressed);
    const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(8,10);
    ch.writeUInt32LE(compressed.length,20);ch.writeUInt32LE(raw.length,24);ch.writeUInt16LE(nameBytes.length,28);
    ch.writeUInt32LE(position,42);central.push(ch,nameBytes);
    position+=lh.length+nameBytes.length+compressed.length;
  }
  const dir=Buffer.concat(central),eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(Object.keys(contents).length,8);eocd.writeUInt16LE(Object.keys(contents).length,10);
  eocd.writeUInt32LE(dir.length,12);eocd.writeUInt32LE(position,16);
  return Buffer.concat([...local,dir,eocd]);
}
const network=()=>{
  const built=buildGtfsNetwork(gtfsZipFiles(zipStored(files)),{source:'Sample GTFS',sourceUrl:'https://example.org/feed.zip',attribution:'Source attribution'});
  return {version:1,feeds:[{id:'sample',source:built.source,sourceUrl:built.sourceUrl,attribution:built.attribution,
    validFrom:built.validFrom,validTo:built.validTo}],edges:built.edges.map(e=>({...e,feedId:'sample'}))};
};
const plan={origin:'BCN',preferred:'SPC',destination:'MAD',destination_search:'specified',
  depart_earliest:'2027-01-11',depart_latest:'2027-01-11',arrive_latest:'2027-01-18',arrive_earliest:'2027-01-18',
  fixed_arrival:true,priority:'more_time_at_preferred',max_connections:null};

test('GTFS ZIP importer reads deflated feed files and quoted stop names without a dependency',()=>{
  const parsed=gtfsZipFiles(zipStored(files));
  assert.match(parsed['stops.txt'],/Barcelona, Sants/);
  assert.equal([...csvRows('a,"b\nc"\n')][0]?.[1],'b\nc');
  const built=buildGtfsNetwork(parsed,{source:'Sample GTFS'});
  assert.ok(built.edges.some(e=>e.mode==='train' && e.from.id==='BS' && e.to.id==='MA'));
  assert.ok(built.edges.some(e=>e.mode==='ferry' && e.from.id==='TP' && e.to.id==='LP'));
  assert.ok(built.edges.some(e=>e.mode==='bus' && e.from.id==='MA' && e.to.id==='BS'));
  assert.ok(!built.edges.some(e=>e.mode==='tram'));
  assert.equal(built.validTo,'2027-09-30');
});
test('GTFS route types distinguish rail, bus and ferry without city-specific rules',()=>{
  assert.equal(modeForGtfsRoute(2),'train');assert.equal(modeForGtfsRoute(105),'train');
  assert.equal(modeForGtfsRoute(3),'bus');assert.equal(modeForGtfsRoute(700),'bus');
  assert.equal(modeForGtfsRoute(4),'ferry');assert.equal(modeForGtfsRoute(1000),'ferry');
  assert.equal(modeForGtfsRoute(0),null);
});
test('local network discovers BCN to MAD train and Tenerife to La Palma ferry from GTFS evidence',()=>{
  const edges=discoverGroundEdges(network(),{origin:'BCN',preferred:'SPC',final:'MAD',records:airports,max:10});
  assert.ok(edges.some(e=>e.fromAirport==='BCN' && e.toAirport==='MAD' && e.mode==='train'));
  assert.ok(edges.every(e=>e.evidence==='gtfs_trip_pattern'&&!e.dateVerified));
  const boat=discoverGroundEdges(network(),{origin:'TFN',preferred:'SPC',final:'TFN',records:airports,max:10});
  assert.ok(boat.some(e=>e.fromAirport==='TFN' && e.toAirport==='SPC' && e.mode==='ferry'));
});
test('generates mixed train + airport transfers + Madrid-La Palma round trip without hardcoded geography',()=>{
  const flights=generatePlannedRoutes(plan,{connectionCandidates:{outbound:[{code:'MAD',city:'Madrid',country:'Spain'}],inbound:[]}});
  const edges=discoverGroundEdges(network(),{origin:'BCN',preferred:'SPC',final:'MAD',records:airports,
    flightLegs:flights.flatMap(r=>r.legs)});
  const result=expandRoutesWithGround(plan,flights,edges);
  const mixed=result.find(r=>r.networkEvidence&&r.legs.some(l=>l.mode==='train'));
  assert.ok(mixed);
  assert.deepEqual(mixed.legs.slice(0,3).map(l=>l.mode),['transfer','train','transfer']);
  assert.equal(mixed.legs[0].to,mixed.legs[1].from);
  assert.equal(mixed.legs[1].to,mixed.legs[2].from);
  assert.ok(mixed.legs.some(l=>l.mode==='flight'&&l.from==='MAD'&&l.to==='SPC'));
  assert.deepEqual(findRoundTripPairs(mixed.legs).length,1);
  assert.equal(mixed.networkEvidence.validFrom,'2026-11-01');
  const prices=Object.fromEntries(mixed.legs.map((l,i)=>[l.key,{fare:i*10,bagFee:0,transferCost:0}]));
  assert.equal(costSummary(mixed,prices).total,mixed.legs.reduce((n,_,i)=>n+i*10,0));
});
test('adds a ground hub even if Groq did not propose an airport hub',()=>{
  const base=generatePlannedRoutes(plan);
  assert.equal(base.length,1);
  const edges=discoverGroundEdges(network(),{origin:'BCN',preferred:'SPC',final:'MAD',records:airports});
  const result=expandRoutesWithGround(plan,base,edges);
  assert.equal(result.length,2);
  assert.ok(result[1].legs.map(l=>l.mode).includes('train'));
  assert.ok(result[1].legs.some(l=>l.from==='MAD'&&l.to==='SPC'&&l.mode==='flight'));
});
test('zero-connection limit blocks adding extra ground+flight hubs but allows direct flight candidates',()=>{
  const restricted={...plan,max_connections:0};
  const base=generatePlannedRoutes(restricted);
  const result=expandRoutesWithGround(restricted,base,discoverGroundEdges(network(),{origin:'BCN',preferred:'SPC',final:'MAD',records:airports}));
  assert.equal(result.length,1);
});
test('no network data gracefully preserves flight-only candidates',()=>{
  const base=generatePlannedRoutes(plan);
  assert.deepEqual(expandRoutesWithGround(plan,base,[]),base);
  assert.deepEqual(discoverGroundEdges(EMPTY_NETWORK,{origin:'BCN',preferred:'SPC',final:'MAD',records:airports}),[]);
});
test('server ground endpoint returns GTFS patterns with no fabricated date verification',async()=>{
  const result=await discoverGroundNetwork({origin:'BCN',preferred:'SPC',destination:'MAD',request:'trip'},
    {records:airports,loadNetwork:async()=>network()});
  assert.equal(result.hasNetwork,true);
  assert.equal(result.dateVerified,false);
  assert.ok(result.alternatives.some(x=>x.mode==='train'));
});
test('network file load/save and upsert support local persistent import',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'routewise-network-'));
  try{
    const filepath=path.join(root,'data','snapshot.json');
    assert.deepEqual(await loadTransitNetwork(filepath),EMPTY_NETWORK);
    await saveTransitNetwork(network(),filepath);
    assert.equal((await loadTransitNetwork(filepath)).feeds[0].source,'Sample GTFS');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('ZIP importer rejects truncated archives, missing files and oversized expanded entries',()=>{
  assert.throws(()=>gtfsZipFiles(Buffer.from('not a zip')),/Invalid GTFS ZIP/);
  assert.throws(()=>gtfsZipFiles(zipStored({'stops.txt':'a,b\n1,2\n'})),/missing routes.txt/i);
});

test('v0.4.2 retains scheduled rail times, operating weekdays and agency time zone',()=>{
  const sample={...files,'agency.txt':'agency_name,agency_url,agency_timezone\nExample,https://example.com,Europe/Madrid\n'};
  const built=buildGtfsNetwork(sample);
  const edge=built.edges.find(e=>e.mode==='train'&&e.from.id==='BS'&&e.to.id==='MA');
  assert.equal(edge.schedules[0].departure,'08:00:00');
  assert.equal(edge.schedules[0].arrival,'11:00:00');
  assert.equal(built.timezone,'Europe/Madrid');
  const liveFeed={calendar:built.calendar,timezone:built.timezone};
  assert.equal(timetableForEdge(edge,liveFeed,'2027-01-11').status,'scheduled');
  assert.equal(timetableForEdge(edge,liveFeed,'2027-01-11').departureLocal,'2027-01-11 08:00');
  assert.equal(timetableForEdge(edge,liveFeed,'2027-01-11').arrivalLocal,'2027-01-11 11:00');
});

test('calendar exceptions override recurring weekday services; unavailable dates are excluded',()=>{
  const sample={...files,'calendar_dates.txt':'service_id,date,exception_type\nDAY,20270111,2\nDAY,20270112,1\n'};
  const built=buildGtfsNetwork(sample);
  const snapshot={version:1,feeds:[{id:'test',calendar:built.calendar,timezone:'Europe/Madrid'}],
    edges:built.edges.map(e=>({...e,feedId:'test'}))};
  const edges11=discoverGroundEdges(snapshot,{origin:'BCN',preferred:'SPC',final:'MAD',records:airports,date:'2027-01-11'});
  assert.ok(!edges11.some(e=>e.fromAirport==='BCN'&&e.toAirport==='MAD'&&e.mode==='train'));
  const edges12=discoverGroundEdges(snapshot,{origin:'BCN',preferred:'SPC',final:'MAD',records:airports,date:'2027-01-12'});
  assert.ok(edges12.some(e=>e.fromAirport==='BCN'&&e.toAirport==='MAD'&&e.dateVerified));
});

test('GTFS departures after 24:00 match their real calendar departure day',()=>{
  const midnight={...files,'trips.txt':'route_id,service_id,trip_id\nR,DAY,train1\n',
    'stop_times.txt':'trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrain1,25:10:00,25:10:00,BS,1\ntrain1,28:20:00,28:20:00,MA,2\n',
    'calendar.txt':'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nDAY,0,0,0,0,0,0,1,20270110,20270110\n'};
  const built=buildGtfsNetwork(midnight);
  const edge=built.edges[0];
  const result=timetableForEdge(edge,{calendar:built.calendar,timezone:'Europe/Madrid'},'2027-01-11');
  assert.equal(result.status,'scheduled');
  assert.equal(result.departureLocal,'2027-01-11 01:10');
  assert.equal(result.arrivalLocal,'2027-01-11 04:20');
});

test('old v0.4.1 networks cannot produce fake verified schedules',()=>{
  const old=network();
  for(const feed of old.feeds){delete feed.calendar;delete feed.timezone;}
  const rows=discoverGroundEdges(old,{origin:'BCN',preferred:'SPC',final:'MAD',records:airports,date:'2027-01-11'});
  assert.ok(rows.length>0);
  assert.ok(rows.every(e=>!e.dateVerified && e.timetable.status==='unknown'));
});

test('route quality prefers distinct scheduled train alternative and preserves fixed return date',()=>{
  const snapshot=network();
  snapshot.feeds[0].calendar=buildGtfsNetwork(files).calendar;
  snapshot.feeds[0].timezone='Europe/Madrid';
  const flightRoutes=generatePlannedRoutes(plan,{connectionCandidates:{outbound:[{code:'MAD',city:'Madrid',country:'Spain'}],inbound:[]}});
  const alternatives=discoverGroundEdges(snapshot,{origin:'BCN',preferred:'SPC',final:'MAD',records:airports,date:'2027-01-11'});
  const routes=expandRoutesWithGround(plan,flightRoutes,alternatives,{maxRoutes:5});
  assert.ok(routes.some(r=>r.networkEvidence?.dateVerified));
  const rail=routes.find(r=>r.networkEvidence?.dateVerified);
  assert.equal(rail.legs.find(l=>l.mode==='train').departureLocal,'2027-01-11 08:00');
  assert.equal(rail.legs.at(-1).date,'2027-01-18');
  assert.equal(rail.primaryStay.possibleNights,7);
  assert.ok(rail.warnings.some(w=>/not a verified connection/i.test(w)));
});

test('generic quality selector preserves direct reference and avoids duplicate ground corridor',()=>{
  const flights=generatePlannedRoutes(plan,{connectionCandidates:{outbound:[{code:'MAD',city:'Madrid',country:'Spain'}],inbound:[]}});
  const candidate={...flights[1],id:'train-a',networkEvidence:{groundKey:'train|BCN|MAD',dateVerified:true,toAirport:'MAD'},
    legs:flights[1].legs.map(l=>({...l}))};
  const duplicate={...candidate,id:'train-b'};
  const routes=chooseDiverseRoutes(flights,[candidate,duplicate],{maxRoutes:5,final:'MAD'});
  assert.equal(routes[0].id,flights[0].id);
  assert.equal(routes.filter(r=>r.networkEvidence).length,1);
});

test('date-evidenced ground corridor toward final airport outranks equally evidenced detour',()=>{
  const flights=generatePlannedRoutes(plan);
  const viaMadrid={...flights[0],id:'ground-via-final',
    networkEvidence:{groundKey:'train|BCN|MAD',dateVerified:true,toAirport:'MAD'},
    legs:flights[0].legs.map(l=>({...l}))};
  const viaOther={...flights[0],id:'ground-via-other',
    networkEvidence:{groundKey:'train|BCN|VLC',dateVerified:true,toAirport:'VLC'},
    legs:flights[0].legs.map(l=>({...l}))};
  const routes=chooseDiverseRoutes(flights,[viaOther,viaMadrid],{maxRoutes:2,final:'MAD'});
  assert.deepEqual(routes.map(r=>r.id),[flights[0].id,'ground-via-final']);
});

test('v0.4.3 end-to-end GTFS route exposes a ground-to-flight departure window',()=>{
  const imported=buildGtfsNetwork({...files,'agency.txt':'agency_name,agency_url,agency_timezone\nExample,https://example.com,Europe/Madrid\n'});
  const snapshot={version:1,feeds:[{id:'test',source:'Example',calendar:imported.calendar,timezone:imported.timezone}],
    edges:imported.edges.map(e=>({...e,feedId:'test'}))};
  const flightRoutes=generatePlannedRoutes(plan,{connectionCandidates:{outbound:[{code:'MAD',city:'Madrid',country:'Spain'}],inbound:[]}});
  const edges=discoverGroundEdges(snapshot,{origin:'BCN',preferred:'SPC',final:'MAD',records:airports,date:'2027-01-11'});
  const routes=expandRoutesWithGround(plan,flightRoutes,edges,{bufferMinutes:180});
  const ground=routes.find(r=>r.networkEvidence?.dateVerified);
  assert.ok(ground);
  const windows=connectionWindows(ground,{}, {bufferMinutes:180});
  assert.ok(windows.length>0);
  assert.equal(windows[0].earliestDepartureLocal,'2027-01-11 14:00');
  assert.equal(windows[0].flightFrom,'MAD');
  assert.equal(ground.legs.at(-1).date,'2027-01-18');
});
