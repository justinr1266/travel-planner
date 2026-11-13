import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseGoogleFlightsSearchResults,searchOptionMatchesLeg} from '../google-flights-search.mjs';
import {parseFlightSelection,buildReviewedFlight} from '../flight-research.mjs';

const source=readFileSync(new URL('../flights-overlay.js',import.meta.url),'utf8');
const sandbox={module:{exports:{}}};
vm.runInNewContext(source,sandbox);
const {cardRecord,collectCards,capturePayload}=sandbox.module.exports;
const returnLeg={key:'SPC|MAD|2027-01-18|flight',from:'SPC',to:'MAD',date:'2027-01-18',mode:'flight'};
function leaf(text,aria=''){
  return {children:[],textContent:text,getAttribute:key=>key==='aria-label'?aria:''};
}
function flightCard({airline='Iberia Express',depart='2:15 PM',arrive='6:05 PM',price=82,
  stops=0,scope='',summary=true,dateInMetadata=false,combinedCodes=true,visible=true}={}){
  const label=`${scope?`From ${price} euros ${scope}. `:''}${stops?'1 stop':'Nonstop'} flight with ${airline}. Leaves La Palma Airport at ${depart} on Monday, January 18 and arrives at Madrid-Barajas Airport at ${arrive} on Monday, January 18. Total duration 2 hr 50 min. Select flight`;
  const accessibility=[leaf('',`Departure time: ${depart}.`),leaf('',`Arrival time: ${arrive}.`)];
  if(summary)accessibility.unshift(leaf('',label));
  const leaves=[...(combinedCodes?[leaf('SPC–MAD')]:[leaf('SPC'),leaf('MAD')]),
    leaf('Mon, Jan 18'),leaf(airline),leaf(stops?'1 stop':'Nonstop'),leaf(`€${price}`)];
  const link=summary?{getAttribute:key=>key==='aria-label'?label:''}:null;
  const card={
    textContent:leaves.map(x=>x.textContent).join(' '),
    querySelector:sel=>sel.includes('[role="link"]')?link:
      sel==='.Ir0Voe .sSHqwe'?leaf(airline):sel==='.h1fkLb'?leaf(airline):null,
    querySelectorAll:sel=>{
      if(sel==='[aria-label]')return accessibility;
      if(sel==='div,span'||sel==='span,div')return leaves;
      if(sel==='[data-travelimpactmodelwebsiteurl]')return dateInMetadata?[{
        getAttribute:()=> 'https://www.travelimpactmodel.org/lookup/flight?itinerary=SPC-LPA-NT-700-20270118'
      }]:[];
      return [];
    },
    getClientRects:()=>visible?[{left:20,top:20,right:700,bottom:100}]:[]
  };
  if(link)link.closest=sel=>sel==='li'?card:null;
  return {card,link};
}

test('one-way Google Flights screenshot-style card is recognized even with no "From ... round trip" label',()=>{
  const {card}=flightCard();
  const record=cardRecord(card);
  assert.ok(record);
  assert.equal(record.from,'SPC');assert.equal(record.to,'MAD');
  assert.equal(record.dateLabel,'Monday, January 18');
  assert.equal(record.price,82);assert.equal(record.priceScope,'displayed_search_quote');
  const parsed=parseGoogleFlightsSearchResults(record.snapshot);
  assert.equal(parsed.options.length,1);
  const option=parsed.options[0];
  assert.equal(option.departureClock,'14:15');assert.equal(option.arrivalClock,'18:05');
  assert.equal(option.displayedPriceEur,82);assert.equal(option.quotedRoundTripEur,null);
  assert.equal(option.stops,0);assert.equal(option.carrier,'Iberia Express');
  assert.equal(searchOptionMatchesLeg(option,returnLeg),true);
  assert.equal(searchOptionMatchesLeg(option,{...returnLeg,date:'2027-01-11'}),false);
});

test('result card uses independent visible price, airport codes, and departure/arrival accessibility labels',()=>{
  const {card}=flightCard({summary:false,price:84,airline:'Binter Canarias',stops:1,dateInMetadata:true});
  const record=cardRecord(card);
  assert.ok(record,'card should not require a full summary or the words "round trip"');
  const option=parseGoogleFlightsSearchResults(record.snapshot).options[0];
  assert.equal(option.dateISO,'2027-01-18');
  assert.deepEqual([option.from,option.to],['SPC','MAD']);
  assert.equal(option.stops,1);assert.equal(option.displayedPriceEur,84);
  assert.equal(option.departureClock,'14:15');
});

test('one-way and round-trip quotes remain distinct and never auto-save into the fare field',()=>{
  const oneWay=cardRecord(flightCard({price:82,scope:'one way total'}).card);
  const roundTrip=cardRecord(flightCard({price:163,scope:'round trip total'}).card);
  const payload=capturePayload([oneWay,roundTrip],'https://www.google.com/travel/flights/search');
  const parsed=parseGoogleFlightsSearchResults(payload.text);
  assert.equal(parsed.options.length,2);
  assert.deepEqual(parsed.options.map(x=>x.priceScope),['one_way_search_quote','round_trip_search_quote']);
  assert.deepEqual(parsed.options.map(x=>x.quotedOneWayEur),[82,null]);
  assert.deepEqual(parsed.options.map(x=>x.quotedRoundTripEur),[null,163]);
  const selected=parseFlightSelection(payload.text,{leg:returnLeg});
  assert.equal(selected.fareEur,null);
  const form={confirmed:true,mode:'fare',departureClock:'14:15',arrivalClock:'18:05',
    departureTimezone:'Atlantic/Canary',stops:'0',fareEur:'82',bagStatus:'included',bagFee:'0',
    sourceUrl:'https://www.google.com/travel/flights/search',rawSelectionText:payload.text};
  assert.throws(()=>buildReviewedFlight(form,returnLeg),/round-trip price/i);
});

test('page import returns 3 separate one-way choices from a return-leg search screen',()=>{
  const all=[flightCard({price:82}),flightCard({airline:'Binter Canarias',price:84,stops:1}),
    flightCard({airline:'Iberia',price:87})];
  const cards=collectCards({querySelectorAll:selector=>selector==='li'?
    all.map(x=>x.card):selector.startsWith('[role="link"]')?all.map(x=>x.link):[]});
  assert.equal(cards.length,3);
  const imported=parseGoogleFlightsSearchResults(capturePayload(cards,'https://www.google.com/travel/flights').text);
  assert.equal(imported.options.length,3);
  assert.deepEqual(imported.options.map(o=>o.displayedPriceEur),[82,84,87]);
  assert.ok(imported.options.every(o=>o.priceScope==='displayed_search_quote'));
});

test('non-flight list items and offscreen hidden cards are skipped',()=>{
  const hidden=flightCard({visible:false}).card;
  const unrelated={querySelectorAll:()=>[],querySelector:()=>null,getClientRects:()=>[{}]};
  const result=collectCards({querySelectorAll:selector=>selector==='li'?[unrelated,hidden]:[]});
  assert.equal(result.length,0);
});

test('plain copied one-way Google Flights results can also be imported',()=>{
  const copied=`Loading results\nSanta Cruz de La Palma\nMadrid\nMon, Jan 18\nTop flights\nRanked based on price and convenience\n\n2:15 PM – \n6:05 PM\nIberia Express\n2 hr 50 min\nSPC–MAD\nNonstop\n–\n€82\n\n8:30 AM – \n2:05 PM\nBinter CanariasOperated by Naysa\n4 hr 35 min\nSPC–MAD\n1 stop\n1 hr 5 min TFN\n201 kg CO2e\n€84\n\nAbout\nPrivacy`;
  const parsed=parseGoogleFlightsSearchResults(copied);
  assert.equal(parsed.options.length,2);
  assert.deepEqual(parsed.options.map(o=>o.quotedRoundTripEur),[null,null]);
  assert.deepEqual(parsed.options.map(o=>o.displayedPriceEur),[82,84]);
  assert.ok(parsed.options.every(o=>searchOptionMatchesLeg(o,returnLeg)));
});
