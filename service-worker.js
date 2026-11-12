// Clicking the toolbar action opens RouteWise beside the active browser tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('RouteWise side panel:', error));
