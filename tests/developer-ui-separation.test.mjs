import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('traveler side panel has trip, bag, routes, and flight research in that order', () => {
  const html = source('panel.html');
  const ids = ['tripSetup', 'bagProfile', 'routeResults', 'routes', 'broadResearch'];
  const positions = ids.map(id => html.indexOf(`id="${id}"`));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(html, /id="interpret"/);
  assert.match(html, /id="showGoogleFlightsOverlay"/);
  assert.match(html, /id="broadOpenNext"/);
});

test('sample and developer diagnostics are absent from traveler UI', () => {
  const html = source('panel.html');
  const js = source('panel.mjs');
  assert.doesNotMatch(html, /id="sampleParse"|id="domDemo"|Developer diagnostics|Raw Groq object/);
  assert.doesNotMatch(js, /class="parse-debug"|\$\('sampleParse'\)|\$\('domDemo'\)/);
  assert.match(html, /id="export"/);
  assert.match(html, /id="clearOffers"/);
});

test('developer tab owns diagnostics and sample tests without changing traveler data', () => {
  const html = source('developer.html');
  const js = source('developer.mjs');
  for (const id of ['sampleParse', 'domDemo', 'rawGroq', 'normalizedPlan', 'corrections',
    'clientCorrections', 'groqTiming', 'researchDetails', 'eventLog', 'clearEvents']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /validateTripPlan\(DEMO_PLAN\)/);
  assert.doesNotMatch(js, /chrome\.storage\.local\.set\(\{\s*trip/);
  assert.match(source('service-worker.js'), /contexts:\['action'\]/);
  assert.match(source('service-worker.js'), /chrome\.runtime\.getURL\('developer\.html'\)/);
});

test('status events are bounded and debug result remains local', () => {
  const js = source('panel.mjs');
  assert.match(js, /developerEvents: \[\.\.\.entries\.slice\(-49\)/);
  assert.match(js, /parseDebug\}/);
  assert.match(source('developer.mjs'), /chrome\.storage\.local\.get\(/);
});
