import http from 'node:http';
import { TRIP_SCHEMA, validateTripPlan } from './trip-parser.mjs';

const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const API_KEY = process.env.GROQ_API_KEY || '';
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
const ALLOWED_EXTENSION_ID = process.env.ROUTEWISE_EXTENSION_ID || '';

const INSTRUCTIONS = `You are a conservative trip requirements extraction engine for RouteWise.
Read the user's travel description and output only what they explicitly say or clearly imply.
Return airport codes from the available codes ONLY: BCN=Barcelona, MAD=Madrid, SPC=La Palma, TFN=Tenerife North, TFS=Tenerife South, LPA=Gran Canaria, LIS=Lisbon, OPO=Porto, FAO=Faro.
Treat "La Palma" as SPC, not Palma de Mallorca. If they mention Tenerife without specifying an airport, include TFN in alternate_stops only if plausible; do not assert flight availability.
Return null for unknown locations, exact dates, dimensions, hours and minimum nights. NEVER invent dates or prices.
For explicitly fixed departure date, depart_earliest=depart_latest=date and fixed_departure=true.
For departure flexibility, set earliest/latest to stated window (if exact calendar dates known), fixed_departure=false.
For an arrival deadline ("by February 10"), arrive_latest=date, arrive_earliest=null, fixed_arrival=false.
For an exact arrival date, set both arrival fields to the date and fixed_arrival=true.
If year is not provided and cannot be determined unambiguously, use null dates and add a question asking the year.
If the user specifies a country or region but not a city (e.g. 'Barcelona to Portugal, ending in Madrid'), preserve that name in requested_regions (e.g. ['Portugal']) and leave preferred null. Do not silently choose Lisbon or change the final destination. Include 'Canary Islands' in requested_regions whenever they want to visit the Canary Islands, even if La Palma is preferred. Do not infer that a connection city is a requested destination. If a specific stop (Lisbon, Porto, Faro, La Palma) was requested, use its airport code in preferred. Use an empty requested_regions array if no region is mentioned.
The user may prefer La Palma for all the time, or optionally Tenerife: capture this as soft preferences and alternate stops.
Baggage dimensions stay null if the user only mentions one overhead carry-on. Avoid inventing airline allowances or baggage fees.
If the user does not specify a field, do not infer it from defaults. Use questions when needed.
Do not invent flights, transport modes, real prices, or route feasibility. This is only trip interpretation.`;

export async function parseWithGroq(request, {apiKey=API_KEY,model=MODEL,fetchImpl=fetch}={}) {
  if (!apiKey) throw new Error('Local server has no GROQ_API_KEY. Add your key to .env and restart the server.');
  if (typeof request !== 'string' || !request.trim() || request.length > 4000) throw new Error('Trip description must be 1 to 4,000 characters.');
  // Groq's Chat Completions endpoint supports strict JSON Schema for GPT-OSS models.
  // The key never leaves this local server; the Chrome extension sends only the trip text.
  const response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model,
      messages:[{role:'system',content:INSTRUCTIONS},{role:'user',content:request}],
      response_format:{
        type:'json_schema',
        json_schema:{name:'routewise_trip',strict:true,schema:TRIP_SCHEMA}
      },
      reasoning_effort:'low',
      max_completion_tokens:2500
    })
  });
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
  return validateTripPlan(parsed);
}

function allowedOrigin(origin) {
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return false;
  return !ALLOWED_EXTENSION_ID || origin === `chrome-extension://${ALLOWED_EXTENSION_ID}`;
}

export function createServer({parseTrip=parseWithGroq}={}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const permitted = allowedOrigin(origin);
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
    if (req.url !== '/parse-trip') {res.writeHead(404);res.end(JSON.stringify({error:'Not found.'}));return;}
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
      const result = await parseTrip(body.request);
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
