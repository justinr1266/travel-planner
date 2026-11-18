// Small, testable coordinator for the traveler-facing Find my best routes action.
// It calls existing route generation and flight research; no network requests are made here.
export async function runBestRouteWorkflow({generateRoutes,getSearchCounts,importFlights,onStage=()=>{}}={}) {
  if(typeof generateRoutes!=='function'||typeof getSearchCounts!=='function'||typeof importFlights!=='function')
    throw new TypeError('Route generation, search counts and import callback are required.');
  onStage({phase:'generating'});
  if(!(await generateRoutes()))return {status:'generation-failed',report:null};
  const counts=getSearchCounts();
  if(!counts || !Number.isInteger(counts.all) || !Number.isInteger(counts.pending))
    throw new TypeError('Search counts must be integers.');
  if(counts.all===0)return {status:'no-flights',report:null};
  if(counts.pending===0)return {status:'cached',report:null};
  onStage({phase:'researching',counts});
  const report=await importFlights();
  if(!report)return {status:'research-failed',report:null};
  if(report.stopped)return {status:'stopped',report};
  if(report.failures?.length)return {status:'needs-review',report};
  return {status:'complete',report};
}
