// Full-session reset is intentionally separate from the price-only test reset.
// Do not use chrome.storage.local.clear(): baggage and developer settings must survive.
export const PLANNING_RESET_KEYS = Object.freeze([
  'trip', 'routes', 'manualRoutes', 'offers', 'roundTripTickets',
  'flightTimes', 'groundTimes', 'flightResearch', 'broadCache', 'trainCache',
  'pendingFlightCapture', 'destinationCandidates', 'destinationCandidateKey',
  'connectionCandidates', 'connectionCandidateKey', 'parsedPlan',
  'parseWarnings', 'parseSource', 'parsedRequest', 'parseDebug',
  'lastAiInterpretation', 'priceImportResetRequest', 'developerEvents',
  'sessionCleared', 'planningResetRequest'
]);

export function resetTripKeepingDescription(current) {
  const old = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  return {
    ...old, origin:'', preferred:'', destination:'', requestedRegion:'',
    destinationSearch:'specified', startDate:'', endDate:'',
    request:typeof old.request==='string' ? old.request : ''
  };
}

export async function resetPlanningSession(storage, {requestId}={}) {
  if(!storage || typeof storage.get!=='function' || typeof storage.remove!=='function' || typeof storage.set!=='function') {
    throw new TypeError('Expected Chrome local storage interface.');
  }
  const before=await storage.get('trip');
  const trip=resetTripKeepingDescription(before?.trip);
  // First delete persisted planning data, then signal active side panels to
  // reload. This prevents automatic route regeneration from stale state.
  await storage.remove(PLANNING_RESET_KEYS);
  await storage.set({trip,routes:[],manualRoutes:[],sessionCleared:true,
    planningResetRequest:requestId || crypto.randomUUID()});
  return {trip,clearedKeys:PLANNING_RESET_KEYS.length};
}
