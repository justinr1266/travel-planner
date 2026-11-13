// Final guardrail between an AI interpretation and a user-visible itinerary.
// No country-specific destinations: every explicit place is resolved through
// the same airport directory as Stage A. This never invents a different place.
import { findExplicitPreferred, resolveLocation, LOCATION_RECORDS } from './location-resolver.mjs';

export function protectReviewedTrip(form, {parsedPlan=null,parsedRequest='',records=LOCATION_RECORDS}={}) {
  const trip={...form};
  const notices=[];
  const request=String(form.request||'').trim();
  if (!request || !parsedRequest || request!==parsedRequest.trim())
    return {trip,notices,error:null};

  // A named vacation destination in the traveler's actual text outranks a
  // hallucinated IATA code or a stale selection left over from another trip.
  // Never override a country-level or open-ended discovery request.
  if (trip.destinationSearch==='specified') {
    const start=resolveLocation(trip.origin,{records});
    const end=resolveLocation(trip.destination,{records});
    const country=start && end && start.country===end.country ? start.country : null;
    const explicit=findExplicitPreferred(request,{records,country});
    if (explicit && trip.preferred!==explicit.code) {
      notices.push(`Corrected primary destination from ${trip.preferred||'(none)'} to ${explicit.code} because your request says "${explicit.evidence}".`);
      trip.preferred=explicit.code;
    }
  }

  // Do not let a reviewed, exact return date silently become a different
  // day in the candidate route generator. Manual edits remain possible once
  // the traveler updates/re-interprets the request that sets the constraint.
  if (parsedPlan?.fixed_arrival===true && parsedPlan.arrive_latest &&
      trip.endDate!==parsedPlan.arrive_latest)
    return {trip,notices,error:`The final date in the form (${trip.endDate}) differs from the fixed date in your interpreted request (${parsedPlan.arrive_latest}). Correct the form or update and reinterpret the request before generating routes.`};
  if (parsedPlan?.fixed_departure===true && parsedPlan.depart_earliest &&
      trip.startDate!==parsedPlan.depart_earliest)
    return {trip,notices,error:`The departure date in the form (${trip.startDate}) differs from the fixed date in your interpreted request (${parsedPlan.depart_earliest}). Correct the form or update and reinterpret the request before generating routes.`};
  return {trip,notices,error:null};
}
