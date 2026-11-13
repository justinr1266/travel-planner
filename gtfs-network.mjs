// GTFS route *patterns*, not date-specific itineraries, service guarantees or fares.
// Runs only in the local Node server / sync command, never inside Chrome.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import {LOCATION_RECORDS,fold} from './location-resolver.mjs';

const MAX_ZIP_BYTES=75*1024*1024, MAX_UNCOMPRESSED=140*1024*1024;
export const NETWORK_FILE=fileURLToPath(new URL('./data/transit-network.json',import.meta.url));
export const EMPTY_NETWORK={version:1,feeds:[],edges:[]};

// Parse RFC4180 CSV including quoted newlines, escaped quotes and UTF-8 names.
export function* csvRows(text){
  let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"') {if(quoted && text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(c===',' && !quoted){row.push(field);field='';}
    else if((c==='\n'||c==='\r') && !quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.length))yield row;row=[];field='';}
    else field+=c;
  }
  if(quoted)throw new Error('Unclosed quoted CSV field.');
  if(field.length||row.length){row.push(field);yield row;}
}
function* objects(text){
  const iter=csvRows(text)[Symbol.iterator](),first=iter.next();
  if(first.done)return;
  const headers=first.value.map(x=>x.trim().replace(/^\uFEFF/,''));
  for(let next=iter.next();!next.done;next=iter.next()){
    const row=next.value;yield Object.fromEntries(headers.map((key,i)=>[key,row[i]??'']));
  }
}

// Read named GTFS files from a ZIP using Node built-ins. Limit file sizes and
// never extract arbitrary archive paths onto the user's filesystem.
export function gtfsZipFiles(input){
  const zip=Buffer.isBuffer(input)?input:Buffer.from(input);
  if(zip.length>MAX_ZIP_BYTES)throw new Error('GTFS archive is too large.');
  let eocd=-1;
  for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--)if(zip.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  if(eocd<0)throw new Error('Invalid GTFS ZIP archive.');
  const total=zip.readUInt16LE(eocd+10),offset=zip.readUInt32LE(eocd+16);
  if(total>3000||offset>=zip.length)throw new Error('Unsupported GTFS ZIP directory.');
  const wanted=new Set(['stops.txt','routes.txt','trips.txt','stop_times.txt','calendar.txt','calendar_dates.txt','agency.txt']);
  const entries=new Map();let pos=offset;
  for(let n=0;n<total;n++){
    if(pos+46>zip.length||zip.readUInt32LE(pos)!==0x02014b50)throw new Error('Damaged GTFS ZIP directory.');
    const flags=zip.readUInt16LE(pos+8),method=zip.readUInt16LE(pos+10);
    const compressed=zip.readUInt32LE(pos+20),size=zip.readUInt32LE(pos+24);
    const nameLength=zip.readUInt16LE(pos+28),extra=zip.readUInt16LE(pos+30),comment=zip.readUInt16LE(pos+32);
    const localOffset=zip.readUInt32LE(pos+42);
    if(pos+46+nameLength+extra+comment>zip.length)throw new Error('Truncated GTFS ZIP directory entry.');
    const file=zip.subarray(pos+46,pos+46+nameLength).toString('utf8');
    pos+=46+nameLength+extra+comment;
    const basename=file.replace(/\\/g,'/').split('/').at(-1).toLowerCase();
    if(!wanted.has(basename)||entries.has(basename))continue;
    if(flags&1 || ![0,8].includes(method) || size>MAX_UNCOMPRESSED || compressed>MAX_ZIP_BYTES)
      throw new Error(`Unsupported or oversized GTFS file: ${basename}.`);
    if(localOffset+30>zip.length||zip.readUInt32LE(localOffset)!==0x04034b50)throw new Error('Bad ZIP entry offset.');
    const start=localOffset+30+zip.readUInt16LE(localOffset+26)+zip.readUInt16LE(localOffset+28);
    if(start+compressed>zip.length)throw new Error('Truncated GTFS ZIP entry.');
    const bytes=zip.subarray(start,start+compressed);
    const content=method===0?bytes:inflateRawSync(bytes,{maxOutputLength:MAX_UNCOMPRESSED});
    if(content.length!==size)throw new Error('GTFS ZIP size mismatch.');
    entries.set(basename,content.toString('utf8'));
  }
  for(const name of ['stops.txt','routes.txt','trips.txt','stop_times.txt'])
    if(!entries.has(name))throw new Error(`GTFS missing ${name}.`);
  return Object.fromEntries(entries);
}

export function modeForGtfsRoute(type){
  const n=Number(type);
  if(n===2||(n>=100&&n<200))return 'train';
  if(n===3||(n>=700&&n<800))return 'bus';
  if(n===4||(n>=1000&&n<1100))return 'ferry';
  return null;
}
function km(a,b){
  const r=Math.PI/180;const p=(Number(a.lat)-Number(b.lat))*r;
  const q=(Number(a.lon)-Number(b.lon))*r;
  const x=Math.sin(p/2)**2+Math.cos(Number(a.lat)*r)*Math.cos(Number(b.lat)*r)*Math.sin(q/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(x)));
}
function coordinate(value,min,max){const n=Number(value);return value!==''&&Number.isFinite(n)&&n>=min&&n<=max?n:null;}
export function buildGtfsNetwork(files,{source='Imported GTFS feed',sourceUrl='',attribution='',maxEdges=50000}={}){
  const byStop=new Map();
  for(const row of objects(files['stops.txt'])){
    if(!row.stop_id||!row.stop_name)continue;
    const lat=coordinate(row.stop_lat,-90,90),lon=coordinate(row.stop_lon,-180,180);
    if(lat===null||lon===null)continue;
    byStop.set(row.stop_id,{id:row.stop_id,name:row.stop_name,lat,lon});
  }
  const routes=new Map();
  for(const row of objects(files['routes.txt'])){
    const mode=modeForGtfsRoute(row.route_type);
    if(row.route_id&&mode)routes.set(row.route_id,mode);
  }
  const trips=new Map();
  for(const row of objects(files['trips.txt'])){
    const mode=routes.get(row.route_id);
    if(row.trip_id&&mode)trips.set(row.trip_id,{mode,serviceId:row.service_id});
  }
  const validServices=new Set();let minDate=null,maxDate=null;
  const calendar={};
  const validGtfsDate=value=>/^\d{8}$/.test(value||'') ? value : null;
  const weekdayNames=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for(const name of ['calendar.txt','calendar_dates.txt']){
    if(!files[name])continue;
    for(const row of objects(files[name])){
      if(!row.service_id)continue;
      if(name==='calendar.txt'){
        if(!['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].some(key=>row[key]==='1'))continue;
        validServices.add(row.service_id);
        calendar[row.service_id]={start:validGtfsDate(row.start_date),end:validGtfsDate(row.end_date),
          weekdays:weekdayNames.map(day=>row[day]==='1'),add:[],remove:[],hasBase:true};
      } else {
        if(!calendar[row.service_id])calendar[row.service_id]={start:null,end:null,weekdays:[],add:[],remove:[],hasBase:false};
        if(row.exception_type==='1'){validServices.add(row.service_id);if(validGtfsDate(row.date))calendar[row.service_id].add.push(row.date);}
        if(row.exception_type==='2' && validGtfsDate(row.date))calendar[row.service_id].remove.push(row.date);
      }
      const start=(name==='calendar.txt'?row.start_date:row.date)||'';
      const end=(name==='calendar.txt'?row.end_date:row.date)||'';
      if(/^\d{8}$/.test(start)&&(minDate===null||start<minDate))minDate=start;
      if(/^\d{8}$/.test(end)&&(maxDate===null||end>maxDate))maxDate=end;
    }
  }
  const hasCalendar=Boolean(files['calendar.txt']||files['calendar_dates.txt']);
  const tripStops=new Map();
  for(const row of objects(files['stop_times.txt'])){
    if(!trips.has(row.trip_id)||!byStop.has(row.stop_id))continue;
    if(hasCalendar&&!validServices.has(trips.get(row.trip_id).serviceId))continue;
    const seq=Number(row.stop_sequence);
    if(!Number.isFinite(seq))continue;
    let stops=tripStops.get(row.trip_id);
    if(!stops){stops=[];tripStops.set(row.trip_id,stops);}
    if(stops.length<160)stops.push({seq,id:row.stop_id,arrival:row.arrival_time,departure:row.departure_time});
  }
  const signatures=new Map();
  const sortedTrips=[...tripStops].sort((a,b)=>{
    const priority={train:0,ferry:1,bus:2};return priority[trips.get(a[0]).mode]-priority[trips.get(b[0]).mode];
  });
  const validTime=value=>/^\d{2,3}:[0-5]\d:[0-5]\d$/.test(value||'') && Number(value.split(':')[0])<=47;
  const SCHEDULE_CAP=32;
  for(const [tripId,sequence] of sortedTrips){
    const {mode,serviceId}=trips.get(tripId);
    sequence.sort((a,b)=>a.seq-b.seq);
    for(let i=0;i<sequence.length;i++){
      const from=byStop.get(sequence[i].id);
      for(let j=i+1;j<sequence.length;j++){
        const to=byStop.get(sequence[j].id);
        if(!to||!from||from.id===to.id)continue;
        const distance=km(from,to);
        if(distance<(mode==='ferry'?2:mode==='train'?25:12))continue;
        const signature=`${mode}|${from.id}|${to.id}`;
        let edge=signatures.get(signature);
        if(!edge){
          if(signatures.size>=maxEdges)continue;
          edge={mode,from,to,exampleTripId:tripId,schedules:[],sampleOverflow:false};
          signatures.set(signature,edge);
        }
        const departure=sequence[i].departure||sequence[i].arrival;
        const arrival=sequence[j].arrival||sequence[j].departure;
        if(!validTime(departure)||!validTime(arrival))continue;
        if(edge.schedules.length<SCHEDULE_CAP){
          const record={tripId,serviceId,departure,arrival};
          if(!edge.schedules.some(s=>s.serviceId===serviceId && s.departure===departure && s.arrival===arrival))edge.schedules.push(record);
        }else{
          edge.sampleOverflow=true;
          // Represent more service IDs when the feed has many journeys with
          // identical stop pairs, instead of only retaining the first operator/day.
          if(!edge.schedules.some(s=>s.serviceId===serviceId)){
            const index=edge.schedules.findIndex(s=>edge.schedules.filter(x=>x.serviceId===s.serviceId).length>1);
            if(index>=0)edge.schedules[index]={tripId,serviceId,departure,arrival};
          }
        }
      }
    }
  }
  const iso=x=>x?`${x.slice(0,4)}-${x.slice(4,6)}-${x.slice(6,8)}`:null;
  let timezone='';
  if(files['agency.txt']){for(const agency of objects(files['agency.txt'])){timezone=agency.agency_timezone||'';break;}}
  return {source:String(source).slice(0,100),sourceUrl:String(sourceUrl).slice(0,500),attribution:String(attribution).slice(0,250),
    validFrom:iso(minDate),validTo:iso(maxDate),stopCount:byStop.size,tripCount:tripStops.size,
    timezone,calendar,edges:[...signatures.values()]};
}

export async function loadTransitNetwork(filepath=NETWORK_FILE){
  try{
    const content=JSON.parse(await fs.readFile(filepath,'utf8'));
    if(content?.version!==1||!Array.isArray(content.edges)||!Array.isArray(content.feeds))throw new Error('Invalid transit network snapshot.');
    return content;
  }catch(error){if(error.code==='ENOENT')return EMPTY_NETWORK;throw error;}
}
export async function saveTransitNetwork(snapshot,filepath=NETWORK_FILE){
  await fs.mkdir(path.dirname(filepath),{recursive:true});
  await fs.writeFile(filepath,JSON.stringify(snapshot));
}

// Match verified GTFS stop coordinates to airports by distance. Fall back to a
// precise stop-name/city prefix when an older airport catalog lacks coordinates.
function nearestAirport(stop,records){
  const candidates=[];
  for(const record of records){
    if(record[4]==='metro')continue;
    if(Number.isFinite(record[5])&&Number.isFinite(record[6])){
      if(Math.abs(stop.lat-record[5])>.65||Math.abs(stop.lon-record[6])>.9)continue;
      const distance=km(stop,{lat:record[5],lon:record[6]});
      if(distance<=55)candidates.push({code:record[0],distance});
    }
  }
  if(candidates.length)return candidates.sort((a,b)=>a.distance-b.distance)[0].code;
  if(records.some(r=>Number.isFinite(r[5])&&Number.isFinite(r[6])))return null;
  const stopName=fold(stop.name);
  const aliases=records.filter(row=>row[4]!=='metro' && fold(row[1]).length>=4 &&
    (stopName.startsWith(fold(row[1])+' ')||stopName.includes(' '+fold(row[1])+' ')));
  return aliases.length===1?aliases[0][0]:null;
}

// GTFS schedule times are *feed-local* (agency timezone), not UTC or booked
// tickets. Returns "unknown" for old imports and sampled/truncated timetables.
function serviceActive(rule,day){
  if(!rule)return null;
  const key=day.replaceAll('-','');
  if(rule.remove?.includes(key))return false;
  if(rule.add?.includes(key))return true;
  if(!rule.hasBase)return false;
  if(!rule.start||!rule.end)return null;
  if(key<rule.start||key>rule.end)return false;
  const date=new Date(day+'T00:00:00Z');
  if(!Number.isFinite(date.valueOf()))return null;
  return Boolean(rule.weekdays?.[date.getUTCDay()]);
}
function shiftDate(day,delta){const date=new Date(day+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+delta);return date.toISOString().slice(0,10);}
function localDateTime(serviceDay,gtfsTime){
  const [h,m]=gtfsTime.split(':').map(Number);
  return `${shiftDate(serviceDay,Math.floor(h/24))} ${String(h%24).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
export function timetableForEdge(edge,feed,date){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'') || !edge?.schedules?.length || !feed?.calendar)
    return {status:'unknown',reason:'No complete imported timetable for this travel date'};
  const matches=[];let calendarUnknown=false;
  for(const entry of edge.schedules){
    const departureHour=Number(entry.departure?.split(':')[0]);
    const serviceDay=shiftDate(date,-Math.floor(departureHour/24));
    const active=serviceActive(feed.calendar[entry.serviceId],serviceDay);
    if(active===null){calendarUnknown=true;continue;}
    if(active){
      const departureLocal=localDateTime(serviceDay,entry.departure);
      const arrivalLocal=localDateTime(serviceDay,entry.arrival);
      if(departureLocal.slice(0,10)!==date)continue;
      if(arrivalLocal<departureLocal)continue;
      matches.push({departureLocal,arrivalLocal,tripId:entry.tripId,serviceId:entry.serviceId});
    }
  }
  if(matches.length){
    matches.sort((a,b)=>a.departureLocal.localeCompare(b.departureLocal));
    return {status:'scheduled',...matches[0],optionCount:matches.length,timezone:feed.timezone||'feed local time'};
  }
  return edge.sampleOverflow||calendarUnknown ?
    {status:'unknown',reason:'Timetable sample incomplete or calendar unknown'} :
    {status:'not_scheduled',reason:'No matching scheduled GTFS trip on this date in the imported feed'};
}

export function discoverGroundEdges(snapshot,{origin,preferred,final,flightLegs=[],records=LOCATION_RECORDS,max=18,date=null}={}){
  if(!snapshot?.edges?.length)return [];
  const required=new Set([origin,preferred,final].filter(Boolean));
  for(const leg of flightLegs){required.add(leg.from);required.add(leg.to);}
  const stopCodes=new Map();
  const airportFor=stop=>{
    if(!stopCodes.has(stop.id))stopCodes.set(stop.id,nearestAirport(stop,records));
    return stopCodes.get(stop.id);
  };
  const candidates=[];const seen=new Set();
  for(const edge of snapshot.edges){
    if(!['train','bus','ferry'].includes(edge.mode))continue;
    const fromAirport=airportFor(edge.from),toAirport=airportFor(edge.to);
    if(!fromAirport||!toAirport||fromAirport===toAirport||!required.has(fromAirport))continue;
    // Allow any outbound city reachable from the starting city, or a known
    // existing flight leg: don't invent service to a country from a name alone.
    if(!required.has(toAirport)&&fromAirport!==origin)continue;
    const signature=`${edge.mode}|${fromAirport}|${toAirport}`;
    if(seen.has(signature))continue;
    seen.add(signature);
    const feed=snapshot.feeds?.find(f=>f.id===edge.feedId)||{};
    const timetable=timetableForEdge(edge,feed,date);
    if(timetable.status==='not_scheduled')continue;
    candidates.push({mode:edge.mode,fromAirport,toAirport,
      fromStop:{...edge.from},toStop:{...edge.to},feedId:edge.feedId,source:feed.source||'GTFS feed',
      attribution:feed.attribution||'',sourceUrl:feed.sourceUrl||'',validFrom:feed.validFrom||null,validTo:feed.validTo||null,
      evidence:timetable.status==='scheduled'?'gtfs_scheduled':'gtfs_trip_pattern',dateVerified:timetable.status==='scheduled',timetable});
    // Scan the complete imported snapshot before choosing the best edges.
    // Stopping early biased results toward the first GTFS trip/station rows.
  }
  // Prefer a verified ground segment that replaces a proposed flight,
  // especially when an existing candidate already visits its arrival city.
  candidates.sort((a,b)=>(Number(b.dateVerified)-Number(a.dateVerified)) ||
    (Number(b.toAirport===final)-Number(a.toAirport===final)) ||
    (Number(required.has(b.toAirport))-Number(required.has(a.toAirport))) ||
    (Number(b.mode==='train')-Number(a.mode==='train')) ||
    a.fromStop.name.localeCompare(b.fromStop.name));
  return candidates.slice(0,max);
}
