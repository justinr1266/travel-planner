// Clicking the toolbar action opens RouteWise beside the active browser tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('RouteWise side panel:', error));

// A right-click on *highlighted text* is the only page-capture mechanism.
// No host access, background crawling, or DOM extraction is performed.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:'routewise-selected-flight',
    title:'Send selected flight details to RouteWise',
    contexts:['selection']
  });
  chrome.contextMenus.create({
    id:'routewise-developer-console',
    title:'Open RouteWise Developer Console',
    contexts:['action']
  });
});
chrome.contextMenus.onClicked.addListener((info) => {
  if(info.menuItemId==='routewise-developer-console') {
    chrome.tabs.create({url:chrome.runtime.getURL('developer.html')});
    return;
  }
  if(info.menuItemId!=='routewise-selected-flight'||!info.selectionText?.trim())return;
  let sourceUrl='';
  try {
    const url=new URL(info.pageUrl || '');
    if(['http:','https:'].includes(url.protocol))sourceUrl=url.toString();
  } catch { /* No source link available. */ }
  chrome.storage.local.set({
    pendingFlightCapture:{
      text:info.selectionText.trim().slice(0,5000),
      sourceUrl,
      capturedAt:new Date().toISOString()
    }
  });
});
