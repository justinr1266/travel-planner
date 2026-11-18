import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runBestRouteWorkflow} from '../best-routes-workflow.mjs';
const read = file=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

test('generating failure never starts flight research',async()=>{
  let imports=0;
  const result=await runBestRouteWorkflow({generateRoutes:async()=>false,
    getSearchCounts:()=>({all:2,pending:2}),importFlights:async()=>{imports++;}});
  assert.equal(result.status,'generation-failed');assert.equal(imports,0);
});
test('cached and no-flight routes never reopen flight tabs',async()=>{
  let imports=0;
  for(const [counts,status] of [[{all:3,pending:0},'cached'],[{all:0,pending:0},'no-flights']]){
    const result=await runBestRouteWorkflow({generateRoutes:async()=>true,getSearchCounts:()=>counts,
      importFlights:async()=>{imports++;}});
    assert.equal(result.status,status);
  }
  assert.equal(imports,0);
});
test('single action generates before queue, reports stages and preserves failures',async()=>{
  const events=[];
  const result=await runBestRouteWorkflow({
    generateRoutes:async()=>{events.push('generated');return true;},
    getSearchCounts:()=>({all:4,pending:2}),
    importFlights:async()=>{events.push('imported');return {total:2,imported:1,failures:[{error:'manual review'}],stopped:false};},
    onStage:({phase})=>events.push(phase)
  });
  assert.equal(result.status,'needs-review');
  assert.deepEqual(events,['generating','generated','researching','imported']);
});
test('stopping and failed imports are not reported as complete',async()=>{
  for(const [report,status] of [[{stopped:true,failures:[]},'stopped'],[null,'research-failed']]){
    assert.equal((await runBestRouteWorkflow({generateRoutes:async()=>true,
      getSearchCounts:()=>({all:1,pending:1}),importFlights:async()=>report})).status,status);
  }
});
test('traveler panel has one primary discovery action, a progress label and advanced-only generator',()=>{
  const html=read('panel.html');
  const js=read('panel.mjs');
  assert.match(html,/id="findBestRoutes"/);
  assert.match(html,/id="workflowStop"/);
  assert.match(html,/id="workflowStatus"/);
  assert.match(html,/<details class="manual-import-tools">\s*<summary>Advanced: generate routes without researching flights/);
  assert.ok(html.indexOf('id="broadComparison"') < html.indexOf('id="routes"'));
  assert.match(js,/runBestRouteWorkflow\(/);
  assert.match(js,/importFlights:\(\)=>importAllMissingFlights\(\{fromWorkflow:true\}\)/);
  assert.match(js,/generateRoutes:generateCandidateRoutes/);
});
