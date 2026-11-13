import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLocation,resolveSuggestedDestination,findExplicitEndpoints,findExplicitPreferred,countryCode,fold,locationMentionedInText} from '../location-resolver.mjs';
import {buildCatalog} from '../scripts/sync-airports.mjs';
const sample=[
 ['MRS','Marseille','FR','Marseille Provence Airport','airport'],
 ['LYS','Lyon','FR','Lyon Saint Exupery Airport','airport'],
 ['ARN','Stockholm','SE','Stockholm Arlanda Airport','airport'],
 ['GOT','Gothenburg','SE','Gothenburg Landvetter Airport','airport'],
 ['MIL','Milan','IT','Milan (all airports)','metro'],
 ['AUS','Austin','US','Austin Bergstrom Airport','airport']
];
test('Country names and accents are handled from generic location records',()=>{
 assert.equal(countryCode('Sweden',sample),'SE');
 assert.equal(fold('Göteborg'),'goteborg');
 assert.equal(resolveLocation('Stockholm',{country:'Sweden',records:sample}).code,'ARN');
 assert.equal(resolveLocation('Lyon',{country:'Sweden',records:sample}),null);
 assert.equal(resolveLocation('Marseille Provence',{country:'France',records:sample}).code,'MRS');
});
test('Named endpoints work for cities not part of the initial 16-code bootstrap',()=>{
 assert.deepEqual(findExplicitEndpoints('Starting in Lyon, ending in Marseille.',{records:sample}),{origin:'LYS',destination:'MRS'});
 assert.deepEqual(findExplicitEndpoints('Starting and ending in Milan.',{records:sample}),{origin:'MIL',destination:'MIL'});
});
test('Model suggestion must resolve to a valid airport in the right country',()=>{
 assert.equal(resolveSuggestedDestination({code:'LYS',city:'Lyon',country:'France'},{region:'France',records:sample}).code,'LYS');
 assert.equal(resolveSuggestedDestination({code:'LYS',city:'Lyon',country:'France'},{region:'Sweden',records:sample}),null);
 assert.equal(resolveSuggestedDestination({code:'ZZZ',city:'Fakeville',country:'France'},{region:'France',records:sample}),null);
 assert.equal(resolveSuggestedDestination({code:'GOT',city:'Gothenburg',country:'Sweden'},{region:'Sweden',records:sample}).code,'GOT');
});
test('Airport sync parser filters unscheduled and non-IATA facilities',()=>{
 // The generated airport-catalog.mjs may be the bootstrap or a synced
 // OurAirports catalog. Test parsing against synthetic CSV, not the active file.
 const header='iata_code,municipality,name,iso_country,scheduled_service,type';
 const valid=Array.from({length:110},(_,i)=>{
   const code='A'+String.fromCharCode(65+Math.floor(i/26))+String.fromCharCode(65+i%26);
   return `${code},Test City ${i},Test Airport ${i},US,yes,medium_airport`;
 });
 const csv=[header,...valid,
   'HEL,Helsinki,Helsinki Vantaa Airport,FI,yes,large_airport',
   'XZZ,Nowhere,Unused Field,FI,no,small_airport',
   'GOOD,Invalid,Invalid,FI,yes,medium_airport'
 ].join('\n')+'\n';
 const catalog=buildCatalog(csv);
 const codes=new Set(catalog.map(row=>row[0]));
 assert.ok(codes.has('HEL'));
 assert.ok(!codes.has('XZZ'));
 assert.ok(!codes.has('GOOD'));
 assert.equal(codes.size,112); // 110 valid US + HEL + MIL metro
 assert.throws(()=>buildCatalog([header,'HEL,Helsinki,Helsinki Vantaa Airport,FI,yes,large_airport'].join('\n')), /Too few airports/);
});

test('endpoint extraction scales to thousands of airports without testing one regex per city',()=>{
  const records=[...sample];
  for(let i=0;i<6000;i++) {
    // Synthetic data: verify algorithmic scaling, not real airport coverage.
    records.push([`Q${String(i).padStart(4,'0')}`,`Synthetic City ${i}`,'US',`Synthetic City ${i} Airport`,'airport']);
  }
  const started=performance.now();
  assert.deepEqual(findExplicitEndpoints('Starting and ending in Milan, January 21 to January 24',{records}),{origin:'MIL',destination:'MIL'});
  assert.deepEqual(findExplicitEndpoints('Starting in Lyon and returning to Marseille',{records}),{origin:'LYS',destination:'MRS'});
  const elapsed=performance.now()-started;
  // Generous performance guard: the old implementation takes many seconds.
  assert.ok(elapsed<1500,`Endpoint extraction took ${Math.round(elapsed)} ms`);
});

test('primary destination phrase is resolved from traveler wording, not hallucinated airport codes',()=>{
 const records=[
   ['MNG','Menongue','AO','Menongue Airport','airport'],
   ['LPC','La Palma','CO','La Palma Municipio Airport','airport'],
   ['SPC','Sta Cruz de la Palma, La Palma Island','ES','La Palma Airport','airport'],
   ['TFN','Tenerife North','ES','Tenerife North Airport','airport'],
   ['BCN','Barcelona','ES','Barcelona Airport','airport'],
   ['MAD','Madrid','ES','Madrid Airport','airport']
 ];
 const text='I want to go to La Palma from january 11th to january 18th, starting in Barcelona and ending in madrid.';
 const selected=findExplicitPreferred(text,{records,country:'ES'});
 assert.equal(selected.code,'SPC');
 assert.match(selected.evidence,/go to La Palma/);
 assert.equal(findExplicitPreferred('I want to visit Sweden from Barcelona',{records,country:'ES'}),null);
 assert.equal(findExplicitPreferred('Travel from Barcelona to Madrid',{records,country:'ES'}),null);
});

test('generic primary destination recognition works with other cities and scales with a large directory',()=>{
 const records=[...sample];
 for(let i=0;i<6000;i++) records.push([`Q${String(i).padStart(4,'0')}`,`Synthetic City ${i}`,'US',`Synthetic City ${i} Airport`,'airport']);
 const started=performance.now();
 const preference=findExplicitPreferred('I want to visit Lyon and return to Marseille.',{records,country:'FR'});
 assert.equal(preference.code,'LYS');
 assert.equal(findExplicitPreferred('My primary destination is Stockholm.',{records}).code,'ARN');
 assert.ok(performance.now()-started<1500,'preferred destination lookup should not scan thousands of regexes');
});


test('generic place-evidence guard rejects a real but unmentioned airport',()=>{
  const records=[['SPC','Sta Cruz de la Palma, La Palma Island','ES','La Palma Airport','airport'],
    ['LPQ','Luang Prabang','LA','Luang Phabang International Airport','airport'],
    ['BCN','Barcelona','ES','Barcelona Airport','airport'],
    ['MAD','Madrid','ES','Madrid Airport','airport']];
  const request='I want a trip to La Palma, starting in Barcelona and ending in Madrid.';
  assert.equal(findExplicitPreferred(request,{records,country:'ES'}).code,'SPC');
  assert.equal(locationMentionedInText(request,'LPQ',{records}),null);
  assert.ok(locationMentionedInText(request,'SPC',{records}));
});
