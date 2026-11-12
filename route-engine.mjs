// RouteWise v0.3: deterministic candidate ROUTE PATTERNS, not scheduled or priced trips.
// The LLM extracts intent; this module maps known regions to a small curated place catalog.
import { AIRPORTS, legKey, parseISODate } from './core.mjs';

const DAY = 86400000;
const PORTUGAL = new Set(['LIS', 'OPO', 'FAO']);
const CANARIES = new Set(['SPC', 'TFN', 'TFS', 'LPA']);

function addDays(iso, amount) {
  const d = parseISODate(iso);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((parseISODate(b) - parseISODate(a)) / DAY); }
function itineraryDates(nodes, start, end) {
  const legCount = nodes.length - 1;
  const duration = daysBetween(start, end);
  if (duration < legCount) return null;
  const dates = [];
  for (let i = 0; i < legCount; i += 1) {
    const offset = legCount === 1 ? 0 : Math.round(duration * i / (legCount - 1));
    dates.push(addDays(start, offset));
  }
  return dates;
}
function modesFor(nodes, special = {}) {
  return nodes.slice(1).map((to, index) => {
    const from = nodes[index];
    if (index === 0 && special.firstTrain && from === 'BCN' && to === 'MAD') return 'train';
    if (from === 'OPO' && to === 'LIS') return 'train';
    if (from === 'LIS' && to === 'OPO') return 'train';
    if (from === 'LIS' && to === 'FAO') return 'train';
    return 'flight';
  });
}
function hasEnoughPreferredNights(nodes, dates, preferred, minimum) {
  if (minimum === null || !preferred) return true;
  const visit = nodes.indexOf(preferred);
  if (visit <= 0 || visit >= nodes.length - 1) return true;
  return daysBetween(dates[visit - 1], dates[visit]) >= minimum;
}
function proposal(id, name, description, nodes, extra = {}) {
  return { id, name, description, nodes, extra };
}
function containsCountry(regions, name) {
  return regions.some(x => x.toLowerCase().replace(/\s+/g, ' ').trim() === name);
}

export function generatePlannedRoutes(plan, {maxRoutes = 5} = {}) {
  if (!plan?.origin || !plan?.destination) throw new Error('Specify an origin and final destination before generating routes.');
  if (!AIRPORTS[plan.origin] || !AIRPORTS[plan.destination]) throw new Error('One of the airport codes is not supported.');
  if (!plan.depart_earliest || !plan.depart_latest || !plan.arrive_latest) throw new Error('Specify a departure window and final arrival deadline.');
  if (daysBetween(plan.depart_earliest, plan.depart_latest) < 0) throw new Error('Departure date range is reversed.');
  if (daysBetween(plan.depart_earliest, plan.arrive_latest) < 1) throw new Error('Arrival deadline must be later than departure.');
  if (!Number.isInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > 20) throw new Error('Invalid route limit.');
  if (plan.min_nights_at_preferred != null && !plan.preferred) {
    throw new Error('Minimum nights at preferred stop requires a specific preferred destination.');
  }

  const origin = plan.origin;
  const final = plan.destination;
  const regions = plan.requested_regions ?? [];
  const portugal = containsCountry(regions, 'portugal') || PORTUGAL.has(plan.preferred);
  const canaries = containsCountry(regions, 'canary islands') || CANARIES.has(plan.preferred);
  const proposals = [];

  if (portugal && !canaries) {
    const main = plan.preferred && PORTUGAL.has(plan.preferred) ? plan.preferred : null;
    for (const [code, label] of [['LIS', 'Lisbon'], ['OPO', 'Porto'], ['FAO', 'Faro']]) {
      if (main && code !== main) continue;
      proposals.push(proposal(`portugal-${code.toLowerCase()}`, `Portugal via ${label}`,
        `One Portuguese city. Candidate routing only; service and fares unverified.`, [origin, code, final]));
    }
    proposals.push(proposal('portugal-porto-lisbon', 'Porto then Lisbon',
      'Includes a possible Porto to Lisbon rail segment; timetable unverified.', [origin, 'OPO', 'LIS', final]));
    proposals.push(proposal('portugal-lisbon-faro', 'Lisbon then Faro',
      'Includes a possible rail segment to Faro; timetable unverified.', [origin, 'LIS', 'FAO', final]));
    proposals.push(proposal('portugal-faro-lisbon', 'Faro then Lisbon',
      'Travel modes and schedules require verification.', [origin, 'FAO', 'LIS', final]));
  } else if (canaries && !portugal) {
    const preferred = plan.preferred && CANARIES.has(plan.preferred) ? plan.preferred : 'SPC';
    proposals.push(proposal('islands-focus', 'Focus on preferred island',
      'Direct or connecting flights may be required; flight service unverified.', [origin, preferred, final]));
    if (preferred !== 'TFN') proposals.push(proposal('islands-tenerife', 'Connect via Tenerife North',
      'Inter-island service unverified; additional transfers may be necessary.', [origin, 'TFN', preferred, final]));
    if (preferred !== 'LPA') proposals.push(proposal('islands-gran-canaria', 'Connect via Gran Canaria',
      'Alternative island routing; flight availability unverified.', [origin, 'LPA', preferred, final]));
    if (origin === 'BCN' && final === 'MAD') proposals.push(proposal('islands-rail-madrid', 'Train to Madrid, then islands',
      'Possible rail-first route; flight times and fare unverified.', [origin, 'MAD', preferred, final], {firstTrain: true}));
    if (preferred !== 'TFN' && preferred !== 'LPA') proposals.push(proposal('islands-two-stops', 'Tenerife and Gran Canaria connections',
      'Multi-island candidate; requires verification of all connections.', [origin, 'TFN', 'LPA', preferred, final]));
  } else if (!regions.length && plan.preferred && plan.preferred !== origin && plan.preferred !== final) {
    proposals.push(proposal('specific-stop', `Visit ${AIRPORTS[plan.preferred]}`,
      'Single-stop candidate; schedules and prices not verified.', [origin, plan.preferred, final]));
  } else {
    throw new Error('No candidate generator is configured for these regions yet. Portugal and the Canary Islands are supported in v0.3.');
  }

  const departureCount = daysBetween(plan.depart_earliest, plan.depart_latest) + 1;
  const unique = new Set();
  const routes = [];
  for (const candidate of proposals) {
    if (routes.length >= maxRoutes) break;
    const nodes = candidate.nodes;
    if (nodes.some(code => !AIRPORTS[code])) continue;
    if (plan.preferred && plan.preferred !== origin && plan.preferred !== final && !nodes.includes(plan.preferred)) continue;
    if (nodes.some((code, index) => index > 0 && code === nodes[index - 1])) continue;
    const signature = nodes.join('|');
    if (unique.has(signature)) continue;
    const departure = addDays(plan.depart_earliest, routes.length % departureCount);
    const dates = itineraryDates(nodes, departure, plan.arrive_latest);
    if (!dates) continue;
    if (!hasEnoughPreferredNights(nodes, dates, plan.preferred, plan.min_nights_at_preferred)) continue;
    const modes = modesFor(nodes, candidate.extra);
    const legs = nodes.slice(1).map((to, index) => {
      const leg = {from: nodes[index], to, date: dates[index], mode: modes[index]};
      leg.key = legKey(leg);
      return leg;
    });
    routes.push({id:candidate.id, name:candidate.name, details:candidate.description, legs});
    unique.add(signature);
  }
  if (routes.length === 0) throw new Error('No candidate patterns fit the current dates and minimum-stay constraints. Widen your date range.');
  return routes;
}
