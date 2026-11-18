// Price import testing is opt-in and scoped to a Chrome extension profile.
// Preserve ordinary trip state and AI/GTFS caches; never persist pricing while on.
export const PRICE_STORAGE_KEYS = Object.freeze([
  'offers', 'roundTripTickets', 'flightResearch', 'broadCache', 'pendingFlightCapture', 'flightTimes'
]);
const PRICE_KEYS = new Set(PRICE_STORAGE_KEYS);
export function persistableSession(session, {priceTestMode = false} = {}) {
  if (!priceTestMode) return session;
  return Object.fromEntries(Object.entries(session).filter(([key]) => !PRICE_KEYS.has(key)));
}
