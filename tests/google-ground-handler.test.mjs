import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createGroundTransitRequestHandler} from '../google-ground-handler.mjs';

const VALID_ORIGIN='chrome-extension://'+'a'.repeat(32);
const DATE='2027-01-11';
const TIME='2027-01-11T08:00:00.000Z';

async function withMountedServer(handler, callback) {
  const server=http.createServer(async(req,res)=>{
    if(await handler(req,res))return;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({legacy:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{return await callback(`http://127.0.0.1:${server.address().port}`);}
  finally{await new Promise(resolve=>server.close(resolve));}
}

test('mounted ground endpoint shares the existing HTTP listener with Groq routes',async()=>{
  let calls=0;
  const ground=createGroundTransitRequestHandler({apiKey:'demo',fetchImpl:async()=>{
    calls++;return {ok:true,json:async()=>({routes:[{duration:'1200s',legs:[]} ]})};
  }});
  await withMountedServer(ground,async base=>{
    const other=await fetch(`${base}/parse-trip`);
    assert.equal(other.status,200);
    assert.equal((await other.json()).legacy,true);
    const body=JSON.stringify({origin:'Barcelona Airport',destination:'Barcelona Sants',localDate:DATE,time:TIME,timeKind:'departure'});
    const transit=await fetch(`${base}/ground-transit`,{method:'POST',headers:{origin:VALID_ORIGIN,'content-type':'application/json'},body});
    assert.equal(transit.status,200);
    assert.equal((await transit.json()).routes[0].durationMinutes,20);
    assert.equal(transit.headers.get('cache-control'),'no-store');
    assert.equal(calls,1);
    const reject=await fetch(`${base}/ground-transit`,{method:'POST',headers:{'content-type':'application/json'},body});
    assert.equal(reject.status,403);
    assert.equal(calls,1);
  });
});

test('unrelated requests are not intercepted',async()=>{
  const ground=createGroundTransitRequestHandler({apiKey:'demo'});
  const accepted=await ground({url:'/parse-trip'},{});
  assert.equal(accepted,false);
  const unrelated=await ground({url:'/ground-transit?x=1'},{});
  assert.equal(unrelated,false);
});
