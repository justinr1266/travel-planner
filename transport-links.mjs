// Navigation shortcuts only: departure dates, timetables, ticket availability
// and fares must be verified on the provider's site.
import {googleFlightsSearchUrl} from './search-links.mjs';
import {TRAVEL_MODES} from './multimodal.mjs';

function label(leg,side){return leg[`${side}Label`]||leg[side];}
export function transportSearch(leg){
  if(!TRAVEL_MODES.includes(leg?.mode))throw new Error('Unknown transport mode.');
  if(leg.mode==='flight')return {url:googleFlightsSearchUrl(leg),provider:'Google Flights',datePreFilled:true};
  if(leg.mode==='ferry')return {url:'https://www.ferryhopper.com/',provider:'Ferryhopper',datePreFilled:false};
  const url=new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api','1');
  url.searchParams.set('origin',label(leg,'from'));
  url.searchParams.set('destination',label(leg,'to'));
  url.searchParams.set('travelmode','transit');
  if(leg.mode==='train')return {url:url.href,provider:'Google Maps transit directions (rail)',datePreFilled:false};
  if(leg.mode==='bus')return {url:url.href,provider:'Google Maps transit directions (bus)',datePreFilled:false};
  return {url:url.href,provider:'Google Maps transit directions (transfer)',datePreFilled:false};
}
