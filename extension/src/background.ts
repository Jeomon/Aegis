/**
 * Service worker. Its only job right now is to make the toolbar button open the side panel
 * rather than a popup — without this, clicking the icon does nothing at all.
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err: unknown) => console.error('Aegis: could not set side panel behaviour', err))
