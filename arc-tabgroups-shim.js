// ──────────────────────────────────────────────────────────────────
// Arc Tab Groups Shim
//
// Arc exposes the Chrome Tab Groups API surface (chrome.tabGroups is an
// object, chrome.tabs.group is a function, TAB_GROUP_ID_NONE === -1), BUT the
// calls never resolve: chrome.tabs.group() hangs forever. The Claude
// extension's automation layer ("MCP tab group") funnels every
// tabs_context_mcp / navigate through createGroup() -> chrome.tabs.group(), so
// the MCP tool never resolves and the request times out.
//
// Empirically (service-worker console):
//   STEP created 1204885098
//   STEP ERR TIMEOUT tabs.group      <-- chrome.tabs.group() never returns
//
// This shim replaces the tab-group methods in place with a fully in-memory
// emulation keyed by synthetic group IDs. It tracks membership itself and
// intercepts chrome.tabs.query({groupId}) / chrome.tabs.get() so the rest of
// the extension keeps working unmodified. Visual grouping is cosmetic and Arc
// doesn't render tab groups anyway, so emulation is sufficient. State is
// mirrored to chrome.storage.session so it survives service-worker restarts.
//
// Loaded in the service worker (where mcpPermissions + the bridge websocket +
// the tab-group manager run). Methods are overridden in place rather than
// replacing chrome.tabGroups wholesale, which is more likely to succeed when
// the native namespace object is present but non-configurable.
// ──────────────────────────────────────────────────────────────────

(function () {
  "use strict";
  try { if (typeof document !== "undefined" && document.documentElement) document.documentElement.dataset.arcTabGroupsInstall = "started"; } catch (e) {}
  if (typeof window !== "undefined") window.addEventListener("error", function (ev) {
    try { if (ev && ev.filename && /arc-tabgroups-shim/.test(ev.filename)) document.documentElement.dataset.arcTabGroupsError = String(ev.message); } catch (e) {}
  });

  if (typeof chrome === "undefined" || !chrome.tabs) return;
  if (globalThis.__arcTabGroupsShimInstalled) return;

  console.log("[Arc TabGroups Shim] installing in-memory tab group emulation");

  var NONE = -1;
  // Group ids must never be reused. The extension's own group registry
  // (mcpPermissions TabGroupManager) persists across extension reloads while
  // storage.session (our state) is wiped, so a counter restarting at 900001
  // would hand a new group the id of a stale registry entry and the panel
  // would then treat the tab as a *secondary* tab of that old group ("Claude
  // is active in this tab group"). Seed from the clock and also persist the
  // counter in storage.local.
  var COUNTER_KEY = "__arcTabGroupsNextId";
  var nextGroupId = 900000000 + (Math.floor(Date.now() / 1000) % 900000000);
  try {
    chrome.storage.local.get(COUNTER_KEY, function (d) {
      var saved = d && d[COUNTER_KEY];
      if (typeof saved === "number" && saved > nextGroupId) nextGroupId = saved;
    });
  } catch (e) {}
  function persistCounter() {
    try { chrome.storage.local.set({ [COUNTER_KEY]: nextGroupId }); } catch (e) {}
  }
  // groupId -> { title, color, collapsed, windowId, tabIds:Set<number> }
  var groups = new Map();
  // tabId -> groupId
  var tabToGroup = new Map();

  var Color = {
    grey: "grey", blue: "blue", red: "red", yellow: "yellow",
    green: "green", pink: "pink", purple: "purple", cyan: "cyan", orange: "orange",
    GREY: "grey", BLUE: "blue", RED: "red", YELLOW: "yellow",
    GREEN: "green", PINK: "pink", PURPLE: "purple", CYAN: "cyan", ORANGE: "orange"
  };

  // ── Persistence (survive MV3 service-worker restarts) ───────────────
  var STORE_KEY = "__arcEmulatedTabGroups";
  var storageOk = true;

  function save() {
    try {
      var arr = [];
      groups.forEach(function (g, id) {
        arr.push({
          id: id, title: g.title, color: g.color, collapsed: g.collapsed,
          windowId: g.windowId, tabIds: Array.from(g.tabIds)
        });
      });
      return chrome.storage.session.set({
        __arcEmulatedTabGroups: { nextGroupId: nextGroupId, groups: arr }
      });
    } catch (e) { return Promise.resolve(); }
  }

  function mirrorRegistryForDebug() {
    // Also expose the extension's own group registry (storage.local) for debugging.
    try {
      if (typeof document === "undefined" || !document.documentElement) return;
      chrome.storage.local.get(null, function (all) {
        try {
          var out = {};
          Object.keys(all || {}).forEach(function (k) { if (/group/i.test(k)) out[k] = all[k]; });
          document.documentElement.dataset.arcRegistry = JSON.stringify(out);
        } catch (e) {}
      });
    } catch (e) {}
  }

  function mirrorForDebug() {
    mirrorRegistryForDebug();
    // In document contexts (sidepanel.html) expose the emulated state on the
    // root element so it can be inspected without extension-API access.
    try {
      if (typeof document !== "undefined" && document.documentElement) {
        var arr = [];
        groups.forEach(function (g, id) { arr.push({ id: id, tabIds: Array.from(g.tabIds) }); });
        document.documentElement.dataset.arcTabGroups = JSON.stringify({ storageOk: storageOk, groups: arr });
      }
    } catch (e) {}
  }

  function applySaved(saved) {
    groups.clear();
    tabToGroup.clear();
    if (!saved) { mirrorForDebug(); return; } // store cleared (e.g. extension reload) → empty state
    if (saved.nextGroupId && saved.nextGroupId > nextGroupId) nextGroupId = saved.nextGroupId;
    (saved.groups || []).forEach(function (g) {
      groups.set(g.id, {
        title: g.title, color: g.color, collapsed: g.collapsed,
        windowId: g.windowId, tabIds: new Set(g.tabIds)
      });
      g.tabIds.forEach(function (t) { tabToGroup.set(t, g.id); });
    });
    mirrorForDebug();
  }

  async function refresh() {
    if (!storageOk) return;
    try {
      var d = await chrome.storage.session.get(STORE_KEY);
      applySaved(d && d[STORE_KEY]);
    } catch (e) { storageOk = false; /* storage.session unavailable → in-memory only */ }
  }
  var ready = refresh();

  // The shim runs in more than one context: the service worker (Claude Code
  // bridge tools) AND the sidepanel page (the in-panel agent's own tools such
  // as tabs_create execute there). Each context has its own in-memory copy,
  // so mirror every change through storage.session to keep them consistent.
  // Without this the panel sees the host tab as ungrouped, never adds new tabs
  // to the group, and the agent ends up navigating the panel's own tab.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "session" || !changes[STORE_KEY]) return;
      applySaved(changes[STORE_KEY].newValue);
    });
  } catch (e) {}

  function groupObj(id) {
    var g = groups.get(id);
    if (!g) throw new Error("No group with id " + id);
    return {
      id: id, title: g.title || "", color: g.color || "orange",
      collapsed: !!g.collapsed, windowId: g.windowId
    };
  }

  // ── Native references (used only for non-group tab operations) ──────
  var nativeQuery = chrome.tabs.query.bind(chrome.tabs);
  var nativeGet = chrome.tabs.get.bind(chrome.tabs);
  var nativeGroupRef = chrome.tabs.group, nativeQueryRef = chrome.tabs.query;
  var nativeTabGroupsQueryRef = chrome.tabGroups && chrome.tabGroups.query;

  // ── chrome.tabs.group ───────────────────────────────────────────────
  chrome.tabs.group = async function (opts) {
    await ready;
    await refresh(); // another context may have written since we last looked
    opts = opts || {};
    var tabIds = [].concat(opts.tabIds || []);
    var gid = opts.groupId;
    var windowId = opts.createProperties && opts.createProperties.windowId;

    if (gid == null || !groups.has(gid)) {
      if (gid == null) { gid = nextGroupId++; persistCounter(); }
      if (windowId == null && tabIds.length) {
        try { var t0 = await nativeGet(tabIds[0]); windowId = t0.windowId; } catch (e) {}
      }
      groups.set(gid, {
        title: "", color: "orange", collapsed: false,
        windowId: windowId, tabIds: new Set()
      });
    }
    var g = groups.get(gid);
    tabIds.forEach(function (t) { g.tabIds.add(t); tabToGroup.set(t, gid); });
    await save();
    return gid;
  };

  // ── chrome.tabs.ungroup ─────────────────────────────────────────────
  chrome.tabs.ungroup = async function (tabIds) {
    await ready;
    await refresh();
    [].concat(tabIds || []).forEach(function (t) {
      var gid = tabToGroup.get(t);
      if (gid != null) {
        var g = groups.get(gid);
        if (g) g.tabIds.delete(t);
        tabToGroup.delete(t);
      }
    });
    await save();
  };

  // ── chrome.tabs.query (intercept groupId filter, else pass through) ──
  function doQuery(info) {
    return (async function () {
      await ready;
      if (info && info.groupId != null) {
        // Native Arc can't resolve group filters; serve from our tracking.
        if (groups.has(info.groupId)) {
          var g = groups.get(info.groupId);
          var out = [];
          var ids = Array.from(g.tabIds);
          for (var i = 0; i < ids.length; i++) {
            try { var t = await nativeGet(ids[i]); t.groupId = info.groupId; out.push(t); }
            catch (e) { /* tab gone; drop it */ g.tabIds.delete(ids[i]); tabToGroup.delete(ids[i]); }
          }
          return out;
        }
        // Unknown group: return everything native, filtered by our tracking.
        var clone = Object.assign({}, info);
        delete clone.groupId;
        var res = await nativeQuery(clone);
        return res.filter(function (t) { return tabToGroup.get(t.id) === info.groupId; });
      }
      // Plain queries must also carry the emulated groupId: the extension's
      // TabGroupManager.reconcileWithChrome() does chrome.tabs.query({}) and
      // collects every tab's groupId to decide which registered groups still
      // exist. Without the overlay every tab looks ungrouped, reconcile wipes
      // the whole registry (including the tab that was just registered), and
      // the panel then renders the "Claude is active in this tab group"
      // secondary-tab screen instead of the chat.
      var res2 = await nativeQuery(info);
      return (res2 || []).map(function (t) {
        var gid = tabToGroup.get(t.id);
        if (gid != null) t.groupId = gid;
        else if (t.groupId == null) t.groupId = NONE;
        return t;
      });
    })();
  }

  chrome.tabs.query = function (info, cb) {
    var p = doQuery(info);
    if (typeof cb === "function") { p.then(cb, function () { cb([]); }); return; }
    return p;
  };

  // ── chrome.tabs.get (overlay emulated groupId) ──────────────────────
  chrome.tabs.get = function (id, cb) {
    var p = (async function () {
      var t = await nativeGet(id);
      var gid = tabToGroup.get(id);
      if (gid != null) t.groupId = gid;
      else if (t.groupId == null) t.groupId = NONE;
      return t;
    })();
    if (typeof cb === "function") { p.then(cb, function () { cb(undefined); }); return; }
    return p;
  };

  // ── chrome.tabGroups method overrides (in place) ────────────────────
  function installTabGroups() {
    var tg = chrome.tabGroups;
    if (!tg) {
      try { chrome.tabGroups = {}; tg = chrome.tabGroups; }
      catch (e) { tg = null; }
    }
    if (!tg) { globalThis.__arcTabGroups = {}; tg = globalThis.__arcTabGroups; }

    function set(k, v) { try { tg[k] = v; } catch (e) {} }

    set("get", async function (id) { await ready; return groupObj(id); });
    set("query", async function (info) {
      await ready;
      var out = [];
      groups.forEach(function (g, id) {
        var o = groupObj(id);
        if (info) {
          if (info.windowId != null && o.windowId !== info.windowId) return;
          if (info.color != null && o.color !== info.color) return;
          if (info.title != null && o.title !== info.title) return;
          if (info.collapsed != null && o.collapsed !== info.collapsed) return;
        }
        out.push(o);
      });
      return out;
    });
    set("update", async function (id, props) {
      await ready;
      await refresh();
      var g = groups.get(id);
      if (!g) throw new Error("No group with id " + id);
      if (props) {
        if (props.title != null) g.title = props.title;
        if (props.color != null) g.color = props.color;
        if (props.collapsed != null) g.collapsed = props.collapsed;
      }
      await save();
      return groupObj(id);
    });
    set("move", async function (id) { await ready; return groupObj(id); });

    if (typeof tg.TAB_GROUP_ID_NONE === "undefined") set("TAB_GROUP_ID_NONE", NONE);
    if (!tg.Color) set("Color", Color);
    ["onCreated", "onUpdated", "onMoved", "onRemoved"].forEach(function (k) {
      if (!tg[k]) set(k, { addListener: function () {}, removeListener: function () {} });
    });
  }
  installTabGroups();

  // Keep membership clean when tabs close.
  try {
    if (chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener) {
      chrome.tabs.onRemoved.addListener(function (tabId) {
        // Re-read first: this fires in every context, and a stale copy must
        // never overwrite the shared state.
        ready.then(refresh).then(function () {
          var gid = tabToGroup.get(tabId);
          if (gid != null) {
            var g = groups.get(gid);
            if (g) g.tabIds.delete(tabId);
            tabToGroup.delete(tabId);
            save();
          }
        });
      });
    }
  } catch (e) {}

  // chrome.windows.create({url:"chrome://newtab"}) — used by the Claude Code
  // bridge when it creates its tab group (tabs_context_mcp createIfEmpty) —
  // opens a window at chrome://new-tab-page/ in Arc, which Arc cannot render
  // ("This site can't be reached / ERR_INVALID_URL"). Open a blank page instead;
  // the bridge navigates the tab right after anyway.
  try {
    if (chrome.windows && chrome.windows.create) {
      var nativeWindowsCreate = chrome.windows.create.bind(chrome.windows);
      chrome.windows.create = function (data, cb) {
        try {
          if (data && typeof data.url === "string" && /^chrome:\/\/newtab\/?$/.test(data.url)) data = Object.assign({}, data, { url: "about:blank" });
        } catch (e) {}
        return cb ? nativeWindowsCreate(data, cb) : nativeWindowsCreate(data);
      };
    }
  } catch (e) {}

  globalThis.__arcTabGroupsShimInstalled = true;

  // Debug: record whether the overrides actually took effect in this context.
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.dataset.arcTabGroupsInstall = JSON.stringify({
        groupOverridden: chrome.tabs.group !== nativeGroupRef,
        getOverridden: chrome.tabs.get !== nativeGet,
        queryOverridden: chrome.tabs.query !== nativeQueryRef,
        tabGroupsGet: typeof chrome.tabGroups.get,
        tabGroupsQueryOverridden: chrome.tabGroups.query !== nativeTabGroupsQueryRef
      });
    }
  } catch (e) {}
  console.log("[Arc TabGroups Shim] active");
})();
