import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runFlightImportQueue} from '../research-queue.mjs';

const tasks = [
  {key:'BCN-SPC-11',leg:{from:'BCN',to:'SPC',date:'2027-01-11'}},
  {key:'SPC-MAD-18',leg:{from:'SPC',to:'MAD',date:'2027-01-18'}},
  {key:'MAD-BCN-18',leg:{from:'MAD',to:'BCN',date:'2027-01-18'}}
];

test('batch skips cached and duplicate flights, waits for each result, and reuses its successful tab', async()=>{
  const seen=[];
  const report=await runFlightImportQueue([tasks[0],tasks[0],tasks[1],tasks[2]],{
    isCached:task=>task.key===tasks[1].key,
    importTask:async(task,{reuseTabId})=>{
      seen.push({key:task.key,reuseTabId});
      return {ok:true,tabId:12};
    }
  });
  assert.deepEqual(seen,[{key:tasks[0].key,reuseTabId:null},{key:tasks[2].key,reuseTabId:12}]);
  assert.equal(report.total,2);
  assert.equal(report.completed,2);
  assert.equal(report.imported,2);
  assert.deepEqual(report.failures,[]);
});

test('failed searches remain available for manual review; remaining legs continue in a new tab',async()=>{
  const seen=[];
  const report=await runFlightImportQueue(tasks,{
    isCached:()=>false,
    importTask:async(task,{reuseTabId})=>{
      seen.push(reuseTabId);
      if(task.key===tasks[1].key)throw Error('Google changed its result cards');
      return {ok:true,tabId:seen.length*10};
    }
  });
  assert.deepEqual(seen,[null,10,null]);
  assert.equal(report.imported,2);
  assert.equal(report.failures.length,1);
  assert.match(report.failures[0].error,/Google changed/);
  assert.equal(report.completed,3);
});

test('stop request finishes the current flight and does not start another',async()=>{
  let stop=false;
  const seen=[];
  const updates=[];
  const report=await runFlightImportQueue(tasks,{
    isCached:()=>false,
    shouldStop:()=>stop,
    onProgress:progress=>updates.push(progress),
    importTask:async task=>{seen.push(task.key);stop=true;return {ok:true,tabId:9};}
  });
  assert.deepEqual(seen,[tasks[0].key]);
  assert.equal(report.completed,1);
  assert.equal(report.stopped,true);
  assert.equal(updates.at(-1).stopped,true);
});

test('traveler UI offers one batch control, stop, and a per-search fallback',()=>{
  const html=readFileSync(new URL('../panel.html',import.meta.url),'utf8');
  const panel=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  for(const id of ['broadImportAll','broadBatchProgress','broadStopImport','broadOpenNext']){
    assert.match(html,new RegExp(`id="${id}"`));
  }
  assert.match(panel,/runFlightImportQueue\(broadTasks\(\)/);
  assert.match(panel,/captureFromOpenedOneWaySearch\(capture,task\)/);
  assert.match(panel,/broadBatchRunning/);
  assert.match(panel,/await autoCacheBroadCapture\(capture\)/);
  assert.doesNotMatch(panel.split("$('broadImportAll').addEventListener")[1]?.split("$('broadCaptureSave').addEventListener")[0]||'',/fetch\(/);
});

test('reopening the traveler panel restores the existing flight-search cache',()=>{
  const panel=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  const init=panel.slice(panel.indexOf('async function init()'));
  assert.match(init,/chrome\.storage\.local\.get\(\[[^\]]*'broadCache'/);
  assert.match(init,/broadCache = saved\.broadCache/);
});

test('route generation and interpretation do not replace the active batch research trip',()=>{
  const panel=readFileSync(new URL('../panel.mjs',import.meta.url),'utf8');
  assert.match(panel,/\$\('generate'\)\.addEventListener\('click', async \(\) => \{\s*if\(broadBatchRunning \|\| broadImportBusy\)/);
  assert.match(panel,/\$\('interpret'\)\.addEventListener\('click', async\(\)=>\{\s*if\(broadBatchRunning \|\| broadImportBusy\)/);
});

test('explicit empty exact search counts as unavailable and skips legs no longer needed',async()=>{
  const requested=[];
  let unavailable=false;
  const report=await runFlightImportQueue(tasks,{
    isCached:()=>false,
    shouldSkip:task=>unavailable && task.key===tasks[1].key,
    importTask:async task=>{
      requested.push(task.key);
      if(task.key===tasks[0].key){unavailable=true;return {ok:true,unavailable:true,tabId:42};}
      return {ok:true,tabId:42};
    }
  });
  assert.deepEqual(requested,[tasks[0].key,tasks[2].key]);
  assert.equal(report.unavailable,1);
  assert.equal(report.skipped,1);
  assert.equal(report.imported,1);
  assert.equal(report.completed,3);
  assert.deepEqual(report.failures,[]);
});
