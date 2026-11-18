import http from 'node:http';
import {handleGroundTransitRequest} from './google-ground-handler.mjs';
import { TRIP_SCHEMA, validateTripPlan, normalizeTripWithDiagnostics } from './trip-parser.mjs';
import { resolveSuggestedDestination, resolveLocation, catalogMetadata, LOCATION_RECORDS } from './location-resolver.mjs';
import {loadTransitNetwork,discoverGroundEdges} from './gtfs-network.mjs';

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const API_KEY = process.env.GROQ_API_KEY || '';
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
const ALLOWED_EXTENSION_ID = process.env.ROUTEWISE_EXTENSION_ID || '';
const GOOGLE_ROUTES_ENABLED = process.env.ROUTEWISE_GOOGLE_ROUTES_ENABLED === 'true'; // default OFF

const INSTRUCTIONS = `You are RouteWise Stage A: a travel-constraint extractor, NOT a trip planner.
Return only strict JSON matching the schema. Do not search for flights, recommend cities, invent fares, or claim routes operate.
Extract endpoints, desired vacation location or region, departure/return dates, fixed vs flexible constraints, bags, and preferences.

Location rule: Understand arbitrary cities and regions worldwide. For origin, preferred and destination return a genuine three-letter IATA code when confident, otherwise return the city name, never invent a code. Do not limit choices to a small airport list. The local airport directory will resolve names and verify candidate codes.
When the origin and end are the same, preserve both.
A country or region WITHOUT a city (for example Sweden or Portugal) belongs in requested_regions. Use destination_search='region' and preferred=null. Do not invent Stockholm or Lisbon.
'Any cool places' or 'anywhere' without a geographic restriction => destination_search='open', preferred=null.
A named vacation destination => preferred=<code>, destination_search='specified'. A connection point is not necessarily a vacation destination.
Copy the traveler's explicitly named vacation destination faithfully; never substitute a nearby island, similarly named city, or plausible connection airport. If uncertain about its IATA code, output the full place name and let local location resolution verify it.

Date rules:
- 'from January 21 to January 24' for a trip means a fixed Jan 21 departure and Jan 24 return.
- 'leave between February 2 and 4' means a FLEXIBLE departure window, not a return date.
- 'on January 24' for an arrival/return is FIXED; 'by January 24' is an arrival deadline.
- If the year is omitted, choose the next occurrence of the starting date on or after the provided local reference date; keep the trip chronological across New Year. Do not ask the user to confirm the inferred year. An explicitly stated year always wins.
- Date fields use YYYY-MM-DD. Null only if genuinely unknown; do not discard dates explicitly present in the text.
- Fixed dates use earliest=latest and fixed=true. A deadline uses arrive_latest and fixed_arrival=false.

Never invent baggage dimensions, schedules, prices, minimum nights, flight availability, or unmentioned priorities. 'Spend as much time as possible' at a named vacation spot means priority=more_time_at_preferred. Preserve required vs optional choices in hard_constraints and soft_preferences. Output the schema fields exactly.`;

export async function parseWithGroq(request, {apiKey=API_KEY,model=MODEL,fetchImpl=fetch,referenceDate=new Date().toISOString().slice(0,10)}={}) {
  if (!apiKey) throw new Error('Local server has no GROQ_API_KEY. Add your key to .env and restart the server.');
  if (typeof request !== 'string' || !request.trim() || request.length > 4000) throw new Error('Trip description must be 1 to 4,000 characters.');
  // Groq's Chat Completions endpoint supports strict JSON Schema for GPT-OSS models.
  // The key never leaves this local server; the Chrome extension sends only the trip text.
  const startedAt=performance.now();
  const response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model,
      messages:[{role:'system',content:`${INSTRUCTIONS}\nReference date (UTC): ${referenceDate}`},{role:'user',content:request}],
      response_format:{
        type:'json_schema',
        json_schema:{name:'routewise_trip',strict:true,schema:TRIP_SCHEMA}
      },
      reasoning_effort:'low',
      max_completion_tokens:2500
    })
  });
  const apiResponseAt=performance.now();
  if (!response.ok) {
    // Avoid forwarding upstream content, which may contain details we should not expose.
    if (response.status === 401 || response.status === 403) throw new Error('Groq authentication failed. Check GROQ_API_KEY in .env.');
    if (response.status === 429) throw new Error('Groq free-tier rate limit reached. Check your limits and retry later.');
    throw new Error(`Groq returned status ${response.status}. Check the model and API settings.`);
  }
  const data = await response.json();
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason !== 'stop' || typeof content !== 'string' || !content.trim()) {
    throw new Error('Groq returned an incomplete or empty trip result. Please retry.');
  }
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('Groq returned invalid JSON.'); }
  // Preserve the raw model output for local debugging, separately from the final
  // validated plan. The API key and HTTP headers are never included.
  const normalizeStartedAt=performance.now();
  const normalized=normalizeTripWithDiagnostics(request,parsed,{referenceDate});
  const validated=validateTripPlan(normalized.plan);
  const finishedAt=performance.now();
  return {
    ...validated,
    debug:{ model,referenceDate,rawModel:parsed,corrections:normalized.corrections,
      dateEvidence:normalized.dateEvidence,yearInferred:normalized.yearInferred,
      timingMs:{groqRequest:Math.round(apiResponseAt-startedAt),
        normalization:Math.round(finishedAt-normalizeStartedAt),
        totalServer:Math.round(finishedAt-startedAt)} }
  };
}

// Stage B: propose cities within a requested region. These are ideas, NOT live
// timetable/airport data. The separate schema stops price claims leaking into routes.
export const SUGGEST_SCHEMA = {
  type:'object', additionalProperties:false,
  properties:{candidates:{type:'array',items:{type:'object',additionalProperties:false,
    properties:{code:{type:'string'},city:{type:'string'},country:{type:'string'}},
    required:['code','city','country']}}},
  required:['candidates']
};

export async function suggestDestinationsWithGroq(body,{apiKey=API_KEY,model=MODEL,fetchImpl=fetch,records=LOCATION_RECORDS}={}) {
  if (!apiKey) throw new Error('Local server has no GROQ_API_KEY. Add it to .env and restart the server.');
  const region=String(body?.region||'').trim();
  const discovery=body?.destinationSearch==='open' ? 'open' : 'region';
  if (region.length>100 || (discovery==='region' && !region)) throw new Error('Specify a requested region or choose open discovery.');
  const origin=String(body.origin||'').trim().toUpperCase();
  const destination=String(body.destination||'').trim().toUpperCase();
  if (!resolveLocation(origin,{records}) || !resolveLocation(destination,{records})) throw new Error('Origin and final destination must resolve to known airport/location codes. Try updating the airport directory.');
  const instructions=`Suggest up to ten distinct vacation cities suitable for the user's date window and interests.
If a country or region is specified, ONLY suggest places within it. Otherwise suggest plausible diverse destinations for an open-ended trip.
Return the city and country as spelled in common English, and a possible 3-letter airport code when confident; never invent airport codes. The server independently validates names and codes against a public airport directory.
Do not claim live service, fare, availability, or baggage price. This is ONLY destination brainstorming; flight routes and schedules are not yet checked.
Exclude the origin and final destinations. If uncertain, return fewer.`;
  const response=await fetchImpl('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
    signal:AbortSignal.timeout(30000),
    body:JSON.stringify({model,messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify({region,origin,destination,start:body.startDate,end:body.endDate,preferences:String(body.request||'').slice(0,1200)})}],
      response_format:{type:'json_schema',json_schema:{name:'routewise_region_candidates',strict:true,schema:SUGGEST_SCHEMA}},
      reasoning_effort:'low',max_completion_tokens:1400})
  });
  if (!response.ok) {
    if ([401,403].includes(response.status)) throw new Error('Groq authentication failed. Check GROQ_API_KEY.');
    if (response.status===429) throw new Error('Groq rate limit reached. Retry later.');
    throw new Error(`Groq returned status ${response.status} for destination suggestions.`);
  }
  const result=await response.json();
  const choice=result?.choices?.[0];
  if (choice?.finish_reason!=='stop' || !choice?.message?.content) throw new Error('Groq destination suggestions were incomplete.');
  let decoded;
  try{decoded=JSON.parse(choice.message.content);}catch{throw new Error('Groq returned malformed destination suggestions.');}
  if (!Array.isArray(decoded?.candidates)) throw new Error('Groq returned no destination list.');
  const seen=new Set();
  const candidates=[];
  for(const item of decoded.candidates) {
    const resolved=resolveSuggestedDestination(item,{region,records});
    if(!resolved || [origin,destination].includes(resolved.code) || seen.has(resolved.code)) continue;
    seen.add(resolved.code);
    candidates.push(resolved);
    if(candidates.length===5) break;
  }
  if(!candidates.length) throw new Error('No suggested locations matched the airport directory. Run npm run sync:airports and retry.');
  return {region,candidates,verified:false,airportCodesChecked:true,airportCatalog:catalogMetadata.source};
}

// Stage C: suggest candidate CONNECTING airports for a named primary destination.
// These are routing IDEAS, never assertions of direct service or bookability.
const CONNECTION_POINT_SCHEMA={type:'object',additionalProperties:false,
  properties:{code:{type:'string'},city:{type:'string'},country:{type:'string'}},
  required:['code','city','country']};
export const CONNECTION_SCHEMA={type:'object',additionalProperties:false,
  properties:{outbound:{type:'array',items:CONNECTION_POINT_SCHEMA},
    inbound:{type:'array',items:CONNECTION_POINT_SCHEMA}},
  required:['outbound','inbound']};

export async function suggestConnectionsWithGroq(body,{apiKey=API_KEY,model=MODEL,fetchImpl=fetch,records=LOCATION_RECORDS}={}) {
  if(!apiKey) throw new Error('Local server has no GROQ_API_KEY. Restart with a valid key.');
  const origin=resolveLocation(body?.origin,{records});
  const primary=resolveLocation(body?.preferred,{records});
  const final=resolveLocation(body?.destination,{records});
  if(!origin||!primary||!final || primary.code===origin.code || primary.code===final.code)
    throw new Error('Select valid, distinct trip endpoints and primary destination before suggesting connections.');
  if(body.maxConnections===0) return {outbound:[],inbound:[],verified:false,airportCodesChecked:true};
  const instructions=`You brainstorm connecting AIRPORTS for a travel planner; you do not know live schedules.
The vacation destination is fixed: do not propose new destinations. Return up to 4 plausible airport hubs for each journey:
- outbound: airports between START and PRIMARY DESTINATION.
- inbound: airports between PRIMARY DESTINATION and FINAL ENDPOINT.
The final endpoint is allowed as an outbound connection (e.g. Barcelona > Madrid > La Palma > Madrid).
The initial origin is allowed as an inbound connection when meaningful.
Prioritize plausible major transfer hubs and geographic efficiency over obscure airports; do not invent service, dates, fares, transfers, or booking options.
Exclude each journey's own start and endpoint from that journey's hubs. Provide code, actual airport city, country; use genuine IATA codes only when confident. Return fewer if uncertain.
Return ONLY JSON matching the schema. Proposed airport codes will be independently checked against a directory. Do not treat the directory as proof of flight availability.`;
  const payload={origin,primary,final,departure:body.startDate,arrival:body.endDate,
    userPreferences:String(body.request||'').slice(0,1200),maxConnectionsPerJourney:1};
  const response=await fetchImpl('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
    signal:AbortSignal.timeout(30000),
    body:JSON.stringify({model,messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify(payload)}],
      response_format:{type:'json_schema',json_schema:{name:'routewise_connection_hubs',strict:true,schema:CONNECTION_SCHEMA}},
      reasoning_effort:'low',max_completion_tokens:1500})
  });
  if(!response.ok){
    if([401,403].includes(response.status)) throw new Error('Groq authentication failed. Check GROQ_API_KEY.');
    if(response.status===429) throw new Error('Groq rate limit reached. Retry later.');
    throw new Error(`Groq returned status ${response.status} for connection suggestions.`);
  }
  const result=await response.json();
  const choice=result?.choices?.[0];
  if(choice?.finish_reason!=='stop' || !choice?.message?.content) throw new Error('Groq connection suggestions were incomplete.');
  let decoded;
  try {decoded=JSON.parse(choice.message.content);}catch{throw new Error('Groq returned malformed connection suggestions.');}
  if(!Array.isArray(decoded?.outbound) || !Array.isArray(decoded?.inbound))
    throw new Error('Groq connection suggestions did not contain both directions.');
  function checked(items,excluded){
    const verified=[],seen=new Set();
    for(const item of items){
      const found=resolveSuggestedDestination(item,{records});
      if(!found || resolveLocation(found.code,{records})?.kind==='metro' || excluded.includes(found.code) || seen.has(found.code))continue;
      verified.push(found);seen.add(found.code);
      if(verified.length===4)break;
    }
    return verified;
  }
  return {
    outbound:checked(decoded.outbound,[origin.code,primary.code]),
    inbound:checked(decoded.inbound,[primary.code,final.code]),
    verified:false,airportCodesChecked:true,airportCatalog:catalogMetadata.source
  };
}

// No invented services: only route patterns extracted from an imported GTFS ZIP.
export async function discoverGroundNetwork(body,{records=LOCATION_RECORDS,loadNetwork=loadTransitNetwork}={}) {
  const snapshot=await loadNetwork();
  const codes=[body.origin,body.preferred,body.destination].filter(Boolean);
  for(const code of codes) if(!resolveLocation(code,{records})) throw new Error('An airport endpoint was not found in the directory.');
  const flightLegs=Array.isArray(body.flightLegs)?body.flightLegs.slice(0,40)
    .filter(l=>typeof l.from==='string'&&typeof l.to==='string'&&
      resolveLocation(l.from,{records})&&resolveLocation(l.to,{records})):[];
  const alternatives=discoverGroundEdges(snapshot,{origin:body.origin,preferred:body.preferred,
    final:body.destination,flightLegs,records,max:80,date:body.departureDate||null});
  return {alternatives,
    feeds:(snapshot.feeds||[]).map(({id,source,sourceUrl,attribution,validFrom,validTo})=>
      ({id,source,sourceUrl,attribution,validFrom,validTo})),
    evidence:'gtfs_trip_pattern',dateVerified:alternatives.some(a=>a.dateVerified),
    hasNetwork:Boolean(snapshot.edges?.length)};
}

function allowedOrigin(origin) {
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
  return !ALLOWED_EXTENSION_ID || origin === `chrome-extension://${ALLOWED_EXTENSION_ID}`;
}

export function createServer({parseTrip=parseWithGroq,suggestDestinations=suggestDestinationsWithGroq,suggestConnections=suggestConnectionsWithGroq,discoverGround=discoverGroundNetwork,handleGroundTransit=handleGroundTransitRequest,googleRoutesEnabled=GOOGLE_ROUTES_ENABLED}={}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const permitted = allowedOrigin(origin);
    // Transit requests share this listener, but must pass the same extension
    // origin/ID restrictions as the existing RouteWise endpoints. The Google
    // handler owns its CORS, validation, quota, and no-store response.
    if (req.url === '/ground-transit' && permitted) {
      if (!googleRoutesEnabled) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary','Origin');
        res.setHeader('Content-Type','application/json; charset=utf-8');
        res.writeHead(503);
        res.end(JSON.stringify({error:'Google Routes API is temporarily disabled. Use train search links.'}));
        return;
      }
      if (await handleGroundTransit(req, res)) return;
    }
    if (permitted) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type');
    }
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200); res.end(JSON.stringify({ok:true, model:MODEL,configured:Boolean(API_KEY)})); return;
    }
    if (!permitted) {res.writeHead(403);res.end(JSON.stringify({error:'Request must come from a permitted Chrome extension.'}));return;}
    if (!['/parse-trip','/suggest-destinations','/suggest-connections','/discover-ground'].includes(req.url)) {res.writeHead(404);res.end(JSON.stringify({error:'Not found.'}));return;}
    if (req.method === 'OPTIONS') {res.writeHead(204);res.end();return;}
    if (req.method !== 'POST') {res.writeHead(405);res.end(JSON.stringify({error:'POST required.'}));return;}
    if (!String(req.headers['content-type']||'').startsWith('application/json')) {res.writeHead(415);res.end(JSON.stringify({error:'JSON required.'}));return;}
    try {
      let raw='';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8000) {res.writeHead(413);res.end(JSON.stringify({error:'Request too large.'}));return;}
      }
      let body;
      try {body=JSON.parse(raw);} catch {res.writeHead(400);res.end(JSON.stringify({error:'Invalid JSON.'}));return;}
      if (typeof body.request !== 'string' || !body.request.trim() || body.request.length>4000) {
        res.writeHead(400);res.end(JSON.stringify({error:'Trip description must be 1 to 4,000 characters.'}));return;
      }
      let result;
      if(req.url === '/discover-ground') {
        result=await discoverGround(body);
      } else if(req.url === '/suggest-destinations') {
        result=await suggestDestinations(body);
      } else if (req.url === '/suggest-connections') {
        result=await suggestConnections(body);
      } else {
        const referenceDate = typeof body.referenceDate==='string' && /^\d{4}-\d{2}-\d{2}$/.test(body.referenceDate)
          ? body.referenceDate : new Date().toISOString().slice(0,10);
        result=await parseTrip(body.request,{referenceDate});
      }
      res.writeHead(200);res.end(JSON.stringify(result));
    } catch(error) {
      const safe = error instanceof Error ? error.message : 'Could not parse request.';
      res.writeHead(502);res.end(JSON.stringify({error: safe.slice(0,250)}));
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createServer().listen(PORT,'127.0.0.1',()=>{
    console.log(`RouteWise local parser running at http://127.0.0.1:${PORT}`);
    console.log(`Model: ${MODEL}; API configured: ${API_KEY ? 'yes':'NO'}`);
    if (!ALLOWED_EXTENSION_ID) console.log('Tip: Set ROUTEWISE_EXTENSION_ID in .env to allow only your extension.');
  });
}
