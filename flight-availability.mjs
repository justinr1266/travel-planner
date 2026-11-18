// A missing price or failed import is NOT evidence that a flight does not exist.
// User confirmation or an explicit no-options result on an exact Google Flights search can exclude candidates.
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const CODE=/^[A-Z]{3}$/;
export function flightAvailabilityKey(leg){
  if(leg?.mode!=='flight'||!CODE.test(leg.from||'')||!CODE.test(leg.to||'')||
     leg.from===leg.to||!DATE.test(leg.date||''))return null;
  return [leg.from,leg.to,leg.date,'economy','EUR','1adult'].join('|');
}
export function hasNoFlightsResult(key,unavailable={}){
  return typeof key==='string' && !!unavailable && unavailable[key]?.status==='no_flights' &&
    ['user_review','google_flights_exact_search'].includes(unavailable[key]?.source);
}
export function excludeUnavailableFlightRoutes(routes=[],unavailable={}){
  if(!Array.isArray(routes))return [];
  return routes.filter(route=>!Array.isArray(route?.legs) || !route.legs.some(leg=>
    hasNoFlightsResult(flightAvailabilityKey(leg),unavailable)));
}
