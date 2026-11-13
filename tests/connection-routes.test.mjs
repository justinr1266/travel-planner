import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePlannedRoutes} from '../route-engine.mjs';
import {findRoundTripPairs} from '../search-links.mjs';
import {suggestConnectionsWithGroq,createServer} from '../server.mjs';

const plan=()=>({
  origin:'BCN',preferred:'SPC',destination:'MAD',destination_search:'specified',
  depart_earliest:'2027-01-11',depart_latest:'2027-01-11',
  arrive_earliest:'2027-01-18',arrive_latest:'2027-01-18',fixed_arrival:true,
  min_nights_at_preferred:null,max_connections:null,priority:'more_time_at_preferred',
  alternate_stops:[]
});
const proposals=()=>({
  outbound:[{code:'MAD',city:'Madrid',country:'Spain'},
    {code:'LPA',city:'Las Palmas de Gran Canaria',country:'Spain'}],
  inbound:[{code:'TFN',city:'Tenerife North',country:'Spain'},
    {code:'BCN',city:'Barcelona',country:'Spain'}]
});
const codes=route=>[route.legs[0].from,...route.legs.map(leg=>leg.to)];

test('named primary trip generates up to five unique options from AI-suggested hubs',()=>{
  const routes=generatePlannedRoutes(plan(),{connectionCandidates:proposals()});
  assert.equal(routes.length,5);
  assert.deepEqual(routes.map(codes),[
    ['BCN','SPC','MAD'],
    ['BCN','MAD','SPC','MAD'],
    ['BCN','SPC','TFN','MAD'],
    ['BCN','MAD','SPC','TFN','MAD'],
    ['BCN','LPA','SPC','MAD']
  ]);
  assert.equal(new Set(routes.map(route=>codes(route).join('|'))).size,5);
  assert.ok(routes.every(route=>route.primaryStay.possibleNights===7));
  assert.ok(routes.every(route=>route.warnings.some(w=>/not verified/i.test(w))));
  assert.ok(routes.slice(1).every(route=>route.warnings.some(w=>/connection airports are suggestions/i.test(w))));
});

test('a final-city hub is legal on the outbound trip and retains the Madrid–La Palma return search',()=>{
  const route=generatePlannedRoutes(plan(),{connectionCandidates:proposals()})[1];
  assert.deepEqual(route.legs.map(leg=>leg.date),['2027-01-11','2027-01-11','2027-01-18']);
  const pairs=findRoundTripPairs(route.legs);
  assert.equal(pairs.length,1);
  assert.equal(route.legs[pairs[0].outboundIndex].from,'MAD');
  assert.equal(route.legs[pairs[0].returnIndex].from,'SPC');
});

test('max_connections=0 prevents guessed and traveler-specified connections',()=>{
  const routes=generatePlannedRoutes({...plan(),max_connections:0,alternate_stops:['LPA']},
    {connectionCandidates:proposals()});
  assert.equal(routes.length,1);
  assert.deepEqual(codes(routes[0]),['BCN','SPC','MAD']);
});

test('invalid hubs, wrong-country airports and endpoints on their own leg are rejected',()=>{
  const hubs={outbound:[
    {code:'QQQ',city:'Fakeville',country:'Spain'},
    {code:'MAD',city:'Madrid',country:'France'},
    {code:'BCN',city:'Barcelona',country:'Spain'},
    {code:'MAD',city:'Madrid',country:'Spain'},
    {code:'MAD',city:'Madrid',country:'Spain'}
  ],inbound:[
    {code:'MAD',city:'Madrid',country:'Spain'},
    {code:'TFN',city:'Tenerife North',country:'Spain'},
    {code:'TFN',city:'Tenerife North',country:'Spain'}]};
  const routes=generatePlannedRoutes(plan(),{connectionCandidates:hubs});
  assert.equal(routes.length,4); // direct, outbound hub, inbound hub, both
  assert.deepEqual(codes(routes[1]),['BCN','MAD','SPC','MAD']);
  assert.deepEqual(codes(routes[2]),['BCN','SPC','TFN','MAD']);
});

test('no Groq hub response still yields the direct hypothetical route',()=>{
  const routes=generatePlannedRoutes(plan());
  assert.equal(routes.length,1);
  assert.deepEqual(codes(routes[0]),['BCN','SPC','MAD']);
});

test('connection generation is country independent and honors named primary destinations',()=>{
  const records=[
    ['LYS','Lyon','FR','Lyon Saint-Exupery Airport','airport'],
    ['OSL','Oslo','NO','Oslo Gardermoen Airport','airport'],
    ['BGO','Bergen','NO','Bergen Airport','airport'],
    ['CDG','Paris','FR','Paris Charles de Gaulle Airport','airport'],
    ['AMS','Amsterdam','NL','Amsterdam Airport','airport']
  ];
  const trip={...plan(),origin:'LYS',preferred:'BGO',destination:'OSL'};
  const hubs={outbound:[{code:'CDG',city:'Paris',country:'France'}],
    inbound:[{code:'AMS',city:'Amsterdam',country:'Netherlands'}]};
  const routes=generatePlannedRoutes(trip,{connectionCandidates:hubs,records});
  assert.equal(routes.length,4);
  assert.deepEqual(routes.map(codes),[
    ['LYS','BGO','OSL'],['LYS','CDG','BGO','OSL'],
    ['LYS','BGO','AMS','OSL'],['LYS','CDG','BGO','AMS','OSL']
  ]);
});

test('connection brainstorming validates suggested airports without inventing real flight service',async()=>{
  let sent;
  const fake=async(_url,options)=>{
    sent=JSON.parse(options.body);
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({
      outbound:[
        {code:'MAD',city:'Madrid',country:'Spain'},
        {code:'INVALID',city:'Imaginary',country:'Spain'},
        {code:'MAD',city:'Madrid',country:'Spain'},
        {code:'SPC',city:'La Palma',country:'Spain'}
      ],
      inbound:[{code:'TFN',city:'Tenerife North',country:'Spain'},
        {code:'MAD',city:'Madrid',country:'Spain'},
        {code:'LIS',city:'Lisbon',country:'Portugal'}]
    })}}]})};
  };
  const result=await suggestConnectionsWithGroq({request:'Barcelona La Palma Madrid',
    origin:'BCN',preferred:'SPC',destination:'MAD',startDate:'2027-01-11',endDate:'2027-01-18'},
    {apiKey:'private-test-key',fetchImpl:fake});
  assert.deepEqual(result.outbound.map(x=>x.code),['MAD']);
  assert.deepEqual(result.inbound.map(x=>x.code),['TFN','LIS']);
  assert.equal(result.verified,false);
  assert.equal(result.airportCodesChecked,true);
  assert.equal(sent.response_format.json_schema.strict,true);
  assert.ok(sent.messages[0].content.includes('do not know live schedules'));
  assert.ok(!JSON.stringify(result).includes('private-test-key'));
});

test('connection endpoint uses the local server with no extension-held API key',async()=>{
  let received;
  const server=createServer({suggestConnections:async(body)=>{
    received=body;
    return {outbound:[{code:'MAD',city:'Madrid',country:'Spain'}],inbound:[],verified:false};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/suggest-connections`,{
      method:'POST',headers:{Origin:`chrome-extension://${'a'.repeat(32)}`,'Content-Type':'application/json'},
      body:JSON.stringify({request:'La Palma visit',origin:'BCN',preferred:'SPC',destination:'MAD'})
    });
    assert.equal(response.status,200);
    assert.equal(received.preferred,'SPC');
    assert.equal((await response.json()).outbound[0].code,'MAD');
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('connection discovery rejects missing primary locations and skips explicit zero-connection trips',async()=>{
  await assert.rejects(()=>suggestConnectionsWithGroq({origin:'BCN',destination:'MAD'},
    {apiKey:'test-key'}),/distinct trip endpoints/);
  const result=await suggestConnectionsWithGroq({origin:'BCN',destination:'MAD',preferred:'SPC',maxConnections:0},
    {apiKey:'test-key',fetchImpl:()=>{throw new Error('No API call expected');}});
  assert.deepEqual(result.outbound,[]);
  assert.deepEqual(result.inbound,[]);
});

test('connecting hubs must be physical airports, not all-airport metropolitan codes',()=>{
  const hubs={outbound:[{code:'MIL',city:'Milan',country:'Italy'}],inbound:[]};
  const routes=generatePlannedRoutes(plan(),{connectionCandidates:hubs});
  assert.equal(routes.length,1);
});
