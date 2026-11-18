import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PRICE_STORAGE_KEYS, persistableSession} from '../price-test-mode.mjs';
const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('normal mode persists imported prices and verified fares', () => {
  const input = {trip:{request:'Barcelona to La Palma'},offers:{a:1},broadCache:{b:2},roundTripTickets:{c:3},flightResearch:{d:4}};
  assert.deepEqual(persistableSession(input), input);
});
test('test mode excludes only pricing entries and preserves AI/GTFS-relevant state', () => {
  const input = {trip:{request:'Barcelona to La Palma'},bag:{kg:8},offers:{a:1},broadCache:{b:2},roundTripTickets:{c:3},flightResearch:{d:4},pendingFlightCapture:{text:'€99'},lastAiInterpretation:{request:'same'},connectionCandidates:{outbound:[]},routes:[1],groundTimes:{a:7}};
  const stored=persistableSession(input,{priceTestMode:true});
  assert.deepEqual(Object.keys(stored).sort(),['bag','connectionCandidates','groundTimes','lastAiInterpretation','routes','trip'].sort());
  assert.deepEqual(stored.trip, input.trip);
  assert.deepEqual([...PRICE_STORAGE_KEYS].sort(), ['broadCache','flightResearch','flightTimes','offers','pendingFlightCapture','roundTripTickets'].sort());
});
test('the traveler panel restores test mode before rendering and clears stale prices', () => {
  const ui=source('panel.mjs');
  assert.match(ui,/priceTestMode = saved\.priceTestMode === true;/);
  assert.match(ui,/if\(priceTestMode\)\{\s*clearPriceImportSessionState\(\);/);
  assert.match(ui,/chrome\.storage\.local\.remove\(PRICE_STORAGE_KEYS\)/);
  assert.match(ui,/persistableSession\(session, \{priceTestMode\}\)/);
});
test('developer console exposes an explicit toggle and asks before deleting saved fares', () => {
  assert.match(source('developer.html'),/id="priceTestMode"/);
  assert.match(source('developer.mjs'),/if\(enabled && !confirm\(/);
  assert.match(source('developer.mjs'),/chrome\.storage\.local\.remove\(PRICE_STORAGE_KEYS\)/);
});
