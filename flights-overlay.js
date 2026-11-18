// RouteWise Google Flights review overlay, v0.4.7.
// Reads only result cards rendered on the page after a user click. No requests,
// no background browsing, no Google account/cookie access, no automatic saving.
(() => {
  'use strict';
  const MAX_CARDS = 60;
  const MAX_CAPTURE = 245000;
  const CAPTURE_MESSAGE = 'routewise:show-flight-overlay';
  const AUTO_CAPTURE_MESSAGE = 'routewise:auto-import-flight-search';

  function escapeAttribute(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    }[char]));
  }
  function iataEndpoints(card) {
    const codes = [];
    for (const node of card.querySelectorAll('div,span')) {
      if (node.children?.length) continue;
      const value = (node.textContent || '').trim();
      // Some Google Flights layouts render "SPC–MAD" as one element;
      // prefer the pair over a stopover code from emissions metadata.
      const pair = value.match(/^([A-Z]{3})\s*[–—-]\s*([A-Z]{3})$/);
      if (pair) return [pair[1],pair[2]];
      if (/^[A-Z]{3}$/.test(value)) codes.push(value);
    }
    return codes.length >= 2 ? codes.slice(0,2) : ['', ''];
  }
  function cardLabels(card) {
    const labels=[];
    const mainLink=card.querySelector?.('[role="link"][aria-label]');
    if(mainLink?.getAttribute?.('aria-label'))labels.push(mainLink.getAttribute('aria-label'));
    for(const node of card.querySelectorAll('[aria-label]')) {
      const label=node.getAttribute('aria-label')||'';
      if(label)labels.push(label);
      if(labels.length>=120)break;
    }
    return labels;
  }
  function cardPrice(card,label) {
    const summary=label.match(/\b(?:From\s+)?([\d,]+)\s+euros?\b/i);
    if(summary)return Number(summary[1].replaceAll(',',''));
    for(const node of card.querySelectorAll('span,div')) {
      if(node.children?.length)continue;
      const raw=(node.textContent||'').trim();
      const price=raw.match(/^€\s*([\d,]+)$/);
      if(price)return Number(price[1].replaceAll(',',''));
      const aria=node.getAttribute?.('aria-label')||'';
      const spoken=aria.match(/^([\d,]+)\s+euros?$/i);
      if(spoken)return Number(spoken[1].replaceAll(',',''));
    }
    return null;
  }
  function cardRecord(card) {
    if(!card?.querySelectorAll)return null;
    const labels=cardLabels(card);
    const label=labels.find(item=>/\bLeaves\b.+\band arrives at\b/i.test(item))||'';
    const travel=[...card.querySelectorAll('[data-travelimpactmodelwebsiteurl]')]
      .map(node=>node.getAttribute('data-travelimpactmodelwebsiteurl')||'')
      .find(value=>/\bitinerary=/.test(value))||'';
    const [visibleFrom,visibleTo]=iataEndpoints(card);
    const route=travel.match(/\bitinerary=([A-Z]{3})-([A-Z]{3})-/i);
    const from=visibleFrom||route?.[1]?.toUpperCase()||'';
    // An emissions itinerary may only describe the first segment (SPC–LPA)
    // of a connecting journey (SPC–MAD). Visible end-to-end airports win.
    const to=visibleTo||route?.[2]?.toUpperCase()||'';
    if(!/^[A-Z]{3}$/.test(from)||!/^[A-Z]{3}$/.test(to)||from===to)return null;
    const dateFromTravel=travel.match(/-(20\d{6})(?:[,&]|$)/);
    const rawDate=dateFromTravel?.[1]||'';
    const dateISO=rawDate?`${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6)}`:'';
    const dateLabel=label.match(/\bLeaves\b.+?\bon\s+((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Za-z]+\s+\d{1,2})/i)?.[1]||
      [...card.querySelectorAll('span,div')].filter(node=>!node.children?.length)
        .map(node=>(node.textContent||'').trim())
        .find(value=>/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),?\s+[A-Za-z]{3}\s+\d{1,2}$/.test(value))||'';
    const depart=label.match(/\bLeaves\s+.+?\s+at\s+(\d{1,2}:[0-5]\d\s*[AP]M)\s+on\s+/i)?.[1]||
      labels.find(item=>/^Departure time:/i.test(item))?.match(/(\d{1,2}:[0-5]\d\s*[AP]M)/i)?.[1]||'';
    const arrive=label.match(/\band arrives at\s+.+?\s+at\s+(\d{1,2}:[0-5]\d\s*[AP]M)\s+on\s+/i)?.[1]||
      labels.find(item=>/^Arrival time:/i.test(item))?.match(/(\d{1,2}:[0-5]\d\s*[AP]M)/i)?.[1]||'';
    if(!depart||!arrive||!dateISO&&!dateLabel)return null;
    const airlineLabel=label.match(/\b(?:Nonstop|\d+\s+stops?)\s+flight with\s+(.+?)\.\s+(?:Operated by\s+.+?\.\s+)?Leaves\b/i);
    const carrier=airlineLabel?.[1]||card.querySelector('.Ir0Voe .sSHqwe')?.textContent?.trim()||
      card.querySelector('.h1fkLb')?.textContent?.trim()||'';
    const operating=label.match(/Operated by\s+(.+?)\.\s+Leaves\b/i)?.[1]||'';
    const stopsLabel=label.match(/\bNonstop flight\b/i) ? 0 :
      Number(label.match(/\b(\d+)\s+stops?\s+flight\b/i)?.[1]);
    const text=(card.textContent||'').slice(0,5000);
    const nonstop=labels.some(item=>/\bNonstop flight\b/i.test(item))||/\bNonstop\b/i.test(text);
    const stopText=text.match(/\b(\d+)\s+stops?\b/i);
    const stops=Number.isInteger(stopsLabel)&&stopsLabel>=0&&stopsLabel<=10&&label?stopsLabel:
      nonstop?0:stopText?Number(stopText[1]):null;
    if(stops===null||stops>10||!carrier)return null;
    const price=cardPrice(card,label);
    const priceContext=label+' '+[...card.querySelectorAll('span,div')]
      .filter(node=>!node.children?.length).map(node=>(node.textContent||'').trim())
      .filter(value=>/^(?:round trip|one way)$/i.test(value)).join(' ');
    const priceScope=/\bround trip\b/i.test(priceContext)?'round_trip_search_quote':
      /\bone way\b/i.test(priceContext)?'one_way_search_quote':'displayed_search_quote';
    const normalizedTime=value=>{
      const m=value.match(/^(\d{1,2}):([0-5]\d)\s*([AP]M)$/i);
      if(!m||+m[1]<1||+m[1]>12)return '';
      return `${String((+m[1]%12)+(m[3].toUpperCase()==='PM'?12:0)).padStart(2,'0')}:${m[2]}`;
    };
    const duration=label.match(/Total duration\s+(.+?)\./i)?.[1]||'';
    const departureClock=normalizedTime(depart),arrivalClock=normalizedTime(arrive);
    if(!departureClock||!arrivalClock)return null;
    const arrivalLabel=label.match(/\band arrives at\s+.+?\s+at\s+.+?\bon\s+((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Za-z]+\s+\d{1,2})/i)?.[1]||'';
    const dayPart=value=>value.match(/([A-Za-z]+)\s+(\d{1,2})$/)?.slice(1).join('-').toLowerCase()||'';
    const arrivalDayOffset=arrivalLabel&&dateLabel&&dayPart(arrivalLabel)!==dayPart(dateLabel)?1:0;
    // A normalized, intentionally small snapshot avoids transporting Google
    // page HTML, classes, cookies or account data into the extension.
    const snapshot=`<li data-routewise-from="${from}" data-routewise-to="${to}"`+
      (dateISO?` data-routewise-date="${dateISO}"`:'')+
      (dateLabel?` data-routewise-date-label="${escapeAttribute(dateLabel)}"`:'')+
      ` data-routewise-departure="${departureClock}" data-routewise-arrival="${arrivalClock}"`+
      ` data-routewise-arrival-offset="${arrivalDayOffset}"`+
      ` data-routewise-carrier="${escapeAttribute(carrier)}" data-routewise-operator="${escapeAttribute(operating)}"`+
      ` data-routewise-stops="${stops}" data-routewise-duration="${escapeAttribute(duration)}"`+
      (price!==null?` data-routewise-price="${price}"`:'')+
      ` data-routewise-price-scope="${priceScope}">`+
      (label?`<div role="link" aria-label="${escapeAttribute(label)}"></div>`:'')+
      '</li>';
    return {card,from,to,dateISO,dateLabel,price,priceScope,carrier,depart,arrive,stops:stops===0?'Nonstop':`${stops} stop(s)`,snapshot};
  }
  function collectCards(root) {
    const found=[],seen=new Set();
    const candidates=[...root.querySelectorAll('li')];
    // Support the older test harness and any Google layout that exposes a
    // labeled result link without the same list-item CSS class.
    for(const link of root.querySelectorAll('[role="link"][aria-label]')){
      const card=link.closest('li');
      if(card)candidates.push(card);
    }
    for(const card of candidates){
      if(seen.has(card))continue;
      seen.add(card);
      if(typeof card.getClientRects==='function'&&card.getClientRects().length===0)continue;
      const record=cardRecord(card);
      if(record)found.push(record);
      if(found.length>=MAX_CARDS)break;
    }
    return found;
  }
  // Google Flights may render nearby-airport suggestions when the exact search
  // has NO options. This is a definitive *search result*, not an import timeout.
  // Look only in the active results region, never in sidebar suggestions.
  function explicitNoMatchingFlights(root) {
    const main = root?.querySelector?.('[role="main"]') || root?.querySelector?.('main');
    if (!main || typeof main.querySelectorAll !== 'function') return false;
    const heading = [...main.querySelectorAll('h3')].some(node =>
      /^No options matching your search\.?$/i.test(String(node.textContent||'').trim()));
    if (!heading) return false;
    const announcement = [...main.querySelectorAll('[aria-live]')].some(node =>
      /^No results returned, alternative suggestions found\.?$/i.test(String(node.textContent||'').trim()));
    const help = /Try changing your dates or destination to see results/i.test(main.textContent||'');
    return announcement || help;
  }

  function capturePayload(records, sourceUrl, now=new Date().toISOString()) {
    const accepted = [];
    let totalLength = 0;
    for (const record of records) {
      if (!record?.snapshot || record.snapshot.length + totalLength > MAX_CAPTURE) break;
      accepted.push(record);
      totalLength += record.snapshot.length + 1;
    }
    if (!accepted.length) throw new Error('No supported Google Flights cards found.');
    return {
      text:accepted.map(record=>record.snapshot).join('\n'),
      sourceUrl,
      capturedAt:now,
      captureMode:accepted.length===1?'card':'page',
      captureCount:accepted.length
    };
  }

  // A matching source URL is necessary before using unlabelled search prices.
  // No page content, cookies, or query strings are sent to an external service.
  function sameOpenedSearch(actualUrl, expectedUrl) {
    try {
      const actual = new URL(actualUrl);
      const expected = new URL(expectedUrl);
      const tfs = expected.searchParams.get('tfs');
      return actual.origin === 'https://www.google.com' &&
        expected.origin === 'https://www.google.com' &&
        actual.pathname === '/travel/flights/search' &&
        actual.pathname === expected.pathname &&
        Boolean(tfs) && actual.searchParams.get('tfs') === tfs &&
        actual.searchParams.get('curr') === 'EUR' &&
        expected.searchParams.get('curr') === 'EUR';
    } catch { return false; }
  }
  // Test the exact DOM-adapter code in Node without downloading Google Flights.
  if (typeof module !== 'undefined' && module?.exports) {
    Object.assign(module.exports,{cardRecord,collectCards,capturePayload,escapeAttribute,sameOpenedSearch,explicitNoMatchingFlights});
  }
  if (typeof document === 'undefined' || typeof chrome === 'undefined' ||
    !/^\/travel\/flights(?:\/|$)/.test(location.pathname)) return;

  let host, shadow, launch, panel, cards = [], markers = [], message;
  let open = false, refreshQueued = false;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  function notify(text) {message.textContent = text;}
  function removeMarkers() {markers.forEach(item=>item.node.remove());markers=[];}
  function positionMarkers() {
    refreshQueued = false;
    if (!open) return;
    for (const {node,record} of markers) {
      const rect = record.card.getBoundingClientRect();
      const onScreen = rect.height > 30 && rect.width > 80 && rect.bottom > 0 && rect.top < window.innerHeight;
      node.hidden = !onScreen;
      if (!onScreen) continue;
      node.style.top = `${Math.max(3,rect.top+4)}px`;
      node.style.left = `${Math.max(3,Math.min(window.innerWidth-100,rect.right-108))}px`;
    }
  }
  function queuePositionMarkers() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(positionMarkers);
  }
  async function sendCards(records) {
    try {
      const payload = capturePayload(records,location.href);
      await chrome.storage.local.set({pendingFlightCapture:payload});
      notify(`${payload.captureCount} flight ${payload.captureCount===1?'card':'cards'} sent to RouteWise. A labeled round-trip quote can prefill an open shared-ticket editor; otherwise choose Import flight on the matching leg to review it. No price has been saved.`);
    } catch (error) { notify(`Could not import: ${error.message}`); }
  }
  function refresh() {
    cards=collectCards(document);
    removeMarkers();
    panel.replaceChildren();
    const header=el('div','rw-heading');
    header.append(el('strong','',`RouteWise · ${cards.length} flight ${cards.length===1?'option':'options'}`));
    const close=el('button','rw-close','×');close.type='button';close.setAttribute('aria-label','Close RouteWise flight overlay');
    close.addEventListener('click',()=>toggle(false));header.append(close);panel.append(header);
    const intro=el('p','rw-explain','Choose one card, or send all loaded search results to RouteWise for review. No flights or fares are saved automatically.');
    panel.append(intro);
    const actions=el('div','rw-actions');
    const all=el('button','rw-primary',`Import all ${cards.length} cards`);all.type='button';all.disabled=!cards.length;
    all.addEventListener('click',()=>sendCards(cards));
    const refreshButton=el('button','rw-secondary','Refresh');refreshButton.type='button';refreshButton.addEventListener('click',refresh);
    actions.append(all,refreshButton);panel.append(actions);
    const list=el('div','rw-list');
    if (!cards.length) list.append(el('p','rw-empty','No supported flight cards found. Open a Google Flights results page, wait for results to load, and click Refresh. If the results are visible but the count stays at zero, please share the HTML for one card.'));
    cards.forEach((record,index)=>{
      const row=el('div','rw-card');
      const info=el('div','rw-card-info');
      info.append(el('strong','',`${record.depart || '?'} → ${record.arrive || '?'} · ${record.from}–${record.to}`));
      info.append(el('span','',`${record.carrier || 'Airline unlisted'} · ${record.stops}${record.dateISO?` · ${record.dateISO}`:''}`));
      info.append(el('span','rw-quote',record.price===null?'Price unknown':`€${record.price} ${record.priceScope==='round_trip_search_quote'?'round-trip search quote':record.priceScope==='one_way_search_quote'?'one-way search quote':'displayed search price (scope unverified)'}`));
      const button=el('button','rw-card-action','Import');button.type='button';
      button.setAttribute('aria-label',`Import flight card ${index+1} ${record.carrier}`);
      button.addEventListener('click',()=>sendCards([record]));
      row.append(info,button);list.append(row);
      const marker=el('button','rw-marker','↗ Import');marker.type='button';
      marker.setAttribute('aria-label',`Import ${record.carrier} flight at ${record.depart}`);
      marker.addEventListener('click',()=>sendCards([record]));
      shadow.append(marker);markers.push({node:marker,record});
    });
    panel.append(list);
    message=el('p','rw-status');message.setAttribute('role','status');panel.append(message);
    queuePositionMarkers();
  }
  function toggle(value=!open) {
    open=Boolean(value);
    panel.hidden=!open;
    launch.textContent=open?'RouteWise · Hide':'RouteWise · Import flights';
    if(open)refresh();else removeMarkers();
  }
  function mount() {
    if(host)return;
    host=el('div');host.id='routewise-flights-overlay';
    // A full-screen transparent shadow host makes per-card buttons clickable
    // without nesting them inside Google Flights' click handlers.
    host.style.cssText='position:fixed;inset:0;z-index:2147483600;pointer-events:none;';
    shadow=host.attachShadow({mode:'closed'});
    const style=el('style');style.textContent=`
      *,*::before,*::after{box-sizing:border-box}button{cursor:pointer;font-family:system-ui,-apple-system,sans-serif}
      button:focus-visible{outline:3px solid #92c5ff;outline-offset:2px}
      .rw-launch{position:absolute;bottom:18px;right:18px;background:#153b70;color:white;border:1px solid #b5d5ff;border-radius:28px;padding:11px 15px;font:700 13px system-ui;box-shadow:0 4px 22px #0003;pointer-events:auto}
      .rw-panel{position:absolute;right:15px;bottom:74px;width:min(370px,calc(100vw - 30px));max-height:min(68vh,660px);overflow-y:auto;background:#fff;color:#1c2e46;border:1px solid #c5d2e1;border-radius:13px;box-shadow:0 10px 35px #0004;padding:13px;pointer-events:auto;font:12px/1.5 system-ui,-apple-system,sans-serif}
      .rw-panel[hidden],.rw-marker[hidden]{display:none!important}
      .rw-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:14px}
      .rw-close{border:0;background:#eef3fa;color:#1c2e46;border-radius:7px;font-size:22px;min-width:32px;min-height:30px}
      .rw-explain{font-size:12px;margin:7px 0 10px;color:#4f637c}
      .rw-actions{display:flex;gap:7px;margin-bottom:10px;flex-wrap:wrap}
      .rw-actions button,.rw-card-action{border:1px solid #a6bacf;border-radius:7px;padding:7px 9px;font-size:12px;font-weight:650}
      .rw-primary{background:#1553a0;color:#fff}.rw-primary:disabled{opacity:.45;cursor:not-allowed}
      .rw-secondary,.rw-card-action{color:#15457f;background:#f5f9ff}
      .rw-list{display:grid;gap:6px;max-height:34vh;overflow:auto}
      .rw-card{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}
      .rw-card-info{display:grid;gap:2px;min-width:0}.rw-card-info span{color:#4c5b72}.rw-card-info .rw-quote{color:#193e6f;font-weight:700}
      .rw-card-action{white-space:nowrap}.rw-status{margin:10px 0 0;color:#125d42;font-size:11px}
      .rw-empty{color:#58667a}.rw-marker{position:absolute;min-width:99px;max-width:105px;white-space:nowrap;background:#184e8c;color:#fff;border:2px solid #fff;border-radius:14px;padding:5px 6px;font:700 11px system-ui;box-shadow:0 1px 7px #0005;pointer-events:auto}
    `;
    shadow.append(style);
    launch=el('button','rw-launch','RouteWise · Import flights');launch.type='button';
    launch.setAttribute('aria-label','Open RouteWise Google Flights import overlay');
    launch.addEventListener('click',()=>toggle());
    panel=el('section','rw-panel');panel.setAttribute('aria-label','RouteWise flight import options');panel.hidden=true;
    shadow.append(launch,panel);
    document.documentElement.append(host);
    window.addEventListener('scroll',queuePositionMarkers,true);
    window.addEventListener('resize',queuePositionMarkers);
  }
  // User-initiated only. Wait for Google's client-rendered cards to stop changing;
  // preserve the manual import overlay when this times out or markup changes.
  let autoCaptureInFlight = null;
  async function autoImportLoadedCards(expectedUrl) {
    if (!sameOpenedSearch(location.href, expectedUrl)) {
      return {ok:false,retry:true,error:'Google Flights has not opened the expected one-way search yet.'};
    }
    const deadline = Date.now() + 30000;
    let lastSignature = '';
    let stablePasses = 0;
    let noResultsPasses = 0;
    while (Date.now() < deadline) {
      if (!sameOpenedSearch(location.href, expectedUrl)) {
        return {ok:false,error:'Search URL changed. Use the manual overlay to review results.'};
      }
      const found = collectCards(document);
      // Confirm the explicit no-options page persists across three polls.
      // Nearby-airport suggestion prices are NEVER treated as matching fares.
      noResultsPasses = !found.length && explicitNoMatchingFlights(document)
        ? noResultsPasses + 1 : 0;
      if (noResultsPasses >= 3) {
        return {ok:true,unavailable:true,evidence:'explicit_no_matching_options',sourceUrl:location.href};
      }
      const signature = found.map(record => record.snapshot).join('\n');
      const hasPricedFlight = found.some(record => Number.isFinite(record.price));
      stablePasses = hasPricedFlight && signature === lastSignature ? stablePasses + 1 : 0;
      if (stablePasses >= 3) {
        const payload = capturePayload(found, location.href);
        await chrome.storage.local.set({pendingFlightCapture: payload});
        return {ok:true,count:payload.captureCount};
      }
      lastSignature = signature;
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    return {ok:false,error:'No stable priced flight cards appeared within 30 seconds. Use the manual overlay.'};
  }
  chrome.runtime.onMessage.addListener((message,_,sendResponse)=>{
    if (message?.type === AUTO_CAPTURE_MESSAGE) {
      if (!autoCaptureInFlight) {
        autoCaptureInFlight = autoImportLoadedCards(message.expectedUrl)
          .finally(() => {autoCaptureInFlight = null;});
      }
      autoCaptureInFlight.then(sendResponse,error =>
        sendResponse({ok:false,error:String(error?.message || error)}));
      return true;
    }
    if (message?.type !== CAPTURE_MESSAGE) return;
    mount();toggle(true);sendResponse({ok:true,count:cards.length});
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});
  else mount();
})();
