import test from 'node:test';
import assert from 'node:assert/strict';
import {assessItinerary, rankItineraryComparisons, rankingExplanation} from '../itinerary-recommendations.mjs';

const route = (name, attrs={})=>({route:{name},complete:true,total:220,known:220,missing:0,conflicts:0,
  uncheckedConnections:0,destinationHours:145,observedDurationMinutes:900,unknownDurations:0,trainCount:0,selected:[],...attrs});

test('complete estimates outrank cheaper-looking partial totals',()=>{
  const ranked=rankItineraryComparisons([
    route('train lower bound',{total:null,known:170,complete:false,missing:2,trainCount:1}),
    route('complete',{total:211,known:211})
  ],'lowest_cost');
  assert.deepEqual(ranked.map(r=>r.route.name),['complete','train lower bound']);
  assert.equal(ranked[1].assessment.label,'Incomplete estimate');
});

test('known connection conflict never wins over a viable estimate',()=>{
  const ranked=rankItineraryComparisons([
    route('conflicted',{total:100,conflicts:1}),
    route('viable',{total:300})
  ],'lowest_cost');
  assert.deepEqual(ranked.map(r=>r.route.name),['viable','conflicted']);
});

test('timing-check required ranks below other complete estimates',()=>{
  const ranked=rankItineraryComparisons([
    route('timing unknown',{total:90,uncheckedConnections:2}),
    route('timed',{total:220})
  ],'lowest_cost');
  assert.deepEqual(ranked.map(r=>r.route.name),['timed','timing unknown']);
});

test('destination-time priority beats cost among equally complete itineraries',()=>{
  const ranked=rankItineraryComparisons([
    route('cheap',{total:150,destinationHours:130}),
    route('more holiday',{total:230,destinationHours:160})
  ],'more_time_at_preferred');
  assert.equal(ranked[0].route.name,'more holiday');
});

test('lowest-cost priority orders by complete total',()=>{
  const ranked=rankItineraryComparisons([route('expensive',{total:230}),route('cheap',{total:210})],'lowest_cost');
  assert.equal(ranked[0].route.name,'cheap');
});

test('fastest mode does not compare unpriced train time against flights only',()=>{
  const ranked=rankItineraryComparisons([
    route('train',{total:150,observedDurationMinutes:450,trainCount:1}),
    route('all-flight',{total:210,observedDurationMinutes:600})
  ],'fastest');
  assert.match(rankingExplanation('fastest',ranked[0].assessment),/partial measure/);
});

test('stale quotes, unpriced train leg and unknown durations are visible caveats',()=>{
  const flags=assessItinerary(route('mixed',{trainCount:1,unknownDurations:1,selected:[{cacheAge:'stale'}]})).flags.join(' ');
  assert.match(flags,/no universal fare assumed/);
  assert.match(flags,/over 24 hours/);
  assert.match(flags,/duration/);
  assert.match(flags,/not verified/);
});

test('unknown totals and unknown destination time are never converted into zero',()=>{
  const empty=assessItinerary({route:{name:'unknown'},complete:true,total:null,known:0,missing:0});
  assert.equal(empty.total,null);
  assert.equal(empty.destinationHours,null);
  assert.equal(empty.complete,false);
});

test('stable comparison leaves original rows and fare records unchanged',()=>{
  const a=route('a',{selected:[{costEur:211}]});
  const b=route('b',{selected:[{costEur:220}]});
  rankItineraryComparisons([a,b],'balance');
  assert.equal(a.assessment,undefined);
  assert.equal(a.selected[0].costEur,211);
});


test('the actual five-option example puts two complete flight itineraries ahead of three incomplete prices',()=>{
  const choices=[
    route('Madrid flights',{total:211,known:211,destinationHours:158.8,observedDurationMinutes:1005}),
    route('direct flights',{total:251,known:251,destinationHours:142.7,observedDurationMinutes:2175}),
    route('Madrid train',{total:null,known:170,complete:false,missing:2,trainCount:1,destinationHours:165.8}),
    route('Valencia train',{total:null,known:189,complete:false,missing:2,trainCount:1,destinationHours:156.5}),
    route('Mallorca return',{total:null,known:346,complete:false,missing:1,destinationHours:145.6})
  ];
  const shown=rankItineraryComparisons(choices,'more_time_at_preferred');
  assert.deepEqual(shown.slice(0,2).map(x=>x.route.name),['Madrid flights','direct flights']);
  assert.ok(shown.slice(2).every(x=>x.assessment.label==='Incomplete estimate'));
});
