import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {costSummary,rankRoutes} from '../core.mjs';
import {ticketKey,pairedFlightLegs,pairContainingLeg,matchingTicketSelection,
  matchingTicketsForRoute,ticketsUsingLeg,replaceTicketsForPair,buildRoundTripTicket} from '../roundtrip-tickets.mjs';
import {parseGoogleFlightsPage} from '../google-flights-text.mjs';

const outbound={from:'MAD',to:'SPC',date:'2027-01-11',mode:'flight',key:'MAD|SPC|2027-01-11|flight'};
const returning={from:'SPC',to:'MAD',date:'2027-01-18',mode:'flight',key:'SPC|MAD|2027-01-18|flight'};
const ground={from:'BCN',to:'MAD',date:'2027-01-11',mode:'train',key:'BCN|MAD|2027-01-11|train'};
const trip={id:'madrid-la-palma',legs:[outbound,returning]};
const mixed={id:'train-madrid-la-palma',legs:[ground,outbound,returning]};
const sample=readFileSync(new URL('./fixtures/google-flights-mad-spc-rt.txt',import.meta.url),'utf8');
const accepted={totalEur:'123',seller:'BudgetAir',confirmed:true,baggageVerified:true,
  sourceUrl:'https://www.google.com/travel/flights/search',notes:'Checked 1 overhead carry-on both ways'};
const ticket=buildRoundTripTicket(accepted,outbound,returning,{checkedAt:'2026-11-12T00:00:00Z'});
const tickets={[ticket.id]:ticket};

test('round trip ticket is one all-in amount covering both flight legs',()=>{
  assert.equal(ticket.id,ticketKey(outbound.key,returning.key));
  assert.deepEqual(ticket.legKeys,[outbound.key,returning.key]);
  assert.equal(ticket.totalEur,123);
  assert.equal(ticket.seller,'BudgetAir');
  assert.equal(ticket.baggageVerified,true);
  assert.equal(costSummary(trip,{},tickets).known,123);
  assert.deepEqual(costSummary(trip,{},tickets),{
    complete:true,missing:0,known:123,total:123,pricedLegs:2,ticketCount:1
  });
});
test('round trip ticket can be reused across itineraries containing both exact legs',()=>{
  assert.equal(costSummary(mixed,{},tickets).known,123);
  assert.equal(costSummary(mixed,{},tickets).pricedLegs,2);
  assert.equal(costSummary(mixed,{},tickets).missing,1);
  assert.equal(costSummary(mixed,{},tickets).total,null);
  const priced=costSummary(mixed,{[ground.key]:{fare:50,bagFee:0,transferCost:5}},tickets);
  assert.equal(priced.total,178);
  assert.equal(priced.pricedLegs,3);
  assert.equal(rankRoutes([mixed,trip],{[ground.key]:{fare:50,bagFee:0,transferCost:5}},{tickets})[0].route.id,trip.id);
});
test('a route containing only one of the two legs does not inherit an entire round-trip price',()=>{
  const one={id:'single',legs:[outbound]};
  assert.deepEqual(matchingTicketsForRoute(one,tickets),[]);
  assert.equal(costSummary(one,{},tickets).known,0);
  assert.equal(costSummary(one,{},tickets).complete,false);
  assert.equal(costSummary(one,{},tickets).pricedLegs,0);
});
test('a linked ticket supersedes old per-leg fares without double counting',()=>{
  const oldOffers={[outbound.key]:{fare:83,bagFee:9,transferCost:0},[returning.key]:{fare:80,bagFee:5,transferCost:0}};
  assert.equal(costSummary(trip,oldOffers,tickets).total,123);
  assert.equal(costSummary(trip,oldOffers).total,177);
});
test('one ticket for each of two separate round trips is summed once per pair',()=>{
  const toDublin={from:'MAD',to:'DUB',date:'2027-02-03',mode:'flight',key:'MAD|DUB|2027-02-03|flight'};
  const back={from:'DUB',to:'MAD',date:'2027-02-10',mode:'flight',key:'DUB|MAD|2027-02-10|flight'};
  const second=buildRoundTripTicket({...accepted,totalEur:'80',seller:'Aer Lingus'},toDublin,back);
  const four={id:'all',legs:[...trip.legs,toDublin,back]};
  assert.equal(costSummary(four,{}, {[ticket.id]:ticket,[second.id]:second}).total,203);
  assert.equal(costSummary(four,{}, {[ticket.id]:ticket,[second.id]:second}).pricedLegs,4);
});
test('pair selection requires opposite endpoints and chronological dates',()=>{
  assert.deepEqual(pairedFlightLegs(trip,0),{outbound,returning});
  assert.equal(pairedFlightLegs(trip,1),null);
  assert.equal(pairContainingLeg([mixed,trip],returning.key).outboundIndex,1);
  assert.throws(()=>buildRoundTripTicket(accepted,outbound,{...returning,from:'TFN'}),/opposite-direction/);
  assert.throws(()=>buildRoundTripTicket(accepted,outbound,{...returning,date:'2027-01-10'}),/after outbound/);
});
test('price saving requires explicit confirmed full ticket, seller, and bag coverage',()=>{
  assert.throws(()=>buildRoundTripTicket({...accepted,confirmed:false},outbound,returning),/Confirm both flights/);
  assert.throws(()=>buildRoundTripTicket({...accepted,baggageVerified:false},outbound,returning),/all-in baggage/);
  assert.throws(()=>buildRoundTripTicket({...accepted,totalEur:''},outbound,returning),/checked round-trip/);
  assert.throws(()=>buildRoundTripTicket({...accepted,totalEur:'-1'},outbound,returning),/nonnegative/);
  assert.throws(()=>buildRoundTripTicket({...accepted,seller:' '},outbound,returning),/booking seller/);
  assert.throws(()=>buildRoundTripTicket({...accepted,sourceUrl:'javascript:alert(1)'},outbound,returning),/http/);
});
test('replacing one ticket eliminates overlapping shared tickets',()=>{
  const otherReturn={...returning,date:'2027-01-19',key:'SPC|MAD|2027-01-19|flight'};
  const alternate=buildRoundTripTicket({...accepted,totalEur:145},outbound,otherReturn);
  const combined=replaceTicketsForPair(tickets,alternate);
  assert.equal(Object.hasOwn(combined,ticket.id),false);
  assert.equal(Object.keys(combined).length,1);
  assert.equal(ticketsUsingLeg(combined,outbound.key).length,1);
});
test('the exact pasted selected round trip must match BOTH directions before prefilling seller quotes',()=>{
  const captured=parseGoogleFlightsPage(sample);
  assert.ok(matchingTicketSelection(captured,outbound,returning));
  assert.equal(captured.bookingOptions.find(o=>o.seller==='BudgetAir').fareEur,123);
  assert.equal(captured.bookingOptions.find(o=>o.seller==='Binter Canarias').fareEur,156);
  assert.equal(matchingTicketSelection(captured,outbound,{...returning,date:'2027-01-19'}),false);
  assert.equal(matchingTicketSelection(captured,{...outbound,to:'TFN'},returning),false);
});
test('UI saves one linked ticket instead of assigning quote to each leg',()=>{
  const html=readFileSync(new URL('../panel.html',import.meta.url),'utf8');
  const js=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  assert.match(html,/id="ticketEditor"/);
  assert.match(html,/id="ticketConfirmed"/);
  assert.match(html,/id="ticketBagVerified"/);
  assert.match(html,/Save shared round-trip EUR total/);
  assert.match(js,/roundTripTickets=replaceTicketsForPair\(roundTripTickets,ticket\)/);
  assert.match(js,/delete offers\[outbound.key\];delete offers\[returning.key\]/);
  assert.match(js,/tickets:roundTripTickets/);
  assert.match(js,/roundTripTickets = saved.roundTripTickets/);
  assert.match(js,/Price as round trip €/);
  assert.match(js,/data-open-ticket-from-import/);
  assert.match(js,/roundTripTickets=\{\}/);
});
