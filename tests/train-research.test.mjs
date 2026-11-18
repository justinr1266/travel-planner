import test from 'node:test';
import assert from 'node:assert/strict';
import {trainResearchKey,trainResearchTasks,trainSearchUrl,parseEuroAmount,parseTrainCapture,
  checkedTrainQuote,indicativeTrainQuote,captureMatchesTrainSearch} from '../train-research.mjs';

const a={mode:'train',from:'station:gtfs:renfe:barcelona',to:'station:gtfs:renfe:madrid',
  fromLabel:'Barcelona Sants',toLabel:'Madrid Atocha',date:'2027-01-11',key:'different-feed-key-1'};
const b={...a,from:'station:gtfs:other:barcelona',to:'station:gtfs:other:madrid',key:'different-feed-key-2'};
const task={key:trainResearchKey(a),leg:a};
const validUrl=trainSearchUrl(task);
function capture({cards=['08:20 Barcelona Sants → Madrid Atocha 11:10 · From €45,90'],sourceUrl=validUrl}={}) {
  return {cards,sourceUrl};
}

test('dated station-to-station searches deduplicate GTFS feed IDs and repeat legs',()=>{
  assert.equal(trainResearchKey(a),trainResearchKey(b));
  assert.equal(trainResearchKey({...a,date:'2027-01-12'})===trainResearchKey(a),false);
  assert.equal(trainResearchKey({...a,mode:'transfer'}),null);
  assert.equal(trainResearchTasks([{legs:[a,a]},{legs:[b]}]).length,1);
  assert.equal(trainResearchTasks([{legs:[a,a]},{legs:[b]}])[0].routeCount,2);
});
test('search uses exact station names, date, train mode and EUR',()=>{
  const url=new URL(validUrl);
  assert.equal(url.hostname,'www.omio.com');
  assert.equal(url.searchParams.get('departurePosTerm'),'Barcelona Sants');
  assert.equal(url.searchParams.get('arrivalPosTerm'),'Madrid Atocha');
  assert.equal(url.searchParams.get('departureDate'),'2027-01-11');
  assert.equal(url.searchParams.get('travelMode'),'TRAIN');
  assert.equal(url.searchParams.get('currency'),'EUR');
});
test('European and international EUR amounts use correct decimal separators',()=>{
  assert.equal(parseEuroAmount('45,90'),45.9);
  assert.equal(parseEuroAmount('1.234,56'),1234.56);
  assert.equal(parseEuroAmount('1,234.56'),1234.56);
  assert.equal(parseEuroAmount('12.50'),12.5);
  assert.equal(parseEuroAmount('0'),null);
  assert.equal(parseEuroAmount('9999'),null);
});
test('captures only EUR-marked train journey snippets, never whole-page text',()=>{
  const record=parseTrainCapture(capture({cards:['Barcelona Sants Madrid Atocha 08:20 11:10 €45,90',
    'Madrid to Barcelona $23', 'EUR 69.00 14:00 17:30']}),task);
  assert.equal(record.options.length,2);
  assert.deepEqual(record.options.map(o=>o.fareEur),[45.9,69]);
  assert.equal(record.options[0].departureClock,'08:20');
  assert.equal(record.quoteStatus,'indicative');
  assert.ok(!record.options[0].checkedAt);
});
test('unknown or untrusted train source URLs fail closed',()=>{
  assert.throws(()=>parseTrainCapture(capture({sourceUrl:'https://evil.example/quotes'}),task),/Omio or Trainline/);
  assert.deepEqual(parseTrainCapture(capture({cards:['No trains available today']}),task).options,[]);
});
test('no silent verified fare: user confirmation is required to accept a captured quote',()=>{
  assert.throws(()=>checkedTrainQuote(capture(),task),/Confirm/);
  const checked=checkedTrainQuote(capture(),task,{confirmation:true});
  assert.equal(checked.selected.fareEur,45.9);
});
test('auto-cache requires unmodified route/date in URL, not merely a matching tab',()=>{
  assert.equal(captureMatchesTrainSearch(capture(),task),true);
  const wrongDate=validUrl.replace('2027-01-11','2027-01-12');
  assert.equal(captureMatchesTrainSearch(capture({sourceUrl:wrongDate}),task),false);
  assert.equal(captureMatchesTrainSearch(capture({sourceUrl:'https://www.omio.com/app/search?route=Barcelona-Madrid'}),task),false);
});
test('indicative rail estimates remain distinct from recorded offers',()=>{
  const record=checkedTrainQuote(capture(),task,{confirmation:true});
  const hint=indicativeTrainQuote({[task.key]:record},b);
  assert.equal(hint.fareEur,45.9);
  assert.equal(indicativeTrainQuote({},b),null);
  assert.equal(indicativeTrainQuote({[task.key]:{...record,quoteStatus:'booked'}},b),null);
});

test('structured Omio cards preserve AM/PM and ignore different arrival stations',()=>{
  const valencia={mode:'train',fromLabel:'Barcelona Sants',toLabel:'Valencia-Estació del Nord',
    from:'gtfs:BCN',to:'gtfs:VLC',date:'2027-01-11'};
  const make=(toStation,departureText,arrivalText,priceText,changesText='Direct')=>({
    provider:'Renfe',fromStation:'Barcelona Sants',toStation,departureText,
    arrivalText,priceText,changesText,durationText:'2 h 55 m'
  });
  const record=parseTrainCapture({sourceUrl:trainSearchUrl(valencia),cardSource:'omio_result_cards',
    journeys:[
      make('Valencia-Joaquín Sorolla','5:45 AM','5:09 PM','€46','1 transfer'),
      make('Valencia-Estacio Del Nord','7:15 AM','10:10 AM','€19'),
      make('Valencia-Estacio Del Nord','6:15 PM','9:09 PM','€19'),
      make('Valencia-Estacio Del Nord','9:00 AM','11:55 AM','USD 10'),
      {...make('Valencia-Estacio Del Nord','8:15 AM','11:20 AM','€19'),fromStation:'Barcelona França'}
    ]},valencia);
  assert.equal(record.journeyCardsSeen,5);
  assert.equal(record.excludedStationMismatch,2);
  assert.equal(record.options.length,2);
  assert.deepEqual(record.options.map(o=>o.fareEur),[19,19]);
  assert.deepEqual(record.options.map(o=>o.departureClock),['07:15','18:15']);
  assert.deepEqual(record.options.map(o=>o.arrivalClock),['10:10','21:09']);
  assert.ok(record.options.every(o=>o.stationMatch&&o.toStation==='Valencia-Estacio Del Nord'));
  assert.equal(record.options[0].changes,'Direct');
});

test('structured Omio results with no exact station match remain unpriced',()=>{
  const valencia={mode:'train',fromLabel:'Barcelona Sants',toLabel:'Valencia-Estació del Nord',
    date:'2027-01-11'};
  const record=parseTrainCapture({sourceUrl:trainSearchUrl(valencia),cardSource:'omio_result_cards',
    journeys:[{fromStation:'Barcelona Sants',toStation:'Valencia-Joaquín Sorolla',
      departureText:'7:05 AM',arrivalText:'5:09 PM',priceText:'€46',provider:'iryo'}],
    cards:['Barcelona Sants Valencia-Estació del Nord €9']},valencia);
  assert.equal(record.options.length,0);
  assert.equal(record.excludedStationMismatch,1);
});

test('structured card price is not inferred from unrelated text',()=>{
  const record=parseTrainCapture({sourceUrl:validUrl,journeys:[{fromStation:'Barcelona Sants',
    toStation:'Madrid Atocha',departureText:'8:15 AM',arrivalText:'11:15 AM',
    priceText:'Price unavailable',snippet:'Sale banner €1; journey €69'}]},task);
  assert.equal(record.options.length,0);
});
