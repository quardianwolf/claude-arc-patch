# Claude Arc Patch

Make the official [Claude Chrome Extension](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn) work in [Arc Browser](https://arc.net).

## The Problem

Claude's Chrome extension uses the `chrome.sidePanel` API to display a sidebar panel. Arc Browser doesn't support this API, so the extension fails to load its UI.

## The Solution

This patcher copies the official Claude extension and applies minimal patches to make it work in Arc:

- **Floating sidebar panel** injected into web pages via a content script (replaces the unsupported sidePanel API)
- **Service worker patch** that monkey-patches `chrome.sidePanel` calls and routes icon clicks to the floating panel
- **Tab context patch** that fixes `chrome.tabs.query` so Claude can identify the active tab from within the iframe
- **Tab Groups shim** that emulates the Chrome Tab Groups API, which Arc exposes but never resolves (this is what makes Claude's browser automation / agentic browsing work in Arc)
- **Cowork experience patch** that forces the classic sidepanel, because the newer "cowork" experience embeds a `claude.ai` iframe that Arc's frame nesting causes to be refused (this is what fixes the `claude.ai refused to connect` breakage — see below)
- **Inline script extraction** to comply with Manifest V3 CSP requirements
- **Stale-manifest resilience**: Arc has been observed to keep using the manifest it parsed at first load, so the patches are also wired into the original service-worker entry point, the floating panel is registered as a dynamic content script, and the panel falls back to a popup window when the in-page iframe would be blocked (see below)

No original Claude extension code is modified. Only additional files are injected.

## Installation

### Prerequisites

- [Arc Browser](https://arc.net) installed
- [Claude Chrome Extension](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn) installed in Chrome (needed as source files)

### Steps

1. **Clone this repo**
   ```bash
   git clone https://github.com/quardianwolf/claude-arc-patch
   cd claude-arc-patch
   ```

2. **Run the patcher**
   ```bash
   ./patch.sh
   ```
   The script auto-detects the Claude extension installed in Chrome. If it can't find it, provide the path manually:
   ```bash
   ./patch.sh /path/to/claude/extension/directory
   ```

3. **Load in Arc**
   - Go to `arc://extensions`
   - Enable **Developer mode** (top right toggle)
   - Click **Load unpacked**
   - Select the `claude-arc-patched` folder
   - Disable the original Claude extension in Chrome to avoid conflicts

4. **If macOS blocks the script**
   ```bash
   xattr -cr /path/to/claude-arc-patch
   bash patch.sh
   ```

### Usage

- **Click the extension icon** in Arc's toolbar to toggle the Claude sidebar
- **Cmd+E** (Mac) / **Ctrl+E** (Windows) to toggle the sidebar
- Click the **X** button on the sidebar header to close it

## How It Works

| File | Purpose |
|------|---------|
| `patch.sh` | Copies the official extension and applies all patches |
| `floating-panel.js` | Content script that creates a sidebar panel on web pages |
| `sw-patch.js` | Service worker patch: monkey-patches sidePanel API, handles icon clicks and keyboard shortcuts |
| `arc-tabs-patch.js` | Patches `chrome.tabs.query` so the sidepanel can find the active tab from an iframe context |
| `arc-tabgroups-shim.js` | Emulates the Chrome Tab Groups API in memory (loaded in the service worker **and** the sidepanel page, synced via `storage.session`) so browser automation works — see below |
| `arc-cowork-patch.js` | Forces the classic sidepanel (sets `preferCoworkExperience=false`) so the panel never embeds the `claude.ai` cowork iframe that Arc refuses — see below |
| `theme-init.js` | Extracted inline script for dark/light mode (CSP compliance) |

### The Tab Groups problem (browser automation)

Claude's extension organizes the tabs it drives into a "Claude-managed tab group" using the Chrome Tab Groups API. Every automation call (`tabs_context_mcp`, `navigate`, etc.) funnels through `createGroup()` → `chrome.tabs.group()`.

Arc **exposes** this API surface — `chrome.tabGroups` is an object, `chrome.tabs.group` is a function, `chrome.tabGroups.TAB_GROUP_ID_NONE === -1` — but the calls **never resolve**. `chrome.tabs.group()` hangs forever, so the automation promise never settles and every request times out (~8s).

Confirmed empirically in the service-worker console:

```
STEP created 1204885098
STEP ERR TIMEOUT tabs.group      <-- chrome.tabs.group() never returns
```

`arc-tabgroups-shim.js` replaces the tab-group methods in place with a fully in-memory emulation keyed by synthetic group IDs.
It is loaded in **both** the service worker and `sidepanel.html`: the Claude Code bridge tools run in the service worker, but
the in-panel agent's own tools (`tabs_create`, `navigate`, …) run inside the sidepanel page. With the shim only in the service
worker, the panel saw its host tab as ungrouped, new tabs never joined the group, and the agent fell back to navigating the tab
that hosts the panel — which destroyed the panel. The copies stay consistent through `chrome.storage.session` + `onChanged`. It tracks membership itself and intercepts `chrome.tabs.query({groupId})` / `chrome.tabs.get()` so the rest of the extension keeps working unmodified. Visual grouping is cosmetic (Arc doesn't render tab groups anyway), so emulation is sufficient. State is mirrored to `chrome.storage.session` to survive service-worker restarts.

### The Cowork iframe problem (`claude.ai refused to connect`)

Newer Claude extensions can render the sidepanel as a server-gated **"cowork" experience** (feature gate `chrome_ext_cowork_iframe`, preference key `preferCoworkExperience`). That experience is an embedded iframe:

```html
<iframe src="https://claude.ai/cic/new?surface=cic_sidepanel" ...>
```

In Chrome's real side panel the frame's ancestor chain is just `chrome-extension://<id>/sidepanel.html > claude.ai`, and `claude.ai`'s `frame-ancestors` CSP allows the extension origin, so it loads.

In Arc there is no `chrome.sidePanel`, so the sidepanel runs as an iframe that `floating-panel.js` injects into the current web page. The chain becomes:

```
web page (top)  >  chrome-extension://<id>/sidepanel.html  >  claude.ai
```

`frame-ancestors` is checked against **every** ancestor, and the arbitrary top-level web page is not on `claude.ai`'s allow-list — so the frame is refused (**`claude.ai refused to connect`**) and the whole panel breaks. This flips on by itself whenever Anthropic enables the gate for an account, which is why it can start failing with **no version change** and **survives a clean reinstall**. The classic sidepanel is a local UI with no `claude.ai` iframe, so it works fine in Arc.

The extension already ships this exact off-switch: its own **"Switch back to classic"** action just runs `chrome.storage.local.set({ preferCoworkExperience: false })`. `arc-cowork-patch.js` asserts that same preference before the sidepanel bundle reads it, so the panel always starts in the classic experience under Arc. No original code is modified — the extension's own preference decides everything. (Browser automation still works: it runs through the service worker + bridge + the tab-groups shim, independent of which sidepanel UI is shown.)

### Panel mode: popup window (default) vs in-page floating panel

The floating panel is an iframe inside the tab's own document. Chrome's real side panel lives outside the page, so
the agent can navigate its own tab freely. In the iframe design every such navigation — and the agent does it
routinely ("look this up in the docs") — destroys the page, the panel *and the running agent*. The patch therefore
opens the panel as a popup window (`sidepanel.html?mode=window&tabId=…`, the mode the extension itself uses for
scheduled tasks) by default. It survives navigation and behaves like the Chrome side panel.

To use the in-page floating panel instead (fine for chatting, not for agent runs that navigate the current tab), set
`arcPanelMode` to `"iframe"` in the extension's `chrome.storage.local`, e.g. from the service-worker console:
`chrome.storage.local.set({ arcPanelMode: "iframe" })`. Set it to `"window"` (or remove it) to go back.

The popup window is remembered in `chrome.storage.local`; if the extension reloads (update, developer reload) Arc
replaces the window's now-invalid extension page with `chrome://new-tab-page/` ("This site can't be reached"), so on
startup the patch restores such windows to the panel (or closes them if their tab is gone). The window is also closed
when its tab closes. Separately, the Claude Code bridge creates its tab group in a new window at `chrome://newtab`,
which Arc cannot render either; the shim rewrites that to `about:blank`.

### The stale-manifest problem (patch loads but nothing happens)

Arc does not reliably re-parse `manifest.json` when you press **Reload** on an unpacked extension (this was
reproduced with `chrome.developerPrivate.reload` too: even a version bump in the manifest was not picked up).
Files *are* served fresh from the folder, but the registered service worker stays the original
`service-worker-loader.js`, the `floating-panel.js` content script is never registered, and `sidepanel.html`
is not web-accessible — so the extension icon does nothing, or the panel opens and shows
**"This page has been blocked by Arc"**.

Three things make the patch robust to this:

- `patch.sh` also prepends the patch imports to the original loader, so whichever entry point Arc uses, the
  patches load.
- `sw-patch.js` registers `floating-panel.js` via `chrome.scripting.registerContentScripts` at startup.
- `sw-patch.js` checks the manifest Arc actually parsed (`chrome.runtime.getManifest()`); if `sidepanel.html`
  is not web-accessible, the panel opens as a popup window (`sidepanel.html?mode=window&tabId=…`, the mode the
  extension already uses for scheduled tasks) instead of a blocked iframe. A fresh **Remove** + **Load unpacked**
  makes Arc parse the patched manifest, after which the in-page panel is used automatically.

Note also that Arc **exposes** `chrome.sidePanel` (`open`/`setOptions` exist and even create side-panel
contexts) but never renders it — the same pattern as the Tab Groups API. Feature detection therefore cannot be
used; `sw-patch.js` overrides `chrome.sidePanel` unconditionally. The original service worker's own
`action.onClicked` / `commands.onCommand` listeners call `chrome.sidePanel.open()`, so `sw-patch.js` must not
register its own listeners as well, or every click toggles the panel twice (open, then instantly close).

### Architecture

```
                  Arc Browser
                  +--------------------------+
                  |  Web Page                |
                  |  +--------------------+  |
  Icon click /    |  | floating-panel.js  |  |
  Cmd+E           |  | (content script)   |  |
       |          |  |                    |  |
  sw-patch.js --->|  |  +-------------+  |  |
  (service worker)|  |  | sidepanel   |  |  |
                  |  |  | .html       |  |  |
                  |  |  | (iframe)    |  |  |
                  |  |  +-------------+  |  |
                  |  +--------------------+  |
                  +--------------------------+
```

## Troubleshooting

**Panel not showing:**
- Make sure the extension is enabled at `arc://extensions`
- Refresh the page (Cmd+R)
- Check console for errors (Cmd+Option+I)

**Panel opens as a separate popup window instead of a sidebar, or shows "This page has been blocked by Arc":**
- Arc is still using the manifest from the first load (see *The stale-manifest problem* above). In `arc://extensions`
  **Remove** Claude, then **Load unpacked** the `claude-arc-patched` folder again. Reload alone is not enough.

**Icon click does nothing and the service-worker console is empty:**
- Open `arc://extensions` > Claude > "service worker". If the DevTools title says `service-worker-loader.js`
  rather than `sw-loader.js`, Arc is on the stale manifest — same fix as above. With this version of the patch
  the console should log `[Claude Arc Patch] ...` lines either way.

**Agent says new tabs "aren't part of my tab group" right after you reloaded the extension:**
- A panel that was already open keeps running the old code (its console shows `Extension context invalidated`). Close the
  panel and open it again. You can confirm the shim is active in the panel: open
  `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/sidepanel.html?mode=window&tabId=<tabId>` in a tab and inspect
  `document.documentElement.dataset.arcTabGroupsInstall` / `.arcTabGroups` (the shim mirrors its state there).

**Panel only shows "Claude is active in this tab group" / "Open chat" on every tab:**
- Fixed in this version. The extension's TabGroupManager reconciles its registry against `chrome.tabs.query({})` on every
  initialize; the shim used to return native (ungrouped) results for plain queries, so reconcile deleted every registered
  group, and the panel then saw its tab as a *secondary* member of an unregistered group. Plain queries now carry the
  emulated `groupId`. Emulated ids are also clock-seeded and persisted so they never collide with stale registry entries
  after an extension reload. After updating, reload the extension and reopen the panel.

**`patch.sh` says the source path does not exist after you removed the extension from Arc:**
- Arc deletes the Web Store copy under `~/Library/Application Support/Arc/User Data/Default/Extensions/<id>/` when the
  extension is removed. Keep a vanilla copy somewhere (or reinstall from the store in Chrome/Arc) to re-patch later.
  Re-running `patch.sh` against an already patched folder is safe: it leaves the loaders alone.

**Login issues:**
- Make sure you're logged into Claude in Chrome first
- The patched extension shares the same authentication

**Shortcut not working:**
- Cmd+E only works after the page has loaded
- Check `arc://extensions/shortcuts` for conflicts with other extensions

**Panel shows `claude.ai refused to connect` (or breaks after previously working):**
- This is the cowork iframe issue above. Make sure you re-ran `./patch.sh` against your current Claude version and reloaded the extension in Arc.
- Confirm the panel opened in classic mode: the sidepanel console (right-click panel > Inspect) should log `[Arc Cowork Patch] forced classic sidepanel` on first open.
- One-off manual fallback (no re-patch needed): open the panel's overflow menu and choose **Switch back to classic**.

**Browser automation / agentic browsing hangs or times out:**
- Open the service-worker console (`arc://extensions` > Claude > "service worker") and confirm you see `[Arc TabGroups Shim] active` at startup
- If it's missing, re-run `./patch.sh` and reload the extension

**The `arc://extensions` Errors page shows a wall of warnings:**
- Lines like `... is not used because it is a cross-world extension resource mismatch` and `... was preloaded using link preload but not used within a few seconds` are **harmless**. They are standard Chromium noise for an extension page (`options.html`, `sidepanel.html`) loaded as an iframe, and they appear even when everything works — they are not the cause of any failure. As long as the panel opens and there is no `claude.ai refused to connect`, you're fine.
- If something genuinely isn't working, judge it by the panel's own behavior and its console (right-click panel > Inspect), not by this passive Errors list.

**Patch didn't seem to take after an update:**
- Always patch against a **fresh, vanilla** Claude extension. Re-install/enable the official Claude extension in Chrome, `git pull` this repo (so you have the latest patch files), then re-run `./patch.sh` and **Load unpacked** the rebuilt `claude-arc-patched/` again in Arc (a reload alone may not pick up new files).

**"Operation not permitted" when running patch.sh:**
```bash
xattr -cr /path/to/claude-arc-patch
```

## Security

- No original Claude extension code is modified
- Only additional patch files are injected
- All code is open source and auditable
- The extension ID is preserved, so authentication continues to work
- No data is collected or sent externally

## Updating

When Claude releases a new extension version:

1. Update the Claude extension in Chrome
2. Re-run `./patch.sh`
3. Reload the extension in Arc (`arc://extensions` > reload icon)

## Contributing

Pull requests welcome. Please keep patches minimal and focused on Arc compatibility.

## License

MIT - see [LICENSE](LICENSE)

## Disclaimer

This project is not affiliated with Anthropic. Claude is a trademark of Anthropic, PBC.
