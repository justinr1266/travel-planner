// Sequential, user-initiated research queue. No Google Flights or Groq calls
// occur here: the side panel supplies the existing single-flight importer.
export async function runFlightImportQueue(tasks, {
  isCached,
  importTask,
  onProgress = () => {},
  shouldStop = () => false,
  shouldSkip = () => false
} = {}) {
  if (!Array.isArray(tasks) || typeof isCached !== 'function' || typeof importTask !== 'function') {
    throw new TypeError('Expected tasks, isCached, and importTask.');
  }
  const seen = new Set();
  const pending = tasks.filter(task => {
    if (!task?.key || seen.has(task.key)) return false;
    seen.add(task.key);
    return !isCached(task);
  });
  const report = {total:pending.length, completed:0, imported:0, unavailable:0, skipped:0, failures:[], stopped:false};
  const publish = current => onProgress({
    total:report.total, completed:report.completed, imported:report.imported, unavailable:report.unavailable, skipped:report.skipped,
    failures:[...report.failures], stopped:report.stopped, current
  });
  let reusableTabId = null;
  publish(null);
  for (const task of pending) {
    if (shouldStop()) {report.stopped=true;break;}
    // A previous exact no-results search may have removed the only route using
    // this task. Skip the now-irrelevant request without opening another tab.
    if (shouldSkip(task)) {report.completed++;report.skipped++;publish(null);continue;}
    publish({task,number:report.completed+1});
    let outcome;
    try {
      outcome = await importTask(task,{reuseTabId:reusableTabId});
    } catch(error) {
      outcome={ok:false,error:String(error?.message || error)};
    }
    report.completed++;
    if (outcome?.ok) {
      if(outcome.unavailable)report.unavailable++;
      else report.imported++;
      if (Number.isInteger(outcome.tabId)) reusableTabId=outcome.tabId;
    } else {
      // Keep a failed Google Flights tab available for manual review; begin
      // a fresh tab for the next task instead of navigating it away.
      report.failures.push({task,error:String(outcome?.error || 'Import unavailable')});
      reusableTabId=null;
    }
    publish(null);
  }
  if (shouldStop() && report.completed < report.total) report.stopped=true;
  publish(null);
  return report;
}
