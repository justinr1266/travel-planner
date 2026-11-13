import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

test('Chrome capture uses user-highlighted text only, no tab scraping or host permissions',async()=>{
  const registered=[];const menuCallbacks=[];const clickCallbacks=[];const saved=[];
  globalThis.chrome={
    sidePanel:{setPanelBehavior:async()=>{}},
    runtime:{onInstalled:{addListener:fn=>registered.push(fn)}},
    contextMenus:{create:o=>menuCallbacks.push(o),onClicked:{addListener:fn=>clickCallbacks.push(fn)}},
    storage:{local:{set:o=>saved.push(o)}}
  };
  try{
    await import('../service-worker.js?test=selection');
    assert.equal(registered.length,1);
    registered[0]();
    assert.deepEqual(menuCallbacks[0].contexts,['selection']);
    clickCallbacks[0]({menuItemId:'routewise-selected-flight',selectionText:'08:30 — 10:15 €90',pageUrl:'https://www.google.com/travel/flights/' });
    assert.equal(saved.length,1);
    assert.equal(saved[0].pendingFlightCapture.text,'08:30 — 10:15 €90');
    assert.equal(saved[0].pendingFlightCapture.sourceUrl,'https://www.google.com/travel/flights/');
    clickCallbacks[0]({menuItemId:'something-else',selectionText:'should not save'});
    assert.equal(saved.length,1);
    clickCallbacks[0]({menuItemId:'routewise-selected-flight',selectionText:'yes',pageUrl:'chrome://settings'});
    assert.equal(saved[1].pendingFlightCapture.sourceUrl,'');
  }finally{delete globalThis.chrome;}
});
test('integration keeps existing one-way and round-trip links and offers an import per flight',()=>{
  const base=fileURLToPath(new URL('../',import.meta.url));
  const panel=fs.readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  const manifest=JSON.parse(fs.readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.ok(!manifest.host_permissions.some(x=>x.includes('google.com')));
  assert.match(panel,/data-import-flight/);
  assert.match(panel,/googleFlightsRoundTripUrl/);
  assert.match(panel,/flightResearch\[leg.key\]=reviewed.research/);
  assert.match(panel,/flightTimes\[leg.key\]=reviewed.flightTime/);
  assert.match(panel,/offers\[leg.key\]=reviewed.offer/);
});
