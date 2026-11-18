// Read only visible journey-card details on a user-opened rail-search page.
// No booking, payment, account access, or remote API calls.
(() => {
  const allowed=new Set(['omio.com','www.omio.com','thetrainline.com','www.thetrainline.com']);
  if(!allowed.has(location.hostname))return;
  function visible(element){return Boolean(element && element.getClientRects().length);}
  function text(element){return String(element?.innerText||element?.textContent||'').trim().replace(/\s+/g,' ');}
  function field(card,name){return text(card.querySelector(`[data-e2e="${name}"]`));}
  function readOmioCards(){
    if(!['omio.com','www.omio.com'].includes(location.hostname))return null;
    const elements=[...document.querySelectorAll('[data-e2e="resultCellWrapper"]')].filter(visible);
    if(!elements.length)return null;
    const journeys=[];
    for(const element of elements){
      if(journeys.length>=80)break;
      const priceText=field(element,'price');
      if(!/(€|\bEUR\b)/i.test(priceText))continue;
      const fromStation=field(element,'departurePosition');
      const toStation=field(element,'arrivalPosition');
      const departureText=field(element,'departureTime');
      const arrivalText=field(element,'arrivalTime');
      if(!fromStation||!toStation||!departureText||!arrivalText)continue;
      const providerElement=element.querySelector('img[data-e2e="provider"]');
      const provider=String(providerElement?.getAttribute('alt')||'').trim().slice(0,100);
      journeys.push({
        fromStation:fromStation.slice(0,160),toStation:toStation.slice(0,160),
        departureText:departureText.slice(0,40),arrivalText:arrivalText.slice(0,40),
        priceText:priceText.slice(0,60),provider,
        durationText:field(element,'duration').slice(0,60),
        changesText:field(element,'numberOfChanges').slice(0,80)
      });
    }
    return {journeys,cards:[],cardSource:'omio_result_cards'};
  }
  function readFallbackCards(){
    const selectors=['[data-testid*="journey"]','[data-testid*="Journey"]','[data-testid*="trip"]',
      '[data-test*="journey"]','[class*="JourneyCard"]','[class*="journey-card"]','article','[role="listitem"]'];
    const collected=[],seen=new Set();
    for(const element of document.querySelectorAll(selectors.join(','))){
      if(!visible(element))continue;
      const snippet=String(element.innerText||'').trim().slice(0,1700);
      if(snippet.length<5||snippet.length>1650||!/(€|\bEUR\b)/i.test(snippet))continue;
      if(seen.has(snippet))continue;
      seen.add(snippet);collected.push(snippet);
      if(collected.length===55)break;
    }
    if(collected.length)return {cards:collected,cardSource:'journey_elements'};
    // Unstructured fallback is for manual review only; never auto-cache prices.
    const lines=String(document.body?.innerText||'').split('\n').map(x=>x.trim()).filter(Boolean);
    for(let i=0;i<lines.length&&collected.length<40;i++){
      if(!/(€|\bEUR\b)/i.test(lines[i]))continue;
      const snippet=lines.slice(Math.max(0,i-4),Math.min(lines.length,i+4)).join(' · ').slice(0,400);
      if(!seen.has(snippet)){seen.add(snippet);collected.push(snippet);}
    }
    return {cards:collected,cardSource:'text_fallback'};
  }
  chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
    if(message?.type!=='routewise:capture-train-results')return;
    sendResponse({ok:true,sourceUrl:location.href,title:document.title,
      ...(readOmioCards()||readFallbackCards()),capturedAt:new Date().toISOString()});
  });
})();
