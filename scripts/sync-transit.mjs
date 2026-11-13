// Import a GTFS static ZIP. Extracts undated stop-to-stop trip patterns only.
// No date-specific schedules, fares, live services or ticket availability.
// Examples:
// npm run sync:transit -- --url=https://gtfs-source-feeds.transit.land/es-nap-1098.zip --label=Renfe --attribution="Powered by MITRAMS"
// npm run sync:transit -- --file=/path/to/feed.zip --label=LocalOperator
import fs from 'node:fs/promises';
import {gtfsZipFiles,buildGtfsNetwork,loadTransitNetwork,saveTransitNetwork} from '../gtfs-network.mjs';

function option(name){return process.argv.slice(2).find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3)||'';}
async function main(){
  const file=option('file'),url=option('url'),label=option('label')||'Imported GTFS feed';
  if(Boolean(file)===Boolean(url))throw new Error('Provide exactly one of --file=path.zip or --url=https://...zip');
  let data;
  if(file){
    const info=await fs.stat(file);
    if(info.size>75*1024*1024)throw new Error('GTFS ZIP exceeds 75 MB limit.');
    data=await fs.readFile(file);
  }else{
    const target=new URL(url);
    if(target.protocol!=='https:')throw new Error('GTFS URL must use HTTPS.');
    const response=await fetch(target,{signal:AbortSignal.timeout(50000)});
    if(!response.ok)throw new Error(`GTFS feed download failed (HTTP ${response.status}).`);
    const size=Number(response.headers.get('content-length')||0);
    if(size>75*1024*1024)throw new Error('GTFS download exceeds 75 MB.');
    const chunks=[];let received=0;
    for await(const chunk of response.body){received+=chunk.length;if(received>75*1024*1024)throw new Error('GTFS download exceeds 75 MB.');chunks.push(Buffer.from(chunk));}
    data=Buffer.concat(chunks);
  }
  const built=buildGtfsNetwork(gtfsZipFiles(data),{source:label,sourceUrl:url,attribution:option('attribution')});
  if(built.edges.length===0)throw new Error('GTFS feed contained no eligible intercity rail, bus, or ferry trip patterns.');
  const output=option('output')||undefined;
  const snapshot=await loadTransitNetwork(output);
  const id=option('id')||label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g,'-').slice(0,50);
  if(!id||!/^[a-z0-9-]{1,50}$/.test(id))throw new Error('Supply a safe --id=identifier.');
  const feeds=snapshot.feeds.filter(x=>x.id!==id);
  feeds.push({id,source:built.source,sourceUrl:built.sourceUrl,attribution:built.attribution,
    validFrom:built.validFrom,validTo:built.validTo,timezone:built.timezone,calendar:built.calendar,
    stopCount:built.stopCount,tripCount:built.tripCount,
    importedAt:new Date().toISOString().slice(0,10)});
  const edges=snapshot.edges.filter(x=>x.feedId!==id);
  edges.push(...built.edges.map(edge=>({...edge,feedId:id})));
  await saveTransitNetwork({version:1,feeds,edges},output);
  console.log(`Imported ${label}: ${built.edges.length} directed trip patterns, ${built.stopCount} stops, ${built.tripCount} trips.`);
  console.log(`Feed coverage reported: ${built.validFrom||'unknown'} to ${built.validTo||'unknown'}. GTFS timetable dates imported; onward connections remain unverified.`);
  console.log('Schedule samples and operating calendars stored. Individual journeys must still be checked with the operator.');
  console.log('Restart npm run server. Resync airports to enable coordinate-based station matching.');
}
main().catch(error=>{console.error(`Could not import GTFS: ${error.message}`);process.exitCode=1;});
