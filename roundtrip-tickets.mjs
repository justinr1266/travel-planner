// A round-trip is ONE priced booking covering two exact, reverse-direction
// flight legs. Never allocate its total to a single leg or infer a return
// selection from an outbound Google Flights search quote.
import {parseISODate} from './core.mjs';
import {findRoundTripPairs} from './search-links.mjs';
import {matchingRoundTripDirection} from './google-flights-text.mjs';

export function ticketKey(outboundKey,returnKey){
  return JSON.stringify([outboundKey,returnKey]);
}
export function pairedFlightLegs(route,outboundIndex){
  if(!Array.isArray(route?.legs))return null;
  const pair=findRoundTripPairs(route.legs).find(p=>p.outboundIndex===outboundIndex);
  if(!pair)return null;
  return {outbound:route.legs[pair.outboundIndex],returning:route.legs[pair.returnIndex]};
}
export function pairContainingLeg(routes,key){
  for(const route of routes){
    for(const {outboundIndex,returnIndex} of findRoundTripPairs(route.legs)){
      if(route.legs[outboundIndex].key===key||route.legs[returnIndex].key===key){
        return {route,outboundIndex,returnIndex,outbound:route.legs[outboundIndex],returning:route.legs[returnIndex]};
      }
    }
  }
  return null;
}
export function matchingTicketSelection(parsed,outbound,returning){
  return Boolean(parsed && matchingRoundTripDirection(parsed,outbound)==='outbound' &&
    matchingRoundTripDirection(parsed,returning)==='return');
}
function nonnegativeMoney(value){
  if(value===''||value===null||value===undefined)throw new Error('Enter the checked round-trip EUR total.');
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>1000000)throw new Error('Round-trip total must be a nonnegative EUR amount.');
  return Math.round(n*100)/100;
}
export function buildRoundTripTicket(input,outbound,returning,{checkedAt=new Date().toISOString()}={}){
  if(outbound?.mode!=='flight'||returning?.mode!=='flight'||!outbound.key||!returning.key ||
     outbound.from!==returning.to || outbound.to!==returning.from || outbound.from===outbound.to){
    throw new Error('Select two opposite-direction flight legs belonging to the same round trip.');
  }
  if(parseISODate(returning.date)<=parseISODate(outbound.date))throw new Error('Return flight must depart after outbound flight.');
  if(input.confirmed!==true || input.baggageVerified!==true){
    throw new Error('Confirm both flights, the booking seller, and all-in baggage/fee coverage before saving.');
  }
  const totalEur=nonnegativeMoney(input.totalEur);
  const seller=String(input.seller??'').trim().slice(0,100);
  if(!seller)throw new Error('Enter the booking seller for the checked round-trip price.');
  const sourceUrl=String(input.sourceUrl??'').trim();
  if(sourceUrl){
    const parsed=new URL(sourceUrl);
    if(!['https:','http:'].includes(parsed.protocol))throw new Error('Ticket source URL must be http(s).');
  }
  return {
    id:ticketKey(outbound.key,returning.key),legKeys:[outbound.key,returning.key],
    outbound:{from:outbound.from,to:outbound.to,date:outbound.date},
    returning:{from:returning.from,to:returning.to,date:returning.date},
    totalEur,seller,sourceUrl,notes:String(input.notes??'').trim().slice(0,500),
    baggageVerified:true,checkedAt
  };
}
export function matchingTicketsForRoute(route,tickets={}){
  const matches=[];
  const used=new Set();
  for(const {outboundIndex,returnIndex} of findRoundTripPairs(route?.legs||[])){
    const outbound=route.legs[outboundIndex],returning=route.legs[returnIndex];
    const key=ticketKey(outbound.key,returning.key);
    const ticket=tickets?.[key];
    if(!ticket||ticket.id!==key||!Array.isArray(ticket.legKeys)||
      ticket.legKeys[0]!==outbound.key||ticket.legKeys[1]!==returning.key||
      !Number.isFinite(ticket.totalEur)||ticket.totalEur<0||
      used.has(outbound.key)||used.has(returning.key))continue;
    used.add(outbound.key);used.add(returning.key);
    matches.push({ticket,outboundIndex,returnIndex});
  }
  return matches;
}
export function ticketsUsingLeg(tickets,key){
  return Object.values(tickets||{}).filter(t=>Array.isArray(t?.legKeys)&&t.legKeys.includes(key));
}
export function replaceTicketsForPair(tickets,newTicket){
  const result={};
  for(const [key,ticket] of Object.entries(tickets||{})){
    if(!ticket?.legKeys?.some(legKey=>newTicket.legKeys.includes(legKey)))result[key]=ticket;
  }
  result[newTicket.id]=newTicket;
  return result;
}
