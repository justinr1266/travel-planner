// RouteWise deterministic guardrails for common explicitly stated travel dates.
// LLM handles less-structured requests; this module does not infer schedules or fares.
import { parseISODate } from './core.mjs';

const MONTHS = Object.freeze({
  jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,
  may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,
  oct:10,october:10,nov:11,november:11,dec:12,december:12
});
const MONTH = '(?:January|Jan\\.?|February|Feb\\.?|March|Mar\\.?|April|Apr\\.?|May|June|Jun\\.?|July|Jul\\.?|August|Aug\\.?|September|Sept?\\.?|October|Oct\\.?|November|Nov\\.?|December|Dec\\.?)';
const DATE = `(${MONTH})\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?`;
const connector = '(?:to|through|until|till|and|[-\\u2013\\u2014])';
const wholeRange = new RegExp(`${DATE}\\s*${connector}\\s*${DATE}`, 'i');
const sameMonthRange = new RegExp(`${DATE}\\s*[-\\u2013\\u2014]\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
const explicitDate = new RegExp(DATE,'ig');

function iso(y,m,d) {
  const value=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  try {parseISODate(value); return value;} catch {return null;}
}
function normalizeMonth(value) {return MONTHS[value.toLowerCase().replace('.','')] || null;}
function referenceYear(date) {
  const parsed = parseISODate(date);
  return parsed.getUTCFullYear();
}
function dateValue(month,day,year,referenceDate) {
  const mon = normalizeMonth(month);
  if (!mon) return null;
  const inferred = !year;
  let y = year ? Number(year) : referenceYear(referenceDate);
  let value=iso(y,mon,Number(day));
  if (!value) return null;
  if (inferred && value < referenceDate) {
    y += 1;
    value=iso(y,mon,Number(day));
  }
  return value ? {date:value,inferred} : null;
}
function inferPair(a,b,referenceDate) {
  if (!a || !b) return null;
  let left=a, right=b;
  // A date range is a single trip: use an explicitly given year on either end.
  if (a.year || b.year) {
    const startYear=Number(a.year || b.year);
    left=dateValue(a.month,a.day,String(startYear),referenceDate);
    right=dateValue(b.month,b.day,String(b.year || startYear),referenceDate);
    if (left && right && !b.year && right.date < left.date) {
      right=dateValue(b.month,b.day,String(startYear+1),referenceDate);
    }
    return left && right && left.date < right.date ? {left,right,inferred:false} : null;
  }
  left=dateValue(a.month,a.day,null,referenceDate);
  if (!left) return null;
  right=dateValue(b.month,b.day,left.date.slice(0,4),referenceDate);
  if (right && right.date < left.date) right=dateValue(b.month,b.day,String(Number(left.date.slice(0,4))+1),referenceDate);
  return right && left.date < right.date ? {left,right,inferred:true} : null;
}
function captureDate(matches,idx) {
  return {month:matches[idx],day:matches[idx+1],year:matches[idx+2]};
}
function createResult() {
  return {fields:{},inferredYear:false,evidence:[],notes:[]};
}
function annotate(result,fields,label,inferred) {
  Object.assign(result.fields,fields);
  result.evidence.push(label);
  result.inferredYear ||= inferred;
}

// referenceDate must be an ISO calendar date; it is provided explicitly in tests
// and by the local server in normal use. No browser locale/date APIs are needed.
export function extractDateIntent(text,{referenceDate=new Date().toISOString().slice(0,10)}={}) {
  parseISODate(referenceDate);
  const request=String(text||'');
  const out=createResult();
  const explicitYears=[...new Set([...request.matchAll(/\b20\d{2}\b/g)].map(m=>m[0]))];
  const sharedYear=explicitYears.length===1 ? explicitYears[0] : null;
  const whole=wholeRange.exec(request);
  const short=whole ? null : sameMonthRange.exec(request);
  const selected=whole || short;
  if (selected) {
    const a=captureDate(selected,1);
    const b=whole ? captureDate(selected,4) : {month:a.month,day:selected[4],year:a.year};
    if (sharedYear && !a.year && !b.year) {a.year=sharedYear;b.year=sharedYear;}
    const pair=inferPair(a,b,referenceDate);
    const before=request.slice(Math.max(0,selected.index-45),selected.index).toLowerCase();
    const departureOnly=/\b(?:depart(?:ure|ing)?|leav(?:e|ing)|fly(?:ing)?\s+out)\b[^.!?\n]{0,45}$/.test(before);
    if (pair) {
      if (departureOnly) {
        annotate(out,{depart_earliest:pair.left.date,depart_latest:pair.right.date,fixed_departure:false},'Explicit flexible departure date range',pair.inferred);
      } else {
        annotate(out,{
          depart_earliest:pair.left.date,depart_latest:pair.left.date,fixed_departure:true,
          arrive_earliest:pair.right.date,arrive_latest:pair.right.date,fixed_arrival:true
        },'Explicit trip start/end date range',pair.inferred);
      }
    }
  }
  // Handle separate clauses: 'leave on Jan 11' and 'arrive in Madrid by Jan 18'.
  // Only act on an explicit travel verb; a sight-seeing date must not become a flight date.
  const mentions=[...request.matchAll(explicitDate)].map(m=>({
    index:m.index,end:m.index+m[0].length,...captureDate(m,1)
  }));
  for (const mention of mentions) {
    if (selected && mention.index >= selected.index && mention.index < selected.index + selected[0].length) continue;
    const prefix=request.slice(Math.max(0,mention.index-100),mention.index).toLowerCase();
    const clause=prefix.split(/[;.!?\n]/).at(-1).slice(-90);
    const departure=/\b(?:depart(?:ure|ing)?|leav(?:e|ing)|fly(?:ing)?\s+out|start(?:ing)?)\b/.test(clause);
    const arrival=/\b(?:arriv(?:e|ing)|return(?:ing)?|get\s+back|be\s+back|end(?:ing)?|finish(?:ing)?)\b/.test(clause);
    if (!departure && !arrival) continue;
    const lastDeparture=clause.search(/\b(?:depart(?:ure|ing)?|leav(?:e|ing)|fly(?:ing)?\s+out|start(?:ing)?)\b/);
    const lastArrival=clause.search(/\b(?:arriv(?:e|ing)|return(?:ing)?|get\s+back|be\s+back|end(?:ing)?|finish(?:ing)?)\b/);
    const kind=arrival && (!departure || lastArrival>lastDeparture) ? 'arrival' : 'departure';
    // Keep years consistent with an explicit trip start or end if this date omitted its year.
    let startYear=mention.year || sharedYear;
    if (!startYear && out.fields.depart_earliest) startYear=out.fields.depart_earliest.slice(0,4);
    if (!startYear && out.fields.arrive_latest) startYear=out.fields.arrive_latest.slice(0,4);
    let d=dateValue(mention.month,mention.day,startYear,referenceDate);
    if (!d) continue;
    const inferred=!mention.year && !sharedYear;
    if (kind==='arrival' && out.fields.depart_earliest && d.date<out.fields.depart_earliest && inferred) {
      d=dateValue(mention.month,mention.day,String(Number(out.fields.depart_earliest.slice(0,4))+1),referenceDate);
    }
    if (!d) continue;
    const isDeadline=kind==='arrival' && /\b(?:by|no\s+later\s+than|before)\s*$/.test(clause);
    if (kind==='arrival') {
      annotate(out,{arrive_earliest:isDeadline?null:d.date,arrive_latest:d.date,fixed_arrival:!isDeadline},'Explicit final arrival date',inferred);
    } else {
      annotate(out,{depart_earliest:d.date,depart_latest:d.date,fixed_departure:true},'Explicit departure date',inferred);
    }
  }
  // Yearless dates intentionally use the next occurrence on/after referenceDate.
  // Diagnostics still record inferredYear, but it is not a blocking question.
  return out;
}
