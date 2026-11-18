// Traveler-facing ranking of the preliminary comparison rows returned by
// compareBroadRoutes(). Does not change fares, routing, or saved offer data.
// Unknown amounts and unknown travel times are never treated as zero.
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => Number.isInteger(value) && value > 0 ? value : 0;

export function assessItinerary(row) {
  const missing = count(row?.missing);
  const conflicts = count(row?.conflicts);
  const timingChecks = count(row?.uncheckedConnections);
  const total = numberOrNull(row?.total);
  const known = numberOrNull(row?.known);
  const complete = Boolean(row?.complete) && total !== null && missing === 0;
  const stale = Array.isArray(row?.selected) && row.selected.some(item => item?.cacheAge === 'stale');
  const trainCount = count(row?.trainCount);
  const unknownDurations = count(row?.unknownDurations);
  const durationMinutes = numberOrNull(row?.observedDurationMinutes);
  const destinationHours = numberOrNull(row?.destinationHours);
  const flags = [];
  if (missing || !complete) flags.push(missing ? `${missing} unpriced leg${missing === 1 ? '' : 's'}` : 'Incomplete estimated total');
  if (conflicts) flags.push(`${conflicts} known connection conflict${conflicts === 1 ? '' : 's'}`);
  if (timingChecks) flags.push(`${timingChecks} connection${timingChecks === 1 ? '' : 's'} need timing checks`);
  if (trainCount) flags.push(`${trainCount} train leg${trainCount === 1 ? '' : 's'}: no universal fare assumed; check operator quotes`);
  if (unknownDurations) flags.push(`${unknownDurations} flight duration${unknownDurations === 1 ? '' : 's'} unknown`);
  if (stale) flags.push('Some quotes are over 24 hours old');
  flags.push('Search prices are not verified booking offers; baggage and seller terms need checking');
  const tier = conflicts ? 3 : !complete ? 2 : timingChecks ? 1 : 0;
  const label = conflicts ? 'Connection conflict' : !complete ? 'Incomplete estimate' : timingChecks ? 'Check connection times' : 'Complete indicative estimate';
  return {tier, label, flags, complete, total, known, missing, conflicts, timingChecks, stale,
    durationMinutes, destinationHours, trainCount, unknownDurations};
}

const compareKnownAscending = (a,b) => a === null ? b === null ? 0 : 1 : b === null ? -1 : a-b;
const compareKnownDescending = (a,b) => a === null ? b === null ? 0 : 1 : b === null ? -1 : b-a;

export function rankItineraryComparisons(rows, goal = 'more_time_at_preferred') {
  if (!Array.isArray(rows)) return [];
  const decorated = rows.map((row,index) => ({...row, assessment:assessItinerary(row), originalIndex:index}));
  decorated.sort((a,b) => {
    const x=a.assessment, y=b.assessment;
    if (x.tier !== y.tier) return x.tier-y.tier;
    if (x.tier >= 2) {
      // Never rank an incomplete route as cheapest by its known subtotal.
      return x.missing-y.missing || x.timingChecks-y.timingChecks || a.originalIndex-b.originalIndex;
    }
    if (goal==='lowest_cost') {
      const order=compareKnownAscending(x.total,y.total);
      if(order) return order;
    } else if (goal==='more_time_at_preferred') {
      const order=compareKnownDescending(x.destinationHours,y.destinationHours);
      if(order) return order;
    } else if (goal==='fastest') {
      // Flight time is NOT full journey time. Use a stable grouping so that
      // unknown rail/transfer times are never silently assumed to be zero.
      const xHasFlightTime=!x.trainCount && !x.unknownDurations && x.durationMinutes!==null;
      const yHasFlightTime=!y.trainCount && !y.unknownDurations && y.durationMinutes!==null;
      if(xHasFlightTime!==yHasFlightTime) return xHasFlightTime?-1:1;
      if(xHasFlightTime) {
        const order=compareKnownAscending(x.durationMinutes,y.durationMinutes);
        if(order) return order;
      }
    } else if (goal==='balance') {
      // A stable, transparent two-factor ranking: cheaper overall estimate
      // and longer primary-destination stay; missing stays are never assumed 0.
      const peers=decorated.filter(r=>r.assessment.tier===x.tier && r.assessment.total!==null);
      const priceRange=Math.max(1,...peers.map(r=>r.assessment.total)) - Math.min(...peers.map(r=>r.assessment.total)) || 1;
      const stayPeers=peers.filter(r=>r.assessment.destinationHours!==null);
      const stayRange=stayPeers.length ? Math.max(1,...stayPeers.map(r=>r.assessment.destinationHours)) - Math.min(...stayPeers.map(r=>r.assessment.destinationHours)) || 1 : 1;
      const minPrice=Math.min(...peers.map(r=>r.assessment.total));
      const maxStay=stayPeers.length ? Math.max(...stayPeers.map(r=>r.assessment.destinationHours)) : null;
      const score=z=>(z.total===null?1:(z.total-minPrice)/priceRange) +
        (maxStay===null?0:z.destinationHours===null?1:(maxStay-z.destinationHours)/stayRange);
      const delta=score(x)-score(y);
      if (Math.abs(delta)>1e-9) return delta;
    }
    // Evidence-based cost is a safe tiebreaker for complete rows.
    return compareKnownAscending(x.total,y.total) || a.originalIndex-b.originalIndex;
  });
  return decorated;
}

export function rankingExplanation(goal, assessment) {
  if(assessment.conflicts) return 'Not recommended until the timing conflict is resolved.';
  if(!assessment.complete) return 'Needs missing prices before it can compete as a complete option.';
  if(assessment.timingChecks) return 'A total is estimated, but connections still require a timing check.';
  if(goal==='lowest_cost') return 'Ordered by complete estimated cost, not partial subtotals.';
  if(goal==='more_time_at_preferred') return assessment.destinationHours===null ?
    'Time at the primary destination is not known; comparing estimated cost instead.' :
    'Prioritizes more time at your primary destination among complete estimates.';
  if(goal==='fastest') return 'Known flight duration is a partial measure; layovers, trains and transfers are not included.';
  if(goal==='balance') return 'Balances estimated cost and time at the primary destination where known.';
  return 'Complete itinerary estimate, still subject to booking verification.';
}
