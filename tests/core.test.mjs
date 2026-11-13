import test from 'node:test';
import assert from 'node:assert/strict';
import {generateRoutes,costSummary,rankRoutes,normalizedOffer,legKey} from '../core.mjs';
const trip={origin:'BCN',preferred:'SPC',destination:'MAD',startDate:'2027-02-02',endDate:'2027-02-10'};
test('Legacy wrapper no longer generates special-case regional routes',()=>{
  const [route]=generateRoutes(trip);
  assert.equal(route.legs.length,2);
  assert.equal(route.id,'generic-direct');
});
test('Cost summary never presents an incomplete itinerary as cheapest',()=>{
  const [route]=generateRoutes(trip);
  const offers={[route.legs[0].key]:{fare:50,bagFee:15}};
  assert.equal(costSummary(route,offers).total,null);
  offers[route.legs[1].key]={fare:100,bagFee:20};
  assert.equal(rankRoutes([route],offers)[0].summary.total,185);
});
test('Offer validation and transport modes',()=>{
  assert.equal(normalizedOffer({fare:'69.99',bagFee:'30',transferCost:'0'}).fare,69.99);
  assert.throws(()=>normalizedOffer({fare:'-5'}));
  assert.throws(()=>normalizedOffer({fare:'12',source:'javascript:alert(1)'}));
  const leg={from:'BCN',to:'MAD',date:'2027-02-02'};
  assert.notEqual(legKey({...leg,mode:'train'}),legKey({...leg,mode:'flight'}));
});
test('Legacy wrapper validates calendar dates',()=>{
  assert.throws(()=>generateRoutes({...trip,startDate:'2027-02-30'}));
  assert.throws(()=>generateRoutes({...trip,endDate:'2027-02-02'}));
});

test('unpriced multimodal routes preserve route-quality order rather than penalizing leg count',()=>{
  const simple={id:'flight',legs:[{from:'A',to:'B',date:'2027-01-11',mode:'flight',key:'a'},{from:'B',to:'A',date:'2027-01-18',mode:'flight',key:'b'}]};
  const mixed={id:'rail',legs:[{from:'A',to:'X',date:'2027-01-11',mode:'transfer',key:'c'},{from:'X',to:'Y',date:'2027-01-11',mode:'train',key:'d'},{from:'Y',to:'B',date:'2027-01-11',mode:'flight',key:'e'},{from:'B',to:'A',date:'2027-01-18',mode:'flight',key:'f'}]};
  assert.deepEqual(rankRoutes([simple,mixed],{}).map(x=>x.route.id),['flight','rail']);
  assert.deepEqual(rankRoutes([mixed,simple],{}).map(x=>x.route.id),['rail','flight']);
});
