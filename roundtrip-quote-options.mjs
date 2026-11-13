// Google Flights results-page quotes are useful draft prices, not booked or
// fully selected round trips. Only exact airport/date matches can prefill a
// linked ticket; the user must still confirm BOTH flights and the final seller.
import {parseGoogleFlightsPage} from './google-flights-text.mjs';
import {parseGoogleFlightsSearchResults,searchOptionMatchesLeg} from './google-flights-search.mjs';
import {matchingTicketSelection} from './roundtrip-tickets.mjs';

export function roundTripQuoteChoices(raw,outbound,returning){
  const selected=parseGoogleFlightsPage(raw);
  if(selected && matchingTicketSelection(selected,outbound,returning)){
    return {kind:'selected_round_trip',selected,
      choices:selected.bookingOptions.filter(q=>Number.isFinite(q.fareEur)&&q.fareEur>=0).map(q=>({
        amount:q.fareEur,seller:q.seller,
        label:`${q.seller} - EUR ${q.fareEur} (both selected flights)`,
        kind:'selected_round_trip'
      }))};
  }
  const found=parseGoogleFlightsSearchResults(raw);
  if(!found)return {kind:'none',selected:null,choices:[]};
  const choices=found.options.filter(option=>
    option.priceScope==='round_trip_search_quote' &&
    Number.isFinite(option.displayedPriceEur) && option.displayedPriceEur>=0 &&
    (searchOptionMatchesLeg(option,outbound)||searchOptionMatchesLeg(option,returning))
  ).map(option=>({
    amount:option.displayedPriceEur,
    seller:'', // A search card names an airline, NOT the final booking seller.
    label:`${option.carrier} ${option.from}-${option.to} ${option.departureClock} - EUR ${option.displayedPriceEur} round-trip search quote`,
    kind:'search_card',carrier:option.carrier,
    from:option.from,to:option.to,date:option.dateISO||'',departureClock:option.departureClock
  }));
  return {kind:'search_results',selected:null,choices};
}
