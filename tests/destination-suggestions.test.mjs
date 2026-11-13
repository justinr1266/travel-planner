import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestDestinationsWithGroq,createServer} from '../server.mjs';

const records=[['MIL','Milan','IT','Milan (all airports)','metro'],['ARN','Stockholm','SE','Stockholm Arlanda Airport','airport'],['GOT','Gothenburg','SE','Gothenburg Airport','airport']];
const request={region:'Sweden',origin:'MIL',destination:'MIL',startDate:'2027-01-21',endDate:'2027-01-24',request:'A Sweden weekend'};

test('Groq candidate suggestions use structured output and filter invalid/duplicate airport codes',async()=>{
  let call;
  const fetchImpl=async (url,options)=>{
    call={url,headers:options.headers,body:JSON.parse(options.body)};
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[
      {code:'ARN',city:'Stockholm',country:'Sweden'},
      {code:'GOT',city:'Gothenburg',country:'Sweden'},
      {code:'ARN',city:'Stockholm again',country:'Sweden'},
      {code:'AAAA',city:'Invalid',country:'Sweden'},
      {code:'MIL',city:'Not a candidate',country:'Italy'}
    ]})}}]})};
  };
  const result=await suggestDestinationsWithGroq(request,{apiKey:'testing-key',fetchImpl,records});
  assert.equal(call.url,'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.headers.Authorization,'Bearer testing-key');
  assert.equal(call.body.response_format.json_schema.strict,true);
  assert.deepEqual(result.candidates.map(x=>x.code),['ARN','GOT']);
  assert.equal(result.verified,false);
  assert.ok(!JSON.stringify(result).includes('testing-key'));
});

test('Groq stage B must not return made-up prices or accept absent region',async()=>{
  await assert.rejects(()=>suggestDestinationsWithGroq({...request,region:''},{apiKey:'test'}),/region/);
  await assert.rejects(()=>suggestDestinationsWithGroq(request,{apiKey:'',fetchImpl:async()=>({})}),/GROQ_API_KEY/);
  const fetchImpl=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[]})}}]})});
  await assert.rejects(()=>suggestDestinationsWithGroq(request,{apiKey:'testing-key',fetchImpl}),/airport directory/);
});


test('Chrome side panel can request region suggestions from the local server',async()=>{
  let received;
  const server=createServer({suggestDestinations:async(body)=>{
    received=body;
    return {region:body.region,candidates:[{code:'ARN',city:'Stockholm',country:'Sweden'}],verified:false};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/suggest-destinations`,{
      method:'POST',headers:{Origin:`chrome-extension://${'a'.repeat(32)}`,'Content-Type':'application/json'},
      body:JSON.stringify(request)
    });
    assert.equal(response.status,200);
    assert.equal(response.headers.get('access-control-allow-origin'),`chrome-extension://${'a'.repeat(32)}`);
    const data=await response.json();
    assert.equal(received.region,'Sweden');
    assert.equal(data.candidates[0].code,'ARN');
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
