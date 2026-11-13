// Natural-language trip parsing contract. This module deliberately does not price flights.
import { AIRPORTS, parseISODate } from './core.mjs';
import { extractDateIntent } from './date-intent.mjs';
import { resolveLocation, findExplicitEndpoints, findExplicitPreferred, locationMentionedInText, countryCode, catalogMetadata } from './location-resolver.mjs';

export const CODE_SET = Object.keys(AIRPORTS);
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const airport = nullable({ type: 'string', description: 'IATA code OR full city name; use city name when uncertain of airport code.' });
const date = nullable({ type: 'string', description: 'ISO 8601 date YYYY-MM-DD, only if known unambiguously.' });
const number = nullable({ type: 'number' });
const integer = nullable({ type: 'integer' });
const yesNo = nullable({ type: 'boolean' });

export const TRIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    origin: airport,
    preferred: airport,
    destination: airport,
    destination_search: { type: 'string', enum: ['specified', 'region', 'open'] },
    depart_earliest: date,
    depart_latest: date,
    arrive_earliest: date,
    arrive_latest: date,
    fixed_departure: yesNo,
    fixed_arrival: yesNo,
    min_nights_at_preferred: integer,
    alternate_stops: { type: 'array', items: { type: 'string' } },
    requested_regions: { type: 'array', items: { type: 'string' } },
    bag_type: { type: 'string', enum: ['overhead', 'personal_item', 'checked', 'unspecified'] },
    bag_length_cm: number,
    bag_width_cm: number,
    bag_depth_cm: number,
    bag_weight_kg: number,
    max_connections: integer,
    earliest_departure_hour: integer,
    priority: { type: 'string', enum: ['lowest_cost', 'more_time_at_preferred', 'fastest', 'balance', 'unspecified'] },
    hard_constraints: { type: 'array', items: { type: 'string' } },
    soft_preferences: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'origin','preferred','destination','destination_search','depart_earliest','depart_latest',
    'arrive_earliest','arrive_latest','fixed_departure','fixed_arrival',
    'min_nights_at_preferred','alternate_stops','requested_regions','bag_type',
    'bag_length_cm','bag_width_cm','bag_depth_cm','bag_weight_kg',
    'max_connections','earliest_departure_hour','priority',
    'hard_constraints','soft_preferences','questions'
  ]
};

export const DEMO_PLAN = Object.freeze({
  origin: 'BCN', preferred: 'SPC', destination: 'MAD', destination_search: 'specified',
  depart_earliest: '2027-02-02', depart_latest: '2027-02-04',
  arrive_earliest: null, arrive_latest: '2027-02-10',
  fixed_departure: false, fixed_arrival: false,
  min_nights_at_preferred: null,
  alternate_stops: ['TFN', 'LPA'], requested_regions: ['Canary Islands'], bag_type: 'overhead',
  bag_length_cm: null, bag_width_cm: null, bag_depth_cm: null, bag_weight_kg: null,
  max_connections: null, earliest_departure_hour: null, priority: 'more_time_at_preferred',
  hard_constraints: ['Must reach Madrid by February 10, 2027'],
  soft_preferences: ['Spend most of the time on La Palma; Tenerife is optional'],
  questions: ['How many nights minimum would you like to spend on La Palma?']
});

function validateIsoDate(value, field) {
  if (value === null) return;
  try { parseISODate(value); }
  catch { throw new Error(`AI returned an invalid date for ${field}.`); }
}

export function validateTripPlan(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('AI did not return a trip object.');
  for (const key of TRIP_SCHEMA.required) if (!(key in value)) throw new Error(`AI result is missing ${key}.`);
  const plan = {};
  for (const [key, schema] of Object.entries(TRIP_SCHEMA.properties)) {
    const val = value[key];
    if (key === 'alternate_stops') {
      if (!Array.isArray(val) || val.length > 10 || val.some(code => typeof code !== 'string' || !code.trim() || code.length>120)) throw new Error('Invalid alternate stops.');
      plan[key] = [...new Set(val.map(code => resolveLocation(code)?.code || code.trim()))];
    } else if (key === 'requested_regions') {
      if (!Array.isArray(val) || val.length > 5 || val.some(x => typeof x !== 'string' || !x.trim() || x.length > 100)) throw new Error('Invalid requested regions.');
      plan[key] = [...new Set(val.map(x => x.trim()))];
    } else if (['hard_constraints','soft_preferences','questions'].includes(key)) {
      if (!Array.isArray(val) || val.length > 12 || val.some(x => typeof x !== 'string' || x.length > 250)) throw new Error(`Invalid ${key}.`);
      plan[key] = val;
    } else if (key === 'bag_type' || key === 'priority' || key === 'destination_search') {
      if (!schema.enum.includes(val)) throw new Error(`Invalid ${key}.`);
      plan[key] = val;
    } else if (['origin','preferred','destination'].includes(key)) {
      if (val !== null && (typeof val!=='string' || !val.trim() || val.length>120)) throw new Error(`Invalid location in ${key}.`);
      plan[key] = val===null ? null : (resolveLocation(val)?.code || val.trim());
    } else if (key.endsWith('_earliest') || key.endsWith('_latest')) {
      if (val !== null && typeof val !== 'string') throw new Error(`Invalid ${key}.`);
      validateIsoDate(val, key);
      plan[key] = val;
    } else if (['fixed_departure','fixed_arrival'].includes(key)) {
      if (val !== null && typeof val !== 'boolean') throw new Error(`Invalid ${key}.`);
      plan[key] = val;
    } else {
      if (val !== null && (!Number.isFinite(val) || val < 0)) throw new Error(`Invalid ${key}.`);
      if ((['max_connections','earliest_departure_hour','min_nights_at_preferred'].includes(key)) && val !== null && !Number.isInteger(val)) throw new Error(`Invalid ${key}.`);
      plan[key] = val;
    }
  }
  if (plan.earliest_departure_hour !== null && plan.earliest_departure_hour > 23) throw new Error('Departure hour must be 0-23.');
  if (plan.max_connections !== null && plan.max_connections > 10) throw new Error('Maximum connections must be 0-10.');
  if (plan.min_nights_at_preferred !== null && plan.min_nights_at_preferred > 365) throw new Error('Minimum nights is too large.');
  for (const key of ['bag_length_cm','bag_width_cm','bag_depth_cm','bag_weight_kg']) if (plan[key] !== null && plan[key] > 500) throw new Error(`${key} is implausibly large.`);
  const warnings = [];
  for (const field of ['origin','preferred','destination']) if (plan[field] && !resolveLocation(plan[field])) warnings.push(`${field} could not be matched to the current airport directory. Update airport data or edit the location.`);
  if (catalogMetadata.source==='bootstrap') warnings.push('Using a small initial airport directory. Run npm run sync:airports for worldwide airport lookup.');
  if (!plan.origin) warnings.push('Starting location was not clearly specified.');
  if (!plan.destination) warnings.push('Final destination was not clearly specified.');
  if (!plan.preferred && !plan.requested_regions.length && plan.destination_search !== 'open') warnings.push('Preferred stop was not clearly specified.');
  if (plan.destination_search === 'open') warnings.push('Destination suggestions will be AI-generated and checked against the local airport directory; routes and prices remain unverified.');
  if (plan.destination_search === 'region') warnings.push('Region suggestions use Groq and an airport directory. A listed airport does not prove flight service or fare availability.');
  if (!plan.preferred && plan.requested_regions.length) warnings.push('A region was specified without a city; RouteWise will explore candidate locations instead of choosing one for you.');
  if (!plan.depart_earliest || !plan.depart_latest) warnings.push('Departure dates are incomplete; review dates before generating routes.');
  if (!plan.arrive_latest) warnings.push('Final arrival date/deadline was not specified; review dates before generating routes.');
  if (plan.depart_earliest && plan.depart_latest && plan.depart_earliest > plan.depart_latest) throw new Error('Departure date range is reversed.');
  if (plan.arrive_earliest && plan.arrive_latest && plan.arrive_earliest > plan.arrive_latest) throw new Error('Arrival date range is reversed.');
  if (plan.depart_earliest && plan.arrive_latest && plan.depart_earliest >= plan.arrive_latest) throw new Error('The arrival deadline must be after the departure start.');
  if (plan.fixed_departure === true && plan.depart_earliest && plan.depart_latest && plan.depart_earliest !== plan.depart_latest) warnings.push('Departure marked fixed but a date range was supplied. Please review.');
  if (plan.fixed_arrival === true && plan.arrive_earliest && plan.arrive_latest && plan.arrive_earliest !== plan.arrive_latest) warnings.push('Arrival marked fixed but a date range was supplied. Please review.');
  if (plan.bag_type === 'overhead' && [plan.bag_length_cm,plan.bag_width_cm,plan.bag_depth_cm].some(v => v===null)) warnings.push('Overhead bag dimensions were not provided; the saved bag profile can fill this gap.');
  if (plan.min_nights_at_preferred !== null) warnings.push('Minimum nights will be checked against tentative stop dates, not against real schedules.');
  if ((plan.depart_earliest && plan.depart_latest && plan.depart_earliest !== plan.depart_latest) || (plan.arrive_earliest && plan.arrive_latest && plan.arrive_earliest !== plan.arrive_latest)) warnings.push('Flexible windows can create tentative route dates; actual services and fares are not searched.');
  return { plan, warnings };
}

function escapeRx(str) {return str.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function explicitlyNamedOtherCity(text, origin, destination) {
  // Detect whether the user explicitly named a third city. Exact matching is
  // based on the downloaded airport directory, not manually listed countries.
  const matches = [...new Set((text.match(/\b[\p{L}][\p{L} '-]{2,60}\b/gu) || []))];
  return matches.some(fragment => {
    const location = resolveLocation(fragment);
    return location && location.code!==origin && location.code!==destination;
  });
}
function preserveExplicitEndpoints(text, plan) {
  const endpoints = findExplicitEndpoints(text);
  if (endpoints.origin) plan.origin=endpoints.origin;
  if (endpoints.destination) plan.destination=endpoints.destination;
}

export function normalizeTripWithDiagnostics(text, rawPlan, {referenceDate=new Date().toISOString().slice(0,10)}={}) {
  const request=String(text||'');
  const plan=structuredClone(rawPlan);
  for (const key of ['origin','preferred','destination']) {
    if (plan[key]) plan[key] = resolveLocation(plan[key])?.code || plan[key];
  }
  plan.alternate_stops=(plan.alternate_stops||[]).map(code=>resolveLocation(code)?.code||code);
  preserveExplicitEndpoints(request,plan);
  const start=resolveLocation(plan.origin);
  const end=resolveLocation(plan.destination);
  // When the traveler explicitly names a vacation destination, use their
  // wording instead of trusting a real-but-unrelated airport from Groq.
  // A shared origin/end country helps disambiguate similarly named places.
  const explicitPreferred=findExplicitPreferred(request,{
    country:start && end && start.country===end.country ? start.country : null
  });
  if(explicitPreferred) plan.preferred=explicitPreferred.code;
  else if(plan.destination_search==='specified' && plan.preferred &&
      !locationMentionedInText(request,plan.preferred)) {
    // A genuine airport code is not evidence that the traveler chose it.
    // Never silently accept an unmentioned destination hallucinated by the LLM.
    plan.preferred=null;
    plan.questions=[...new Set([...(plan.questions||[]),
      'The AI suggested a primary destination that is not supported by the trip description. Please select your intended destination before generating routes.'])];
  }
  const openDestination=/\b(?:any|some|suggest|recommend|open to|where(?:ver)?|anywhere)\b[^.!?\n]{0,100}\b(?:destination|place|city|cities|spots?|weekend|vacation|trip)\b/i.test(request)
    || /\b(?:anywhere|open to suggestions|surprise me)\b/i.test(request);
  // Discard a region guessed by the LLM when it is absent from the request.
  plan.requested_regions=(plan.requested_regions||[]).filter(region=>
    new RegExp(`\\b${escapeRx(region)}\\b`,'i').test(request));
  const namedRegion=plan.requested_regions.length>0;
  const namedStop = Boolean(plan.preferred && resolveLocation(plan.preferred));
  if (openDestination && !namedRegion && !explicitPreferred) {
    plan.preferred=null;
    plan.requested_regions=[];
    plan.destination_search='open';
  } else if (namedRegion && !namedStop) {
    plan.preferred=null;
    plan.destination_search='region';
  } else {
    plan.destination_search='specified';
  }
  const dates=extractDateIntent(request,{referenceDate});
  // Explicit date phrases take precedence over possibly inaccurate model outputs.
  Object.assign(plan,dates.fields);
  if (dates.inferredYear) {
    // Don't ask the user to confirm a predictable next-occurrence year.
    // Keep the fact that it was inferred available in the diagnostics.
    plan.questions=(plan.questions||[]).filter(q=>!/(?:confirm|verify|clarify|which)\b.{0,100}\byear\b/i.test(q));
  }
  // The model sometimes invents a one-night minimum for an ordinary weekend.
  // Do not turn that guess into a required constraint unless the user
  // actually mentioned a night/overnight stay. Numeric accuracy still needs
  // user review; this guard only rejects unsupported invented constraints.
  if (plan.min_nights_at_preferred != null && !/\b(?:nights?|overnights?)\b/i.test(request)) {
    plan.min_nights_at_preferred = null;
  }
  if (plan.preferred && /(?:spend(?:ing)?\s+(?:as\s+much|the\s+most|maximum)\s+time|maximi[sz]e\s+(?:my\s+)?time|as\s+long\s+as\s+possible)/i.test(request)) {
    plan.priority='more_time_at_preferred';
  }
  if (plan.fixed_arrival===true && plan.arrive_latest && !plan.arrive_earliest) {
    plan.arrive_earliest=plan.arrive_latest;
  }
  const corrections=[];
  for (const key of Object.keys(TRIP_SCHEMA.properties)) {
    if (JSON.stringify(rawPlan[key])!==JSON.stringify(plan[key])) {
      corrections.push({field:key,model:rawPlan[key],normalized:plan[key],
        ...(key==='preferred' && explicitPreferred ?
          {source:'explicit traveler destination',evidence:explicitPreferred.evidence}: {})});
    }
  }
  return {plan,corrections,yearInferred:dates.inferredYear,dateEvidence:dates.evidence,referenceDate};
}

// Preserved compatibility with v0.3.5 tests and callers.
export function normalizeExplicitTripIntent(text, rawPlan, options={}) {
  return normalizeTripWithDiagnostics(text,rawPlan,options).plan;
}
