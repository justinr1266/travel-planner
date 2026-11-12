// RouteWise's deterministic, testable planning core. No AI-generated prices.
export const AIRPORTS = Object.freeze({
  BCN: 'Barcelona', MAD: 'Madrid', SPC: 'La Palma',
  TFN: 'Tenerife North', TFS: 'Tenerife South', LPA: 'Gran Canaria',
  LIS: 'Lisbon', OPO: 'Porto', FAO: 'Faro'
});

export function airportName(code) {
  return AIRPORTS[code] ?? code;
}

export function parseISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new Error('Use YYYY-MM-DD dates.');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Enter a valid calendar date.');
  }
  return date;
}

function addDays(dateString, days) {
  const date = parseISODate(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function legKey(leg) {
  return [leg.from, leg.to, leg.date, leg.mode].join('|');
}

function buildRoute(id, name, details, nodes, modes, startDate, endDate) {
  const totalDays = Math.round((parseISODate(endDate) - parseISODate(startDate)) / 86400000);
  const n = nodes.length - 1;
  const legs = [];
  for (let i = 0; i < n; i += 1) {
    const leg = {
      from: nodes[i], to: nodes[i + 1], mode: modes[i],
      date: i === n - 1 ? endDate : addDays(startDate, Math.floor(totalDays * i / n))
    };
    leg.key = legKey(leg);
    legs.push(leg);
  }
  return { id, name, details, legs };
}

export function generateRoutes(trip) {
  const { origin, preferred, destination, startDate, endDate } = trip;
  for (const code of [origin, preferred, destination]) {
    if (!(code in AIRPORTS)) throw new Error(`Unsupported airport: ${code}. Select a listed airport.`);
  }
  const days = (parseISODate(endDate) - parseISODate(startDate)) / 86400000;
  if (days < 2) throw new Error('Please allow at least two days between start and end.');
  if (origin === destination || preferred === origin || preferred === destination) {
    throw new Error('For this initial demo, choose three distinct places.');
  }
  const proposals = [
    ['direct', 'Most time at preferred destination', 'Direct or connecting flight; availability not checked.',
      [origin, preferred, destination], ['flight', 'flight']],
    ['tenerife', 'Via Tenerife North', 'Compare an inter-island flight to your preferred destination.',
      [origin, 'TFN', preferred, destination], ['flight', 'flight', 'flight']],
    ['madrid', 'Rail connection via Madrid', 'High-speed rail for Barcelona–Madrid when relevant; otherwise flights.',
      [origin, 'MAD', preferred, destination], [origin === 'BCN' ? 'train' : 'flight', 'flight', 'flight']],
    ['gran-canaria', 'Via Gran Canaria', 'Compare an alternate island connection.',
      [origin, 'LPA', preferred, destination], ['flight', 'flight', 'flight']],
    ['ferry', 'Tenerife + ferry option', 'Ferry schedules and port transfer costs must be checked separately.',
      [origin, 'TFN', preferred, destination], ['flight', 'ferry', 'flight']]
  ];
  return proposals
    .filter(([, , , nodes]) => nodes.every((code, i) => i === 0 || code !== nodes[i - 1]))
    .map(([id, name, details, nodes, modes]) => buildRoute(id, name, details, nodes, modes, startDate, endDate))
    .slice(0, 5);
}

export function costSummary(route, offers) {
  let known = 0;
  let missing = 0;
  for (const leg of route.legs) {
    const offer = offers[leg.key];
    if (!offer || !Number.isFinite(offer.fare)) {
      missing += 1;
    } else {
      known += offer.fare + (offer.bagFee || 0) + (offer.transferCost || 0);
    }
  }
  return {
    complete: missing === 0,
    missing,
    known,
    total: missing === 0 ? known : null,
    pricedLegs: route.legs.length - missing
  };
}

export function rankRoutes(routes, offers) {
  return routes.map((route, index) => ({ route, summary: costSummary(route, offers), index }))
    .sort((a, b) => {
      if (a.summary.complete !== b.summary.complete) return a.summary.complete ? -1 : 1;
      if (a.summary.complete) return a.summary.total - b.summary.total || a.index - b.index;
      return a.summary.missing - b.summary.missing || a.index - b.index;
    });
}

export function normalizedOffer(fields) {
  function nonNegative(value, label) {
    const number = Number(value);
    if (value === '' || value === null || !Number.isFinite(number) || number < 0) {
      throw new Error(`${label} must be zero or greater.`);
    }
    return Math.round(number * 100) / 100;
  }
  const source = (fields.source ?? '').trim();
  if (source) {
    const url = new URL(source);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Source must be an http(s) URL.');
  }
  return {
    fare: nonNegative(fields.fare, 'Base fare'),
    bagFee: nonNegative(fields.bagFee ?? 0, 'Baggage cost'),
    transferCost: nonNegative(fields.transferCost ?? 0, 'Transfer cost'),
    source,
    note: String(fields.note ?? '').trim().slice(0, 500),
    checkedAt: new Date().toISOString()
  };
}
