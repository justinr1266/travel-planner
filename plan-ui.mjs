// Map a reviewed AI interpretation onto existing form values without inventing missing fields.
export function applyPlanToForm(plan, currentTrip, currentBag) {
  const trip = { ...currentTrip };
  const bag = { ...currentBag };
  const retained = [];
  for (const name of ['origin','destination']) {
    if (plan[name] !== null) trip[name] = plan[name];
    else retained.push(name);
  }
  // A country without a city must not leave a stale La Palma selection active.
  if (plan.preferred !== null) trip.preferred = plan.preferred;
  else if (plan.requested_regions.length) trip.preferred = '';
  else retained.push('preferred stop');
  trip.requestedRegion = plan.requested_regions[0] || '';
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
