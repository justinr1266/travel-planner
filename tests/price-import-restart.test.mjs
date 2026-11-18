import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PRICE_STORAGE_KEYS, persistableSession} from '../price-test-mode.mjs';
const src = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('price test clearing includes flight timing and all quote state but not planning caches', () => {
  assert.deepEqual([...PRICE_STORAGE_KEYS].sort(), [
    'offers', 'roundTripTickets', 'flightResearch', 'broadCache', 'pendingFlightCapture', 'flightTimes'
  ].sort());
  const input={offers:{a:1},flightTimes:{b:2},roundTripTickets:{c:3},broadCache:{d:4},
    flightResearch:{e:5},pendingFlightCapture:{text:'test'},routes:[{id:'route'}],
    trip:{request:'same'},bag:{kg:8},lastAiInterpretation:{cached:true},
    connectionCandidates:{outbound:[]},groundTimes:{a:1},manualRoutes:[{id:'custom'}]};
  const kept=persistableSession(input,{priceTestMode:true});
  assert.deepEqual(Object.keys(kept).sort(),[
    'routes','trip','bag','lastAiInterpretation','connectionCandidates','groundTimes','manualRoutes'
  ].sort());
});
test('restart uses the same generated route list and returns to the initial flight import queue', () => {
  const panel=src('panel.mjs');
  const reset=panel.slice(panel.indexOf('async function restartPriceImportTest()'),panel.indexOf('async function persist()'));
  assert.match(reset,/clearPriceImportSessionState\(\)/);
  assert.match(reset,/flightImport'\)\.hidden = true/);
  assert.match(reset,/broadBatchProgress/);
  assert.match(reset,/chrome\.storage\.local\.remove\(PRICE_STORAGE_KEYS\)/);
  assert.match(reset,/render\(\)/);
  assert.doesNotMatch(reset,/routes\s*=|generateCandidateRoutes\(/);
  assert.doesNotMatch(reset,/fetch\(|suggest-connections|api\.groq/);
});
test('developer console can restart while testing and signals an open side panel', () => {
  assert.match(src('developer.html'),/id="restartPriceImportTest"/);
  const dev=src('developer.mjs');
  assert.match(dev,/restartPriceImportTest'\)\.disabled = saved\.priceTestMode !== true/);
  assert.match(dev,/priceImportResetRequest:crypto\.randomUUID\(\)/);
  const panel=src('panel.mjs');
  assert.match(panel,/changes\.priceImportResetRequest && priceTestMode/);
});
