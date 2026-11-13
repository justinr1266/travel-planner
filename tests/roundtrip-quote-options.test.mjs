import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {roundTripQuoteChoices} from '../roundtrip-quote-options.mjs';
import {parseGoogleFlightsSearchResults} from '../google-flights-search.mjs';

const outbound={key:'MAD|SPC|2027-01-11|flight',from:'MAD',to:'SPC',date:'2027-01-11',mode:'flight'};
const returning={key:'SPC|MAD|2027-01-18|flight',from:'SPC',to:'MAD',date:'2027-01-18',mode:'flight'};
const list=readFileSync(new URL('./fixtures/google-flights-search-mad-spc.txt',import.meta.url),'utf8');
const detail=readFileSync(new URL('./fixtures/google-flights-mad-spc-rt.txt',import.meta.url),'utf8');
const overlay=readFileSync(new URL('../flights-overlay.js',import.meta.url),'utf8');
const sandbox={module:{exports:{}}};vm.runInNewContext(overlay,sandbox);
const {capturePayload}=sandbox.module.exports;
const card=(carrier,amount,date='2027-01-11',from='MAD',to='SPC',scope='round_trip_search_quote')=>`<li data-routewise-from="${from}" data-routewise-to="${to}" data-routewise-date="${date}" data-routewise-departure="11:30" data-routewise-arrival="13:35" data-routewise-carrier="${carrier}" data-routewise-stops="0" data-routewise-price="${amount}" data-routewise-price-scope="${scope}"></li>`;

test('single imported Google Flights card prefills a linked-ticket DRAFT but not a booking seller',()=>{
  const payload=capturePayload([{snapshot:card('Binter Canarias',131)}],'https://www.google.com/travel/flights/search');
  assert.equal(payload.captureMode,'card');
  const result=roundTripQuoteChoices(payload.text,outbound,returning);
  assert.equal(result.kind,'search_results');
  assert.equal(result.choices.length,1);
  assert.equal(result.choices[0].amount,131);
  assert.equal(result.choices[0].seller,'');
  assert.equal(result.choices[0].kind,'search_card');
});
test('full results list gives six separate selectable round-trip estimates',()=>{
  const result=roundTripQuoteChoices(list,outbound,returning);
  assert.equal(result.kind,'search_results');
  assert.deepEqual(result.choices.map(q=>q.amount),[131,163,172,131,131,131]);
  assert.deepEqual(result.choices.slice(1,3).map(q=>q.carrier),['Iberia Express','Iberia']);
});
test('capture matches return-leg cards only when quote is explicitly for a round trip',()=>{
  const matching=roundTripQuoteChoices(card('Iberia Express',132,'2027-01-18','SPC','MAD'),outbound,returning);
  assert.equal(matching.choices.length,1);
  assert.equal(matching.choices[0].amount,132);
  const oneWay=roundTripQuoteChoices(card('Iberia Express',82,'2027-01-18','SPC','MAD','one_way_search_quote'),outbound,returning);
  assert.equal(oneWay.choices.length,0);
  const unknown=roundTripQuoteChoices(card('Iberia Express',82,'2027-01-18','SPC','MAD','displayed_search_quote'),outbound,returning);
  assert.equal(unknown.choices.length,0);
});
test('captured quotes for unrelated airport pairs or dates do not prefill a ticket',()=>{
  for(const html of [
    card('Iberia Express',163,'2027-01-12'),
    card('Iberia Express',163,'2027-01-11','BCN','SPC'),
    card('Iberia Express',163,'2028-01-11')
  ])assert.equal(roundTripQuoteChoices(html,outbound,returning).choices.length,0);
});
test('fully selected round-trip page retains verified booking seller candidates, not search-card behavior',()=>{
  const result=roundTripQuoteChoices(detail,outbound,returning);
  assert.equal(result.kind,'selected_round_trip');
  assert.ok(result.choices.some(q=>q.amount===123&&q.seller==='BudgetAir'));
  assert.ok(result.choices.some(q=>q.amount===156&&q.seller==='Binter Canarias'));
});
test('the card importer now auto-prefills the OPEN ticket editor without saving a price',()=>{
  const panel=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  const html=readFileSync(new URL('../panel.html',import.meta.url),'utf8');
  assert.match(panel,/if\(ticketEditorPair && pendingFlightCapture\?\.text\)/);
  assert.match(panel,/updateTicketQuotesFromCapture\(pendingFlightCapture.text,pendingFlightCapture.sourceUrl\|\|'',\{autoPrefillSingle:true\}\)/);
  assert.match(panel,/if\(autoPrefillSingle && kind==='search_results' && choices.length===1\)/);
  assert.match(panel,/\$\('ticketTotal'\)\.value=String\(quote.amount\)/);
  assert.match(panel,/\$\('ticketSeller'\)\.value=quote.seller/);
  assert.match(panel,/\$\('ticketConfirmed'\)\.checked=false/);
  assert.match(panel,/\$\('ticketBagVerified'\)\.checked=false/);
  assert.match(html,/id="ticketQuoteHelp"/);
  assert.match(panel,/data-price-search-option/);
});
