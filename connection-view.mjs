import {connectionWindows as calculateConnectionWindows} from './connection-windows.mjs';
// View-model for the connection timeline shown beside the onward flight.
// Contains no claims about verified flight schedules or airport transfer times.
export function connectionPanelData(window) {
  if (!window) return null;
  const labels={
    ground_time_needed:['Ground arrival needed','neutral','Enter or confirm the train/bus/ferry arrival time to calculate the onward-flight target.'],
    needs_flight_time:['Flight time needed','neutral','Enter a flight departure to check the buffer.'],
    meets_buffer:['Buffer met','good','Entered flight departure is at or after the planning target.'],
    below_buffer:['Below buffer','bad','Entered flight departure is earlier than the planning target.'],
    window_next_day:['Next-day flight needed','bad','The planning target falls after the proposed flight date.'],
    different_timezones:['Time zones differ','neutral','Confirm the departure airport time zone before comparing.'],
    unknown_timezone:['Ground time zone unknown','neutral','The published local times cannot be compared reliably.']
  };
  const [title,tone,detail]=labels[window.status]||labels.needs_flight_time;
  const buffer=window.bufferMinutes;
  return {
    title,tone,detail,
    arrival:window.groundArrivalLocal||'Not available',
    buffer:buffer%60===0?`${buffer/60} hours`:`${Math.floor(buffer/60)}h ${buffer%60}m`,
    target:window.earliestDepartureLocal||'Waiting for ground time',
    timezone:window.timezone,
    flightTime:window.flightLocal,
    departureTimezone:window.departureTimezone,
    groundKey:window.groundKey,
    groundMode:window.groundMode,
    groundTimeSource:window.groundTimeSource,
    flightKey:window.flightKey
  };
}

// Summary shown above route cards to explain when the buffer changes results.
export function connectionOverview(routes, offers={}, {bufferMinutes=180,flightTimes={},groundTimes={}}={}) {
  const windows=(Array.isArray(routes)?routes:[]).flatMap(route=>{
    // Read lazily to avoid importing the calculation core into view-model code.
    return calculateConnectionWindows(route,offers,{bufferMinutes,flightTimes,groundTimes});
  });
  const timeNeeded=windows.filter(w=>w.status==='ground_time_needed').length;
  const conflicts=windows.filter(w=>['below_buffer','window_next_day'].includes(w.status)).length;
  const buffer=`${bufferMinutes/60}h`;
  if(!windows.length)return `Connection buffer: ${buffer}. No ground → flight transfer in these routes, so it does not affect their ranking.`;
  return `Connection buffer: ${buffer} across ${windows.length} ground → flight connection${windows.length===1?'':'s'}. ${timeNeeded?`${timeNeeded} need a ground arrival time. `:''}${conflicts?`${conflicts} below the buffer. `:''}Enter times in the connection panels to check each one.`;
}
