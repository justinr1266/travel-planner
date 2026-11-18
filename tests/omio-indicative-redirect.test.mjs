import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {automaticTrainSearchEvidence,trainSearchUrl,parseTrainCapture} from '../train-research.mjs';
import {trainResultFingerprint,waitForStableTrainResults} from '../train-import-readiness.mjs';

const task={mode:'train',fromLabel:'Barcelona Sants',toLabel:'Madrid-Puerta de Atocha-Almudena Grandes',date:'2027-01-11'};
const openedUrl=trainSearchUrl(task);
const redirectedUrl='https://www.omio.com/app/search-frontend/results/train?locale=en';
const journey=(price,arrival='Madrid-Puerta de Atocha-Almudena Grandes')=>({
  provider:'Renfe',fromStation:'Barcelona Sants',toStation:arrival,
  departureText:'5:40 AM',arrivalText:'8:57 AM',durationText:'3h17m',
  changesText:'Direct',priceText:`€${price}`
});
const capture=(extras={})=>({sourceUrl:redirectedUrl,departureDateText:'Mon, Jan 11',
  cardSource:'omio_result_cards',journeys:[journey(26),journey(19)],...extras});

test('dated link + Omio visible day supports only an indicative, year-from-link cache',()=>{
  const result=automaticTrainSearchEvidence(capture(),task,{openedUrl});
  assert.equal(result?.source,'dated_link_and_visible_day');
  assert.equal(result?.requestedDate,'2027-01-11');
  assert.equal(result?.yearIndependentlyVerified,false);
  const parsed=parseTrainCapture(capture(),task);
  assert.equal(parsed.options[0].fareEur,19); // not first card; page sorted by departure time
  assert.equal(parsed.quoteStatus,'indicative');
});

test('the same redirected URL cannot be reused for an unlaunched search',()=>{
  assert.equal(automaticTrainSearchEvidence(capture(),task)?.source,undefined);
  assert.equal(automaticTrainSearchEvidence(capture(),task,{openedUrl:'https://www.omio.com/links/other'}),null);
});

test('month/day/weekday must all agree, including explicit year when visible',()=>{
  for(const text of ['Tue, Jan 11','Mon, Jan 12','Mon, Feb 11','Mon, Jan 11, 2028','', 'Sat, Jan 11']){
    assert.equal(automaticTrainSearchEvidence(capture({departureDateText:text}),task,{openedUrl}),null,text);
  }
  assert.equal(automaticTrainSearchEvidence(capture({departureDateText:'Mon, Jan 11, 2027'}),task,{openedUrl})?.yearIndependentlyVerified,true);
});

test('conflicting redirect query date, station, or mode blocks automation',()=>{
  for(const query of ['departureDate=2027-01-12','date=2027-01-12',
    'departurePosTerm=Valencia','arrivalPosTerm=Madrid+Chamartin','travelMode=BUS']){
    assert.equal(automaticTrainSearchEvidence(capture({sourceUrl:redirectedUrl+'&'+query}),task,{openedUrl}),null,query);
  }
});

test('untrusted provider and unstructured text never qualify',()=>{
  assert.equal(automaticTrainSearchEvidence(capture({sourceUrl:'https://evil.example/app/search'}),task,{openedUrl}),null);
  assert.equal(automaticTrainSearchEvidence(capture({cardSource:'text_fallback',journeys:[]}),task,{openedUrl}),null);
  assert.equal(automaticTrainSearchEvidence(capture({journeys:[journey(12,'Madrid Chamartin')]}),task,{openedUrl}),null);
  assert.equal(automaticTrainSearchEvidence(capture({journeys:[journey(12,'Madrid Chamartin'),journey(19)]}),task,{openedUrl})?.source,'dated_link_and_visible_day');
});

test('fully dated URL continues to work without visible date, but not if visible date contradicts it',()=>{
  const url=openedUrl;
  assert.equal(automaticTrainSearchEvidence(capture({sourceUrl:url,departureDateText:''}),task)?.source,'dated_url');
  assert.equal(automaticTrainSearchEvidence(capture({sourceUrl:url,departureDateText:'Tue, Jan 12'}),task,{openedUrl}),null);
});

test('Omio content script captures the selected departure field without opening the calendar',()=>{
  const src=readFileSync(new URL('../train-results.js',import.meta.url),'utf8');
  let callback;
  const node=value=>({innerText:value,textContent:value,getClientRects:()=>[{}]});
  const fields={price:'€19',departurePosition:'Barcelona Sants',arrivalPosition:'Madrid-Puerta de Atocha-Almudena Grandes',
    departureTime:'5:40 AM',arrivalTime:'8:57 AM',duration:'3h17m',numberOfChanges:'Direct'};
  const card={getClientRects:()=>[{}],querySelector(selector){
    if(selector==='img[data-e2e="provider"]')return {getAttribute:()=> 'Renfe'};
    return node(fields[selector.match(/\[data-e2e="([^"]+)"\]/)?.[1]]||'');
  }};
  const document={readyState:'complete',title:'Omio',body:node(''),
    querySelector(selector){return selector==='[data-e2e="buttonDepartureDateText"]'?node('Mon, Jan 11'):null;},
    querySelectorAll(selector){return selector==='[data-e2e="resultCellWrapper"]'?[card]:[];}};
  runInNewContext(src,{location:{hostname:'www.omio.com',href:redirectedUrl},document,
    chrome:{runtime:{onMessage:{addListener:fn=>callback=fn}}}});
  let result;
  callback({type:'routewise:capture-train-results'},null,value=>{result=value;});
  assert.equal(result.departureDateText,'Mon, Jan 11');
  assert.equal(result.journeys[0].priceText,'€19');
  assert.equal(automaticTrainSearchEvidence(result,task,{openedUrl})?.source,'dated_link_and_visible_day');
});

test('visible date is part of the stability fingerprint and triggers a settle retry',async()=>{
  const base={...capture(),ok:true,readyState:'complete',tabComplete:true};
  const fingerprint=trainResultFingerprint(base,task);
  assert.notEqual(fingerprint,trainResultFingerprint({...base,departureDateText:'Tue, Jan 12'},task));
  let ms=0,reads=0;
  const result=await waitForStableTrainResults({task,
    read:async()=>++reads<4?{...base,departureDateText:'Tue, Jan 12'}:base,
    now:()=>ms,sleep:async delta=>{ms+=delta;},timeoutMs:25000,pollMs:1000,settleMs:4000,stableReads:3});
  assert.equal(result.status,'ready');
  assert.equal(result.capture.departureDateText,'Mon, Jan 11');
  assert.ok(ms>=7000);
});
