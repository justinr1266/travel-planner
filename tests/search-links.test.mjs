import test from 'node:test';
import assert from 'node:assert/strict';
import {googleFlightsSearchUrl, googleFlightsRoundTripUrl, findRoundTripPairs} from '../search-links.mjs';
import {generatePlannedRoutes} from '../route-engine.mjs';

function decodeMessage(bytes) {
  const fields = new Map();
  let position = 0;
  function readVarint() {
    let n = 0, factor = 1;
    while (true) {
      assert.ok(position < bytes.length, 'Truncated protobuf');
      const byte = bytes[position++];
      n += (byte & 127) * factor;
      if (!(byte & 128)) return n;
      factor *= 128;
    }
  }
  while (position < bytes.length) {
    const tag = readVarint();
    const field = tag >> 3, wire = tag & 7;
    let val;
    if (wire === 0) val = readVarint();
    else if (wire === 2) {
      const length = readVarint();
      val = bytes.subarray(position, position + length);
      position += length;
    } else throw new Error(`Unexpected wire type ${wire}`);
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(val);
  }
  return fields;
}
function decodedLink(link) {
  const url = new URL(link);
  const top = decodeMessage(Buffer.from(url.searchParams.get('tfs'), 'base64url'));
  const legs = (top.get(3) || []).map(raw => {
    const segment = decodeMessage(raw);
    const airport = field => Buffer.from(decodeMessage(segment.get(field)[0]).get(2)[0]).toString('utf8');
    return {from:airport(13),to:airport(14),date:Buffer.from(segment.get(2)[0]).toString('utf8')};
  });
  return {url, tripType:top.get(19)?.[0], legs};
}
const outward = {from:'MAD',to:'SPC',date:'2027-02-05',mode:'flight'};
const returning = {from:'SPC',to:'MAD',date:'2027-02-10',mode:'flight'};

test('individual leg always opens one-way with only its own date', () => {
  const {url,tripType,legs} = decodedLink(googleFlightsSearchUrl(outward));
  assert.equal(url.pathname, '/travel/flights/search');
  assert.equal(url.searchParams.has('q'), false);
  assert.equal(url.searchParams.get('curr'), 'EUR');
  assert.equal(tripType, 2);
  assert.deepEqual(legs,[{from:'MAD',to:'SPC',date:'2027-02-05'}]);
});
test('round trip opens both legs using their distinct exact dates', () => {
  const {tripType,legs} = decodedLink(googleFlightsRoundTripUrl(outward,returning));
  assert.equal(tripType,1);
  assert.deepEqual(legs,[
    {from:'MAD',to:'SPC',date:'2027-02-05'},
    {from:'SPC',to:'MAD',date:'2027-02-10'}
  ]);
});
test('search links do not silently change dates or create fake returns', () => {
  const {legs}=decodedLink(googleFlightsSearchUrl({from:'BCN',to:'LIS',date:'2027-02-02',mode:'flight'}));
  assert.deepEqual(legs,[{from:'BCN',to:'LIS',date:'2027-02-02'}]);
});
test('round-trip validation rejects mismatched endpoints and dates', () => {
  assert.throws(()=>googleFlightsRoundTripUrl(outward,{...returning,to:'BCN'}),/return to the original/);
  assert.throws(()=>googleFlightsRoundTripUrl(outward,{...returning,date:'2027-02-05'}),/after departure/);
  assert.throws(()=>googleFlightsRoundTripUrl(outward,{...returning,date:'2027-02-04'}),/after departure/);
  assert.throws(()=>googleFlightsRoundTripUrl(outward,{...returning,mode:'train'}),/flight leg/);
  assert.throws(()=>googleFlightsSearchUrl({...outward,date:'2027-02-30'}),/valid calendar/);
});
test('reciprocal flights are paired even when preceded by a train', () => {
  const legs = [
    {from:'BCN',to:'MAD',date:'2027-02-02',mode:'train'},
    outward,
    returning
  ];
  assert.deepEqual(findRoundTripPairs(legs),[{outboundIndex:1,returnIndex:2}]);
});
test('reciprocal flights separated by another leg can still be paired', () => {
  assert.deepEqual(findRoundTripPairs([outward,{from:'SPC',to:'TFN',date:'2027-02-07',mode:'ferry'},returning]),
    [{outboundIndex:0,returnIndex:2}]);
});
test('independent one-way flights are not incorrectly grouped', () => {
  assert.deepEqual(findRoundTripPairs([
    {from:'BCN',to:'LIS',date:'2027-02-02',mode:'flight'},
    {from:'LIS',to:'MAD',date:'2027-02-10',mode:'flight'}
  ]), []);
});
test('each leg can only appear in one round-trip pair', () => {
  assert.deepEqual(findRoundTripPairs([outward,returning,{...outward,date:'2027-02-11'},{...returning,date:'2027-02-15'}]),
    [{outboundIndex:0,returnIndex:1},{outboundIndex:2,returnIndex:3}]);
});
test('generic round-trip vacation produces a correctly dated pair',()=>{
  const plan={origin:'MIL',preferred:'SPC',destination:'MIL',requested_regions:[],
    depart_earliest:'2027-01-11',depart_latest:'2027-01-11',
    arrive_earliest:'2027-01-18',arrive_latest:'2027-01-18',fixed_arrival:true,
    priority:'more_time_at_preferred',min_nights_at_preferred:null};
  const route=generatePlannedRoutes(plan)[0];
  const pairs=findRoundTripPairs(route.legs);
  assert.deepEqual(pairs,[{outboundIndex:0,returnIndex:1}]);
  const decoded=decodedLink(googleFlightsRoundTripUrl(route.legs[0],route.legs[1]));
  assert.equal(decoded.tripType,1);
  assert.deepEqual(decoded.legs.map(l=>l.date),['2027-01-11','2027-01-18']);
});
