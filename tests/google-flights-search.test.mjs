import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseGoogleFlightsSearchResults,searchOptionMatchesLeg} from '../google-flights-search.mjs';
import {parseFlightSelection,buildReviewedFlight} from '../flight-research.mjs';

const input=readFileSync(new URL('./fixtures/google-flights-search-mad-spc.txt',import.meta.url),'utf8');
const leg={key:'MAD|SPC|2027-01-11|flight',mode:'flight',from:'MAD',to:'SPC',date:'2027-01-11'};
const firstHtml=`<li class="pIav2d"><div class="JMc5Xc" role="link" aria-label="From 163 euros round trip total. Nonstop flight with Iberia Express. Leaves Adolfo Suárez Madrid-Barajas Airport at 11:30 AM on Monday, January 11 and arrives at La Palma Airport at 1:35 PM on Monday, January 11. Total duration 3 hr 5 min. Unknown emissions. Select flight"></div><span>MAD</span><span>SPC</span><div data-travelimpactmodelwebsiteurl="https://www.travelimpactmodel.org/lookup/flight?itinerary=MAD-SPC-I2-1531-20270111"></div></li>`;
const secondHtml=`<li class="pIav2d"><div role="link" aria-label="From 172 euros round trip total. Nonstop flight with Iberia. Operated by Iberia Express. Leaves Adolfo Suárez Madrid-Barajas Airport at 11:30 AM on Monday, January 11 and arrives at La Palma Airport at 1:35 PM on Monday, January 11. Total duration 3 hr 5 min. Select flight"></div><span>MAD</span><span>SPC</span><div data-travelimpactmodelwebsiteurl="https://www.travelimpactmodel.org/lookup/flight?itinerary=MAD-SPC-IB-1531-20270111"></div></li>`;

test('main Google Flights search text parses six distinct departing options, including overnight +1',()=>{
  const parsed=parseGoogleFlightsSearchResults(input);
  assert.equal(parsed.type,'google_flights_search_results');
  assert.equal(parsed.sourceFormat,'text');
  assert.equal(parsed.options.length,6);
  assert.deepEqual(parsed.options.map(item=>item.departureClock),['07:00','11:30','11:30','12:20','16:40','20:30']);
  assert.deepEqual(parsed.options.map(item=>item.quotedRoundTripEur),[131,163,172,131,131,131]);
  assert.equal(parsed.options[0].via[0],'TFN');
  assert.equal(parsed.options[1].stops,0);
  assert.equal(parsed.options[2].carrier,'Iberia');
  assert.equal(parsed.options[2].operatedBy,'Iberia Express');
  assert.equal(parsed.options[5].arrivalDayOffset,1);
  assert.equal(parsed.options[5].arrivalClock,'07:30');
  assert.ok(parsed.options.every(item=>searchOptionMatchesLeg(item,leg)));
});
test('the actual two kinds of HTML card accessibility labels retain separate marketing carriers and prices',()=>{
  const parsed=parseGoogleFlightsSearchResults(firstHtml+'\n'+secondHtml);
  assert.equal(parsed.sourceFormat,'html');
  assert.equal(parsed.options.length,2);
  assert.deepEqual(parsed.options.map(x=>[x.carrier,x.quotedRoundTripEur]),[
    ['Iberia Express',163],['Iberia',172]
  ]);
  assert.equal(parsed.options[1].operatedBy,'Iberia Express');
  assert.equal(parsed.options[1].departureClock,'11:30');
  assert.equal(parsed.options[1].arrivalClock,'13:35');
  assert.equal(parsed.options[1].dateISO,'2027-01-11');
  assert.equal(parsed.options[1].stops,0);
});
test('search option match requires the exact route, date and flight mode',()=>{
  const option=parseGoogleFlightsSearchResults(firstHtml).options[0];
  assert.equal(searchOptionMatchesLeg(option,leg),true);
  assert.equal(searchOptionMatchesLeg(option,{...leg,to:'TFN'}),false);
  assert.equal(searchOptionMatchesLeg(option,{...leg,date:'2028-01-11'}),false);
  assert.equal(searchOptionMatchesLeg(option,{...leg,date:'2027-01-18'}),false);
  assert.equal(searchOptionMatchesLeg(option,{...leg,mode:'train'}),false);
});
test('Google Flights search results never prefill a one-way EUR price',()=>{
  const parsed=parseFlightSelection(input,{leg});
  assert.equal(parsed.fareEur,null);
  assert.equal(parsed.departureClock,''); // Multiple options require explicit user choice.
  assert.equal(parsed.searchResults.options.length,6);
  const single=parseFlightSelection(firstHtml,{leg});
  assert.equal(single.fareEur,null);
  assert.equal(single.searchResults.options.length,1);
});
test('search-list prices cannot enter one-way fare calculations, including HTML snippets',()=>{
  const inputRecord={confirmed:true,mode:'fare',departureClock:'11:30',departureTimezone:'Europe/Madrid',arrivalClock:'13:35',bagStatus:'included',fareEur:'163'};
  assert.throws(()=>buildReviewedFlight({...inputRecord,rawSelectionText:input},leg),/round-trip price/i);
  assert.throws(()=>buildReviewedFlight({...inputRecord,rawSelectionText:firstHtml},leg),/round-trip price/i);
  const saved=buildReviewedFlight({...inputRecord,mode:'timing',rawSelectionText:input},leg);
  assert.equal(saved.offer,null);
  assert.equal(saved.flightTime.departureClock,'11:30');
});
test('plain manually written flight summaries still support original one-way fares',()=>{
  const parsed=parseFlightSelection('MAD → SPC 12:20 – 16:30 €90',{leg});
  assert.equal(parsed.fareEur,90);
  assert.equal(parsed.departureClock,'12:20');
});
test('flight importer interface permits draft one-way prefill but never automatically saves an offer',()=>{
  const src=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  assert.match(src,/data-choose-search-option/);
  assert.match(src,/searchOptionMatchesLeg\(option,leg\)/);
  assert.match(src,/flightImportFare'\)\.value=provenOneWay/);
  assert.match(src,/flightImportOneWayVerified'\)\.checked=false/);
  assert.match(src,/round-trip search quote/);
});
test('review records overnight arrival-day offset without saving a round-trip fare',()=>{
  const selected=parseGoogleFlightsSearchResults(input).options[5];
  const result=buildReviewedFlight({
    confirmed:true,mode:'timing',departureClock:selected.departureClock,arrivalClock:selected.arrivalClock,
    arrivalDayOffset:selected.arrivalDayOffset,departureTimezone:'Europe/Madrid',
    carrier:selected.carrier,stops:String(selected.stops),rawSelectionText:input
  },leg);
  assert.equal(result.research.arrivalDayOffset,1);
  assert.equal(result.research.arrivalClock,'07:30');
  assert.equal(result.offer,null);
  assert.throws(()=>buildReviewedFlight({confirmed:true,mode:'timing',departureClock:'20:30',departureTimezone:'Europe/Madrid',arrivalDayOffset:4},leg),/Arrival day/);
});
