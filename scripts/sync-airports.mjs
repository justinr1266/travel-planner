// Produces a compact offline airport directory from public-domain OurAirports data.
// Run: npm run sync:airports   or   npm run sync:airports -- --file=/path/to/airports.csv
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const SOURCE='https://davidmegginson.github.io/ourairports-data/airports.csv';
function csvRows(text) {
  const rows=[];let row=[],field='',quoted=false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (c==='"') {if (quoted && text[i+1]==='"') {field+='"';i++;} else quoted=!quoted;}
    else if (c===',' && !quoted) {row.push(field);field='';}
    else if ((c==='\n'||c==='\r')&&!quoted) {
      if (c==='\r'&&text[i+1]==='\n') i++;
      row.push(field);if(row.length>1) rows.push(row);row=[];field='';
    } else field+=c;
  }
  if(field||row.length) {row.push(field);rows.push(row);}
  return rows;
}
export function buildCatalog(csv) {
  const [header,...rows]=csvRows(csv);
  const columns=Object.fromEntries(header.map((name,i)=>[name.trim(),i]));
  for(const needed of ['iata_code','municipality','name','iso_country','scheduled_service','type']) {
    if(!(needed in columns)) throw new Error(`Missing column ${needed} in airport CSV`);
  }
  const records=new Map();
  const types=new Set(['large_airport','medium_airport','small_airport']);
  for (const row of rows) {
    const get=key=>(row[columns[key]]??'').trim();
    const code=get('iata_code').toUpperCase(),city=get('municipality'),country=get('iso_country'),name=get('name');
    if(!/^[A-Z]{3}$/.test(code)||!city||!/^[A-Z]{2}$/.test(country)||!types.has(get('type'))||get('scheduled_service')!=='yes') continue;
    const label = name.length>90 ? name.slice(0,90) : name;
    const lat=Number(get('latitude_deg')),lon=Number(get('longitude_deg'));
    const record=[code,city,country,label,'airport',
      get('latitude_deg')!==''&&Number.isFinite(lat)&&Math.abs(lat)<=90?lat:null,
      get('longitude_deg')!==''&&Number.isFinite(lon)&&Math.abs(lon)<=180?lon:null];
    const old=records.get(code);
    if(!old || get('type')==='large_airport') records.set(code,record);
  }
  // Coordinates enable generic stop-to-airport matching for GTFS networks.
  // Metro location codes are not airport rows; retain existing Milan compatibility.
  records.set('MIL',['MIL','Milan','IT','Milan (all airports)','metro']);
  if(records.size<100) throw new Error('Too few airports: download may be truncated');
  return [...records.values()].sort((a,b)=>a[0].localeCompare(b[0]));
}
const runningDirect=process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1]);
if(runningDirect) {
  try {
    const local=process.argv.slice(2).find(x=>x.startsWith('--file='))?.slice(7);
    const data=local ? await fs.readFile(local,'utf8') : await (async()=>{
      const response=await fetch(SOURCE,{signal:AbortSignal.timeout(45000)});
      if(!response.ok) throw new Error(`OurAirports download failed: HTTP ${response.status}`);
      return response.text();
    })();
    const records=buildCatalog(data);
    const output=`// Generated from OurAirports public-domain airports.csv on ${new Date().toISOString().slice(0,10)}.\n`+
      `// Airport-directory entries are not proof of flight operations or prices.\n`+
      `export const AIRPORT_RECORDS = ${JSON.stringify(records)};\n`+
      `export const AIRPORT_CATALOG_META = ${JSON.stringify({source:'OurAirports',count:records.length,generatedAt:new Date().toISOString().slice(0,10)})};\n`;
    const target=fileURLToPath(new URL('../airport-catalog.mjs',import.meta.url));
    await fs.writeFile(target,output);
    console.log(`Wrote ${records.length} IATA airport entries to airport-catalog.mjs. Reload Chrome and restart your local server.`);
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
