// A general-purpose, offline lookup based on an airport directory, not country rules.
import { AIRPORT_RECORDS, AIRPORT_CATALOG_META } from './airport-catalog.mjs';

export const catalogMetadata = AIRPORT_CATALOG_META;
export const LOCATION_RECORDS = AIRPORT_RECORDS;
export function fold(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9]+/g,' ').trim();
}
const names = new Intl.DisplayNames(['en'],{type:'region'});
export function countryName(code) {
  try {return names.of(code);} catch {return code;}
}
export function countryCode(name, records=LOCATION_RECORDS) {
  const match = fold(name);
  if (!match) return null;
  for (const code of new Set(records.map(r=>r[2]))) {
    if (fold(code)===match || fold(countryName(code))===match) return code;
  }
  return null;
}
export function airportDirectory(records=LOCATION_RECORDS) {
  return Object.fromEntries(records.map(([code,city,country,label])=>[code,label||city]));
}
// Resolve by real IATA code, municipality, or airport label. Country disambiguates
// same-name cities. Do not use a model's asserted airport code without matching data.
export function resolveLocation(query,{country=null,records=LOCATION_RECORDS}={}) {
  const requested = fold(query);
  if (!requested || String(query).length>120) return null;
  const countryFilter = country ? countryCode(country,records) : null;
  const matches = records.filter(r=>!countryFilter || r[2]===countryFilter);
  const byCode = matches.find(r=>fold(r[0])===requested);
  const byCity = matches.filter(r=>fold(r[1])===requested);
  const byName = matches.filter(r=>fold(r[3])===requested);
  const byAirportPrefix = matches.filter(r=>fold(r[3]).startsWith(requested+' '));
  const candidate = byCode || byCity.find(r=>r[4]==='metro') || byCity[0] || byName[0] || byAirportPrefix[0];
  if (!candidate) return null;
  return {code:candidate[0],city:candidate[1],country:candidate[2],label:candidate[3],kind:candidate[4]};
}
// When Groq supplies a real airport code, distinguish an airport merely
// existing in the directory from that airport being grounded in the request.
// This intentionally uses the user's wording, not a list of favorite places.
export function locationMentionedInText(text, code, {records=LOCATION_RECORDS}={}) {
  const place=records.find(r=>r[0]===code);
  if(!place) return null;
  const haystack=` ${fold(text)} `;
  const label=String(place[3]||'');
  const shortLabel=label.replace(/\s+(?:(?:international|regional|city|municipal)\s+)?(?:airport|aeropuerto|aerodrome|airfield)\s*$/i,'');
  const names=[place[0],place[1],label,shortLabel];
  for(const name of names) {
    const normalized=fold(name);
    if(normalized.length<3 || normalized==='airport') continue;
    if(haystack.includes(` ${normalized} `)) return name;
  }
  return null;
}

export function resolveSuggestedDestination(item,{region='',records=LOCATION_RECORDS}={}) {
  if (!item || typeof item.city!=='string' || typeof item.country!=='string') return null;
  const regionCode=countryCode(region,records);
  const declaredCountry=countryCode(item.country,records);
  if (!declaredCountry || (regionCode && declaredCountry!==regionCode)) return null;
  let found=resolveLocation(item.city,{country:item.country,records});
  if (!found && typeof item.code==='string') {
    const fromCode=resolveLocation(item.code,{country:item.country,records});
    // The directory verifies the airport and country. If the suggested city
    // name differs from the airport municipality, prefer directory metadata.
    if (fromCode) found=fromCode;
  }
  if (!found) return null;
  return {code:found.code,city:found.city,country:countryName(found.country),airportName:found.label,verifiedCode:true};
}

// Primary-destination evidence must come from the traveler's words. Groq may
// return an unrelated *real* airport, which passing directory validation alone
// cannot catch. This small, cached alias index resolves only locations explicitly
// following destination phrases (not arbitrary airport names elsewhere in text).
const preferredAliases=new WeakMap();
function preferredIndex(records) {
  const cached=preferredAliases.get(records);
  if(cached) return cached;
  const aliases=new Map();
  const add=(name,row,rank)=>{
    const key=fold(name);
    if(!key) return;
    const entries=aliases.get(key)||[];
    if(!entries.some(entry=>entry.row===row && entry.rank===rank)) entries.push({row,rank});
    aliases.set(key,entries);
  };
  for(const row of records) {
    add(row[0],row,150); // exact IATA code
    add(row[1],row,110); // municipality
    add(row[3],row,140); // exact airport name
    // "La Palma" should match "La Palma Airport" without a country-specific
    // list. Generic airport suffixes also work for arbitrary other places.
    const shortName=String(row[3]||'').replace(/\s+(?:(?:international|regional|city|municipal)\s+)?(?:airport|aeropuerto|aerodrome|airfield)\s*$/i,'');
    if(shortName!==row[3]) add(shortName,row,130);
  }
  preferredAliases.set(records,aliases);
  return aliases;
}

const PRIMARY_PATTERNS=Object.freeze([
  {rank:120,pattern:/\b(?:primary|main|vacation)\s+destination\s*(?:(?:is|:|of)\s*)?/gi},
  {rank:115,pattern:/\b(?:spend(?:ing)?|stay(?:ing)?)\s+(?:(?:as\s+much|the\s+most|most|maximum|more)\s+time\s+)?(?:in|on|at)\s+/gi},
  {rank:105,pattern:/\b(?:preferably|especially|ideally)\s+(?:in\s+|on\s+)?/gi},
  {rank:100,pattern:/\b(?:want|wish|plan|hope|like)\s+to\s+(?:go|travel|fly)\s+to\s+/gi},
  {rank:100,pattern:/\b(?:want|wish|plan|hope|like)\s+to\s+(?:visit|explore|see)\s+/gi},
  {rank:100,pattern:/\b(?:trip|vacation|holiday|weekend|break)\s+(?:to|in|on|at)\s+/gi},
  {rank:98,pattern:/\b(?:head(?:ed|ing)?|off)\s+to\s+/gi},
  {rank:95,pattern:/\b(?:spend(?:ing)?|stay(?:ing)?)\s+(?:a\s+)?(?:few\s+)?(?:days?|weeks?|nights?)\s+(?:in|on|at)\s+/gi},
  {rank:90,pattern:/\b(?:go(?:ing)?|travel(?:ing|ling)?|fly(?:ing)?)\s+to\s+/gi},
  {rank:85,pattern:/\b(?:visit(?:ing)?|explor(?:e|ing)|vacation(?:ing)?)\s+(?:(?:in|on|at)\s+)?/gi}
]);

function preferredAfter(text,index,preferredCountry) {
  // Match the LONGEST complete location prefix after a destination phrase.
  // A generic request such as "visit any island" cannot invent an airport.
  const prefix=String(text).slice(0,130).split(/[,;.!?\n]/,1)[0].trimStart();
  const words=(prefix.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)||[]).slice(0,9);
  for(let n=words.length;n>=1;n--) {
    const value=words.slice(0,n).join(' ');
    const matches=index.get(fold(value));
    if(!matches) continue;
    const sorted=[...matches].sort((a,b)=>
      (b.rank+(preferredCountry&&b.row[2]===preferredCountry?25:0))-
      (a.rank+(preferredCountry&&a.row[2]===preferredCountry?25:0)) ||
      a.row[0].localeCompare(b.row[0]));
    return {code:sorted[0].row[0],name:value,country:sorted[0].row[2]};
  }
  return null;
}

export function findExplicitPreferred(text,{records=LOCATION_RECORDS,country=null}={}) {
  const request=String(text??'');
  const index=preferredIndex(records);
  const preferredCountry=country ? countryCode(country,records) : null;
  const found=[];
  for(const {pattern,rank} of PRIMARY_PATTERNS) {
    const matcher=new RegExp(pattern.source,pattern.flags);
    for(const match of request.matchAll(matcher)) {
      const name=preferredAfter(request.slice(match.index+match[0].length),index,preferredCountry);
      if(name) found.push({...name,rank,offset:match.index,
        evidence:request.slice(match.index,match.index+match[0].length)+name.name});
    }
  }
  // Clear prioritization: "primary destination" and time-spent phrases beat
  // incidental references to places the traveler may connect through.
  found.sort((a,b)=>b.rank-a.rank || a.offset-b.offset);
  return found[0]||null;
}

// Identify city names from the text FOLLOWING travel phrases, rather than
// compiling and evaluating a regex for every airport/city in the directory.
// The old approach was O(number of airports x regex compilation) per request.
const ENDPOINT_PATTERNS = Object.freeze({
  both: /\b(?:start(?:ing)?|leav(?:e|ing))\s+and\s+(?:end(?:ing)?|return(?:ing)?)\s+(?:in|at|from|to)\s+/gi,
  origin: /\b(?:start(?:ing)?|leav(?:e|ing)|depart(?:ing)?|from)\s+(?:(?:in|at|from)\s+)?/gi,
  destination: /\b(?:end(?:ing)?|finish(?:ing)?|arriv(?:e|ing)|return(?:ing)?|get\s+back|be\s+back)\s+(?:(?:in|at|to)\s+)?/gi
});

// Cache name lookups once per directory. This also avoids scanning every record
// for each candidate word prefix. WeakMap allows test directories to be freed.
const endpointAliases=new WeakMap();
function endpointIndex(records){
  const cached=endpointAliases.get(records);
  if(cached) return cached;
  const aliases=new Map();
  for(const row of records){
    const code=row[0];
    for(const value of [row[0],row[1],row[3]]){
      const key=fold(value);
      if(key && (!aliases.has(key) || (row[4]==='metro' && value===row[1]))) aliases.set(key,code);
    }
  }
  endpointAliases.set(records,aliases);
  return aliases;
}

function leadingLocation(text, records) {
  // A maximum of eight leading words is ample for normal city/airport names.
  // Do not search beyond punctuation: this avoids mistaking unrelated cities
  // later in the description for the value of an endpoint phrase.
  const prefix=String(text).slice(0,110).split(/[,;.!?\n]/,1)[0].trimStart();
  const words=(prefix.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)||[]).slice(0,8);
  const index=endpointIndex(records);
  for(let n=words.length;n>=1;n--){
    const found=index.get(fold(words.slice(0,n).join(' ')));
    if(found) return found;
  }
  return null;
}

function firstEndpoint(text,pattern,records){
  // RegExp objects have a mutable lastIndex; create a fresh matcher per call.
  const matcher=new RegExp(pattern.source,pattern.flags);
  for(const match of text.matchAll(matcher)) {
    const code=leadingLocation(text.slice(match.index+match[0].length),records);
    if(code) return code;
  }
  return null;
}

export function findExplicitEndpoints(text,{records=LOCATION_RECORDS}={}) {
  const request=String(text??'');
  const both=firstEndpoint(request,ENDPOINT_PATTERNS.both,records);
  if(both) return {origin:both,destination:both};
  return {
    origin:firstEndpoint(request,ENDPOINT_PATTERNS.origin,records),
    destination:firstEndpoint(request,ENDPOINT_PATTERNS.destination,records)
  };
}
