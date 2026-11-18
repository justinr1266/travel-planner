import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../server.mjs';
import {createGroundTransitRequestHandler} from '../google-ground-handler.mjs';

const validId = process.env.ROUTEWISE_EXTENSION_ID || 'a'.repeat(32);
const validOrigin = `chrome-extension://${validId}`;
const invalidOrigin = 'https://example.com';
const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const time = `${date}T08:00:00.000Z`;

async function runServer(server, fn) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Google transit and Groq requests share RouteWise server; no trip prompt is required for transit', async () => {
  let googleCalls = 0;
  let tripCalls = 0;
  const google = createGroundTransitRequestHandler({
    apiKey: 'test-key',
    fetchImpl: async () => {
      googleCalls++;
      return {ok:true, json:async()=>({routes:[{duration:'1200s', legs:[]}]})};
    }
  });
  const server = createServer({
    handleGroundTransit:google,
    googleRoutesEnabled:true,
    parseTrip:async()=>{tripCalls++;return {source:'groq-stub'};}
  });
  await runServer(server, async base => {
    const payload = JSON.stringify({origin:'Barcelona Airport', destination:'Barcelona Sants', localDate:date, time, timeKind:'departure'});
    const transit = await fetch(`${base}/ground-transit`, {
      method:'POST', headers:{Origin:validOrigin, 'content-type':'application/json'}, body:payload
    });
    assert.equal(transit.status,200);
    assert.equal((await transit.json()).routes[0].durationMinutes,20);
    assert.equal(transit.headers.get('cache-control'),'no-store');
    assert.equal(googleCalls,1);
    assert.equal(tripCalls,0);

    const trip = await fetch(`${base}/parse-trip`, {
      method:'POST', headers:{Origin:validOrigin, 'content-type':'application/json'},
      body:JSON.stringify({request:'Barcelona to La Palma'})
    });
    assert.equal(trip.status,200);
    assert.deepEqual(await trip.json(),{source:'groq-stub'});
    assert.equal(tripCalls,1);
    assert.equal(googleCalls,1);
  });
});

test('Google transit endpoint still enforces the main server extension-origin restriction', async()=>{
  let handled=0;
  const server=createServer({handleGroundTransit:async()=>{handled++;return true;}});
  await runServer(server,async base=>{
    const denied=await fetch(`${base}/ground-transit`,{method:'POST',headers:{Origin:invalidOrigin}});
    assert.equal(denied.status,403);
    assert.equal(handled,0);
    const health=await fetch(`${base}/health`);
    assert.equal(health.status,200);
    assert.equal((await health.json()).ok,true);
  });
});

test('Google Routes is OFF by default; the server refuses requests without calling Google',async()=>{
  let calls=0;
  const server=createServer({googleRoutesEnabled:false,handleGroundTransit:async()=>{calls++;return true;}});
  await runServer(server,async base=>{
    const response=await fetch(`${base}/ground-transit`,{method:'POST',
      headers:{Origin:validOrigin,'content-type':'application/json'},
      body:JSON.stringify({origin:'Barcelona Airport',destination:'Barcelona Sants'})});
    assert.equal(response.status,503);
    assert.match((await response.json()).error,/disabled/);
    assert.equal(calls,0);
  });
});
