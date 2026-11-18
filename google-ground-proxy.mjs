// Optional LOCAL development proxy for Maps Routes transit requests.
// Run beside the existing Groq server until we can merge this handler into
// the user's server.mjs. Never put the Maps API key in the Chrome extension.
import http from 'node:http';
import {fileURLToPath} from 'node:url';

const ENDPOINT='https://routes.googleapis.com/directions/v2:computeRoutes';
export const GROUND_FIELD_MASK=[
  'routes.duration','routes.distanceMeters','routes.travelAdvisory.transitFare',
  'routes.legs.steps.travelMode','routes.legs.steps.transitDetails'
].join(',');
const MAX_REQUEST=4096;
const VALID_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const VALID_ORIGIN=/^chrome-extension:\/\/[a-p]{32}$/;

function validateAddress(text){
  if(typeof text!=='string'||!text.trim()||text.length>150||/[\x00-\x1f\x7f]/.test(text))
    throw new Error('Select valid origin and destination station or airport names.');
  return text.trim();
}
function parseTime(input,now){
  if(!input?.time)throw new Error('Choose a local date/time and time zone before researching a transfer.');
  const val=String(input.time);
  if(!VALID_TIME.test(val)||!Number.isFinite(Date.parse(val)))throw new Error('Use a valid transit date/time.');
  const ts=Date.parse(val);
  if(ts<now-7*86400000||ts>now+100*86400000)throw new Error('Google transit searches support only 7 days in the past through 100 days ahead.');
  const kind=input.timeKind;
  if(kind!=='arrival'&&kind!=='departure')throw new Error('Choose arrival or departure time.');
  return {[kind==='arrival'?'arrivalTime':'departureTime']:new Date(ts).toISOString()};
}
export function buildGroundRequest(input,{now=Date.now()}={}){
  const origin=validateAddress(input?.origin),destination=validateAddress(input?.destination);
  if(origin===destination)throw new Error('Select different stations or airports.');
  return {origin:{address:origin},destination:{address:destination},travelMode:'TRANSIT',
    computeAlternativeRoutes:true,...parseTime(input,now)};
}
function moneyValue(money){
  if(!money||typeof money.currencyCode!=='string')return null;
  const amount=Number(money.units||0)+Number(money.nanos||0)/1e9;
  if(!Number.isFinite(amount)||amount<0)return null;
  return {currencyCode:money.currencyCode,amount:Math.round(amount*100)/100};
}
export function normalizeGoogleTransit(data,requestedDate){
  const routes=(Array.isArray(data?.routes)?data.routes:[]).slice(0,4).map(route=>{
    const steps=(route.legs||[]).flatMap(l=>l.steps||[]).slice(0,50);
    const transit=steps.filter(s=>s.transitDetails).map(s=>{
      const d=s.transitDetails;
      return {mode:String(d.transitLine?.vehicle?.type||'TRANSIT').slice(0,30),
        line:String(d.transitLine?.nameShort||d.transitLine?.name||'').slice(0,100),
        from:String(d.stopDetails?.departureStop?.name||'').slice(0,100),
        to:String(d.stopDetails?.arrivalStop?.name||'').slice(0,100),
        departureTime:d.stopDetails?.departureTime||null,arrivalTime:d.stopDetails?.arrivalTime||null};
    });
    const seconds=typeof route.duration==='string' && /^\d+(?:\.\d+)?s$/.test(route.duration) ? Number(route.duration.slice(0,-1)) : null;
    const fare=moneyValue(route.travelAdvisory?.transitFare);
    return {durationMinutes:seconds!==null && Number.isFinite(seconds)?Math.round(seconds/60):null,
      distanceMeters:Number.isFinite(route.distanceMeters)?route.distanceMeters:null,
      fare,transit};
  });
  return {source:'Google Maps Routes',attribution:'© Google Maps',requestedDate,dated:true,
    found:routes.length>0,routes};
}
export async function researchGoogleTransit(input,{apiKey,fetchImpl=fetch,now=Date.now()}={}){
  if(!apiKey)throw new Error('GOOGLE_MAPS_API_KEY is not configured on the local proxy.');
  const body=buildGroundRequest(input,{now});
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input?.localDate||''))throw new Error('Provide the local date of this transit search.');
  const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'content-type':'application/json',
    'X-Goog-Api-Key':apiKey,'X-Goog-FieldMask':GROUND_FIELD_MASK},body:JSON.stringify(body),
    signal:AbortSignal.timeout(16000)});
  if(!response.ok)throw new Error(response.status===429?'Google routing quota exceeded.':
    response.status===403?'Google Maps Routes API access denied. Check project billing and key restrictions.':
    `Google transit routing failed (HTTP ${response.status}).`);
  const data=await response.json();
  return normalizeGoogleTransit(data,input.localDate);
}
const send=(res,code,body,origin)=>{
  res.writeHead(code,{'content-type':'application/json','cache-control':'no-store',
    ...(origin?{'access-control-allow-origin':origin,'vary':'Origin'}:{})});
  res.end(JSON.stringify(body));
};
export function createGoogleGroundServer({apiKey=process.env.GOOGLE_MAPS_API_KEY,fetchImpl=fetch}={}){
  let dayStamp='',dailyCalls=0;
  return http.createServer(async(req,res)=>{
    const origin=String(req.headers.origin||'');
    if(!VALID_ORIGIN.test(origin)){send(res,403,{error:'Only local RouteWise Chrome extensions can request transit research.'});return;}
    if(req.method==='OPTIONS'){
      res.writeHead(204,{'access-control-allow-origin':origin,
        'access-control-allow-methods':'POST, OPTIONS',
        'access-control-allow-headers':'content-type',
        'access-control-max-age':'600','vary':'Origin'});res.end();return;
    }
    if(req.url!=='/ground-transit'||req.method!=='POST'){
      send(res,404,{error:'Unknown endpoint.'},origin);return;
    }
    if(!String(req.headers['content-type']||'').startsWith('application/json')){
      send(res,415,{error:'Use application/json.'},origin);return;
    }
    try{
      const parts=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>MAX_REQUEST)throw new Error('Request too large.');parts.push(chunk);}
      const data=JSON.parse(Buffer.concat(parts).toString('utf8'));
      // Development safeguard: per-process request ceiling; set a Google Cloud
      // daily quota as the real billing safety net.
      const day=new Date().toISOString().slice(0,10);
      if(day!==dayStamp){dayStamp=day;dailyCalls=0;}
      if(dailyCalls>=100)throw new Error('Local transit research limit (100 Google requests/day) reached.');
      buildGroundRequest(data); // Validate before counting a potentially billable call.
      dailyCalls++;
      const result=await researchGoogleTransit(data,{apiKey,fetchImpl});
      send(res,200,result,origin);
    }catch(error){
      const message=String(error?.message||'Transit lookup failed.').slice(0,180);
      send(res,/API key|configured|access denied|quota/.test(message)?503:400,{error:message},origin);
    }
  });
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const server=createGoogleGroundServer();
  server.listen(8788,'127.0.0.1',()=>process.stdout.write('RouteWise Google transit proxy listening at http://127.0.0.1:8788\n'));
}
