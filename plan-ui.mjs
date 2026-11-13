// Map a reviewed AI interpretation onto existing form values without inventing missing fields.
export function applyPlanToForm(plan, currentTrip, currentBag) {
  const trip = { ...currentTrip };
  const bag = { ...currentBag };
  const retained = [];
  for (const name of ['origin','destination']) {
    if (plan[name] !== null) trip[name] = plan[name];
    else retained.push(name);
  }
  // Open-ended discovery must not accidentally retain a stale island preference.
  trip.destinationSearch = ['open','region','specified'].includes(plan.destination_search)
    ? plan.destination_search : 'specified';
  if (plan.preferred !== null) trip.preferred = plan.preferred;
  else trip.preferred = ''; // Never retain a prior trip's destination when AI cannot ground this one.
  trip.requestedRegion = plan.requested_regions[0] || '';
  // Default to destination time unless the user explicitly requested otherwise.
  if (plan.priority && plan.priority !== 'unspecified') trip.goal = plan.priority;
  else trip.goal = trip.goal || 'more_time_at_preferred';
  trip.arrivalRule = plan.fixed_arrival === true ? 'fixed' : 'by';
  if (plan.depart_earliest !== null) trip.startDate = plan.depart_earliest;
  else retained.push('departure date');
  if (plan.arrive_latest !== null) trip.endDate = plan.arrive_latest;
  else retained.push('arrival date');
  if (plan.bag_type && plan.bag_type !== 'unspecified') {
    bag.name = { overhead:'Overhead cabin bag', personal_item:'Personal item', checked:'Checked bag' }[plan.bag_type];
  }
  for (const [field,key] of [
    ['length','bag_length_cm'],['width','bag_width_cm'],['depth','bag_depth_cm'],['kg','bag_weight_kg']
  ]) {
    if (plan[key] !== null) bag[field] = plan[key];
  }
  return { trip, bag, retained };
}
