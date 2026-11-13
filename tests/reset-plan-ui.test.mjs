import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../panel.html', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../panel.mjs', import.meta.url), 'utf8');
test('traveler has an explicit non-submit reset control that retains trip description',()=>{
  assert.match(html, /id="resetPlan" type="button"/);
  assert.match(panel, /const description=\$\('request'\)\.value/);
  assert.match(panel, /startDate:'',endDate:'',request:description/);
  assert.match(panel, /sessionCleared=true/);
});
test('reset preserves existing fare and research caches',()=>{
  const reset=panel.split("$('resetPlan').addEventListener('click', async()=>{")[1]?.split("$('connectionBuffer').addEventListener")[0];
  assert.ok(reset);
  assert.doesNotMatch(reset,/\b(?:offers|roundTripTickets|broadCache|destinationCandidates|connectionCandidates|bag|lastAiInterpretation)\s*=/);
  assert.match(reset,/await persist\(\)/);
});
test('reset does not call Groq and interpretation can reuse last result',()=>{
  const reset=panel.split("$('resetPlan').addEventListener('click', async()=>{")[1]?.split("$('connectionBuffer').addEventListener")[0];
  assert.doesNotMatch(reset,/\bfetch\(/);
  assert.match(panel,/lastAiInterpretation\.referenceDate===referenceDate/);
  assert.match(panel,/Restored your earlier AI interpretation from this device \(no Groq request\)/);
});
test('reset stays empty through reload until traveler regenerates routes',()=>{
  assert.match(panel,/function visibleRoutes\(\) \{ return sessionCleared \? \[\]/);
  assert.match(panel,/if \(!routes\.length && !sessionCleared\)/);
  assert.match(panel,/trip=next;routes=nextRoutes;sessionCleared=false/);
});
