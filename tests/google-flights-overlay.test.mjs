import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseGoogleFlightsSearchResults,searchOptionMatchesLeg} from '../google-flights-search.mjs';

// Execute the actual production DOM adapter with mocked card elements. It
// exports its pure capture helpers only in a test/module environment.
const source=readFileSync(new URL('../flights-overlay.js',import.meta.url),'utf8');
const sandbox={module:{exports:{}}};
vm.runInNewContext(source,sandbox);
const {cardRecord,collectCards,capturePayload,escapeAttribute}=sandbox.module.exports;
const MAD_SPC_2027='https://www.travelimpactmodel.org/lookup/flight?itinerary=MAD-SPC-I2-1531-20270111';
const iberiaLabel='From 163 euros round trip total. Nonstop flight with Iberia Express. Leaves Adolfo Suárez Madrid-Barajas Airport at 11:30 AM on Monday, January 11 and arrives at La Palma Airport at 1:35 PM on Monday, January 11. Total duration 3 hr 5 min. Unknown emissions. Select flight';
const operatedLabel='From 172 euros round trip total. Nonstop flight with Iberia. Operated by Iberia Express. Leaves Adolfo Suárez Madrid-Barajas Airport at 11:30 AM on Monday, January 11 and arrives at La Palma Airport at 1:35 PM on Monday, January 11. Total duration 3 hr 5 min. Select flight';
function fakeCard(label,{travel=MAD_SPC_2027,codes=['MAD','SPC'],visible=true}={}) {
  const link={getAttribute:name=>name==='aria-label'?label:''};
  const card={
    querySelector:selector=>selector.includes('[role="link"]')?link:null,
    querySelectorAll:selector=>selector==='div,span'?codes.map(code=>({children:[],textContent:code})):
      selector==='[data-travelimpactmodelwebsiteurl]'?(travel?[{getAttribute:()=>travel}]:[]):[],
    getClientRects:()=>visible?[{left:50,right:800,top:100,bottom:200}]:[]
  };
  link.closest=selector=>selector==='li'?card:null;
  return {card,link};
}
test('per-card overlay snapshot feeds the current Google Flights importer safely',()=>{
  const {card}=fakeCard(iberiaLabel);
  const record=cardRecord(card);
  assert.equal(record.from,'MAD');assert.equal(record.to,'SPC');
  assert.equal(record.dateISO,'2027-01-11');
  assert.equal(record.price,163);assert.equal(record.carrier,'Iberia Express');
  assert.equal(record.depart,'11:30 AM');assert.equal(record.arrive,'1:35 PM');
  const parsed=parseGoogleFlightsSearchResults(record.snapshot);
  assert.equal(parsed.options.length,1);
  assert.equal(parsed.options[0].dateISO,'2027-01-11');
  assert.equal(parsed.options[0].departureClock,'11:30');
  assert.equal(parsed.options[0].arrivalClock,'13:35');
  assert.equal(parsed.options[0].quotedRoundTripEur,163);
  assert.equal(parsed.options[0].priceScope,'round_trip_search_quote');
});
test('overlay page import keeps separate prices for same-time flights',()=>{
  const first=fakeCard(iberiaLabel);const second=fakeCard(operatedLabel);
  const root={querySelectorAll:()=>[first.link,second.link,first.link]};
  const cards=collectCards(root);
  assert.equal(cards.length,2);
  const payload=capturePayload(cards,'https://www.google.com/travel/flights/search','2026-11-13T00:00:00Z');
  assert.equal(payload.captureCount,2);assert.equal(payload.captureMode,'page');
  assert.equal(payload.sourceUrl,'https://www.google.com/travel/flights/search');
  const parsed=parseGoogleFlightsSearchResults(payload.text);
  assert.equal(parsed.options.length,2);
  assert.equal(parsed.options.map(o=>o.carrier).join('|'),'Iberia Express|Iberia');
  assert.equal(parsed.options.map(o=>o.quotedRoundTripEur).join('|'),'163|172');
  assert.equal(parsed.options.every(option=>searchOptionMatchesLeg(option,{
    key:'MAD|SPC|2027-01-11|flight',mode:'flight',from:'MAD',to:'SPC',date:'2027-01-11'
  })),true);
});
test('connecting flight destinations come from visible endpoint codes rather than intermediate emissions leg',()=>{
  const label='From 131 euros round trip total. 1 stop flight with Binter Canarias. Leaves Madrid Airport at 7:00 AM on Monday, January 11 and arrives at La Palma Airport at 10:30 AM on Monday, January 11. Total duration 4 hr 30 min. Select flight';
  const {card}=fakeCard(label,{travel:'https://www.travelimpactmodel.org/lookup/flight?itinerary=MAD-TFN-NT-6073-20270111',codes:['MAD','SPC']});
  const record=cardRecord(card); const option=parseGoogleFlightsSearchResults(record.snapshot).options[0];
  assert.equal(option.from,'MAD');assert.equal(option.to,'SPC');
  assert.equal(option.stops,1);
  assert.equal(option.quotedRoundTripEur,131);
});
test('card capture is limited to supported cards and skips hidden cards',()=>{
  const visible=fakeCard(iberiaLabel),hidden=fakeCard(operatedLabel,{visible:false});
  const unrelated=fakeCard('From $100 one way. Travel to La Palma.');
  const cards=collectCards({querySelectorAll:()=>[hidden.link,unrelated.link,visible.link]});
  assert.equal(cards.length,1);
  assert.equal(capturePayload(cards,'https://www.google.com/travel/flights').captureMode,'card');
  assert.throws(()=>capturePayload([],'https://www.google.com/travel/flights'),/No supported/);
});
test('attribute serialization escapes untrusted labels and no automatic fare save is possible',()=>{
  const name='From 163 euros round trip total. Nonstop flight with Air & Co. Leaves Madrid Airport at 11:30 AM on Monday, January 11 and arrives at La Palma Airport at 1:35 PM on Monday, January 11. Total duration 3 hr. Select flight';
  const record=cardRecord(fakeCard(name).card);
  assert.match(record.snapshot,/Air &amp; Co/);
  assert.equal(escapeAttribute('"<script>'),'&quot;&lt;script&gt;');
  assert.doesNotMatch(source,/fetch\(|XMLHttpRequest|chrome\.cookies/);
  assert.match(source,/chrome\.storage\.local\.set\(\{pendingFlightCapture:payload\}\)/);
});
test('manifest scope and side-panel bridge are correctly configured',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.version,'0.4.9');
  assert.equal(manifest.content_scripts[0].matches[0],'https://www.google.com/travel/flights*');
  assert.equal(manifest.content_scripts[0].js[0],'flights-overlay.js');
  assert.equal(manifest.permissions.includes('scripting'),false);
  const panel=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  assert.match(panel,/routewise:show-flight-overlay/);
  assert.match(panel,/if\(importLegKey && pendingFlightCapture\?\.text\)usePendingCapture\(\)/);
});
