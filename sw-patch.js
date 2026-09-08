// Service Worker Patch for Arc Browser
// Intercepts sidePanel API calls and redirects to floating panel

console.log("[Claude Arc Patch] service worker patch loading");

// Can a web page embed sidepanel.html in an iframe? Only if the manifest Arc
// actually parsed lists it under web_accessible_resources. Arc has been
// observed to keep the manifest from the very first load, in which case the
// entry the patcher added is missing and Chromium blocks the iframe
// ("This page has been blocked by Arc"). getManifest() reflects the parsed
// manifest, so it tells us which situation we are in.
const _iframeAllowed = (() => {
  try {
    return (chrome.runtime.getManifest().web_accessible_resources || []).some(
      w => (w.resources || []).includes("sidepanel.html")
    );
  } catch (e) {
    return false;
  }
})();
console.log("[Claude Arc Patch] sidepanel iframe allowed by parsed manifest:", _iframeAllowed);

// Panel mode. "window" (default): sidepanel.html?mode=window in a popup
// window. "iframe": the in-page floating panel. The in-page panel lives
// inside the tab's document, so whenever the agent navigates its own tab —
// which it does routinely, e.g. "look this up in the docs" — the page, the
// panel and the running agent are all destroyed. A popup window survives
// navigation exactly like Chrome's real side panel does.
let _panelMode = "window";
function _useIframe() { return _panelMode === "iframe" && _iframeAllowed; }
try {
  chrome.storage.local.get("arcPanelMode", d => { if (d && (d.arcPanelMode === "iframe" || d.arcPanelMode === "window")) _panelMode = d.arcPanelMode; });
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.arcPanelMode) _panelMode = ch.arcPanelMode.newValue === "iframe" ? "iframe" : "window"; });
} catch (e) {}

// ── Fallback: open the panel as a popup window ──────────────────────
// The extension itself supports sidepanel.html?mode=window (used for its
// scheduled tasks), and honours an explicit tabId parameter.
const _panelWindows = new Map(); // tabId -> windowId
const PANEL_WINDOWS_KEY = "arcPanelWindows";

function _persistPanelWindows() {
  try { chrome.storage.local.set({ [PANEL_WINDOWS_KEY]: Object.fromEntries(_panelWindows) }); } catch (e) {}
}

// When the extension reloads (update, developer reload), Arc replaces the
// panel window's now-invalid extension page with chrome://new-tab-page/
// ("This site can't be reached / ERR_INVALID_URL") and the window lingers.
// Restore such windows to the panel (or close them if their tab is gone).
(async () => {
  try {
    const saved = (await chrome.storage.local.get(PANEL_WINDOWS_KEY))[PANEL_WINDOWS_KEY] || {};
    for (const [tabIdStr, windowId] of Object.entries(saved)) {
      const tabId = Number(tabIdStr);
      let win = null;
      try { win = await chrome.windows.get(windowId, { populate: true }); } catch (e) { continue; }
      const t = win.tabs && win.tabs[0];
      const url = chrome.runtime.getURL(`sidepanel.html?mode=window&tabId=${encodeURIComponent(tabId)}`);
      let hostAlive = true;
      try { await chrome.tabs.get(tabId); } catch (e) { hostAlive = false; }
      if (!hostAlive || !t) { try { await chrome.windows.remove(windowId); } catch (e) {} continue; }
      if (t.url !== url) { try { await chrome.tabs.update(t.id, { url }); } catch (e) {} }
      _panelWindows.set(tabId, windowId);
    }
  } catch (e) {}
  _persistPanelWindows();
})();

async function _openPanelWindow(tabId) {
  const existing = _panelWindows.get(tabId);
  if (existing != null) {
    try {
      await chrome.windows.get(existing);
      await chrome.windows.update(existing, { focused: true });
      return;
    } catch (e) {
      _panelWindows.delete(tabId);
    }
  }
  const url = chrome.runtime.getURL(`sidepanel.html?mode=window&tabId=${encodeURIComponent(tabId)}`);
  // Dock the window to the right edge of the tab's browser window, full
  // height, side-panel width — as close to Chrome's side panel as Arc allows.
  const PANEL_WIDTH = 420;
  let bounds = { width: PANEL_WIDTH, height: 800 };
  try {
    const tab = await chrome.tabs.get(tabId);
    const host = await chrome.windows.get(tab.windowId);
    if (host && host.width && host.height) {
      bounds = { width: PANEL_WIDTH, height: host.height, left: (host.left || 0) + host.width - PANEL_WIDTH, top: host.top || 0 };
    }
  } catch (e) {}
  const win = await chrome.windows.create({ url, type: "popup", focused: true, ...bounds });
  if (win?.id != null) {
    _panelWindows.set(tabId, win.id);
    _persistPanelWindows();
    // Arc ignores the bounds given to windows.create for popups; applying
    // them again with windows.update (after the window exists) works.
    if (bounds.left != null) {
      for (const delay of [0, 300, 1200]) {
        setTimeout(() => chrome.windows.update(win.id, bounds).catch(() => {}), delay);
      }
    }
  }
}

chrome.windows.onRemoved.addListener(windowId => {
  for (const [tabId, wid] of _panelWindows) {
    if (wid === windowId) _panelWindows.delete(tabId);
  }
  _persistPanelWindows();
});
// Close the panel window when its tab goes away.
chrome.tabs.onRemoved.addListener(tabId => {
  const wid = _panelWindows.get(tabId);
  if (wid != null) { _panelWindows.delete(tabId); _persistPanelWindows(); chrome.windows.remove(wid).catch(() => {}); }
});

// ── In-page floating panel (iframe) ─────────────────────────────────
// Send the toggle to the tab's floating panel. If the content script is not
// present yet (tab was open before the extension loaded), inject it first.
async function _toggleFloatingPanel(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_FLOATING_PANEL" });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["floating-panel.js"]
      });
      await new Promise(r => setTimeout(r, 100));
      await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_FLOATING_PANEL" });
    } catch (e2) {
      console.warn("[Claude Arc Patch] Could not open floating panel in tab", tabId, e2?.message);
    }
  }
}

async function _openPanel(tabId) {
  if (_useIframe()) await _toggleFloatingPanel(tabId);
  else await _openPanelWindow(tabId);
}

// Arc EXPOSES chrome.sidePanel (open/setOptions exist and even create
// EXTENSION_SIDE_PANEL contexts) but never renders a panel, exactly like it
// exposes-but-never-resolves the Tab Groups API. So we cannot feature-detect;
// the override must be unconditional. Record what the browser offered natively
// so it can be inspected later (it is surfaced on the floating panel element
// as data-arc-diag and in the GET_TAB_ID reply).
const _diag = {
  nativeSidePanel: !!chrome.sidePanel,
  nativeSidePanelOpen: typeof chrome.sidePanel?.open,
  nativeSidePanelSetOptions: typeof chrome.sidePanel?.setOptions,
  chromiumVersion: (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || null
};
console.log("[Claude Arc Patch] native chrome.sidePanel:", JSON.stringify(_diag));
if (!chrome.sidePanel) {
  chrome.sidePanel = {};
}

// sidePanel.open is the ONLY place the panel is toggled. The original service
// worker's own chrome.action.onClicked / commands.onCommand listeners call
// chrome.sidePanel.open(), so registering extra listeners here would toggle the
// panel twice per click (open, then instantly close).
chrome.sidePanel.open = async function (options) {
  let tabId = options?.tabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
  }
  if (tabId) await _openPanel(tabId);
};
chrome.sidePanel.setOptions = async function () {};
chrome.sidePanel.setPanelBehavior = async function () {};
chrome.sidePanel.getOptions = async function () {
  return { enabled: true };
};
chrome.sidePanel.getPanelBehavior = async function () {
  return { openPanelOnActionClick: true };
};
console.log("[Claude Arc Patch] chrome.sidePanel routed to", _useIframe() ? "floating panel" : "popup window");

// Register floating-panel.js as a dynamic content script. The manifest also
// declares it, but Arc has been observed to keep serving the manifest it parsed
// at first load, so do not rely on the manifest alone.
(async () => {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["arc-floating-panel"] });
    if (existing.length === 0) {
      await chrome.scripting.registerContentScripts([{
        id: "arc-floating-panel",
        js: ["floating-panel.js"],
        matches: ["<all_urls>"],
        excludeMatches: ["https://claude.ai/*", "https://*.claude.ai/*"],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true
      }]);
      console.log("[Claude Arc Patch] registered floating-panel content script");
    }
  } catch (e) {
    console.warn("[Claude Arc Patch] could not register content script:", e?.message);
  }
})();

// Messages from the floating-panel content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_TAB_ID") {
    sendResponse({ tabId: sender.tab?.id || 0, iframeAllowed: _useIframe(), diag: { ..._diag, iframeAllowed: _iframeAllowed, panelMode: _panelMode } });
    return true;
  }
  if (message.type === "ARC_OPEN_PANEL_WINDOW") {
    const tabId = message.tabId || sender.tab?.id;
    if (tabId) _openPanelWindow(tabId).then(() => sendResponse({ success: true }), e => sendResponse({ success: false, error: e?.message }));
    else sendResponse({ success: false });
    return true;
  }
});
