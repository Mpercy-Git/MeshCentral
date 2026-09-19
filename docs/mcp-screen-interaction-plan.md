# Add an MCP server to MeshCentral with screen interaction

> Re-anchored against `master` @ `f20be24` (merge of 44 upstream commits). All line
> references below were re-verified against that tree.

## Context

MeshCentral can already stream and control a device's desktop, but only through a browser
(`views/default.handlebars` + `public/scripts/agent-desktop-0.0.2.js`) or the CLI
(`meshctrl.js`). There is no way for an AI agent to look at a managed device's screen and act
on it. This change adds a Model Context Protocol endpoint so an MCP client (Claude Code,
Claude Desktop, etc.) can list devices, capture screenshots, and — when explicitly enabled —
drive mouse and keyboard, with MeshCentral's existing permission, consent and session-recording
behavior applied unchanged.

Decisions already made with the user:
- MCP server runs **in-process**, served over Streamable HTTP at `/mcp.ashx`.
- Tools cover **capture + input**, with input gated off by default (`settings.mcp.allowInput`).
- Clients authenticate with **existing login tokens** (`meshuser.js:5223` `createLoginToken`).

## Why in-process

The desktop multiplexor already maintains a complete server-side framebuffer for every active
desktop session: `obj.screen` maps each 16x16 tile to an image index and `obj.images` holds the
JPEG tile payloads in a linked list from `obj.firstData` to `obj.lastData`
(`meshdesktopmultiplex.js:74-78`, `700-784`). Running in-process means a screenshot of an
already-open session costs zero extra agent bandwidth, and reuses `GetNodeRights`, consent
prompts, `.mcrec` recording and session metadata instead of reimplementing them.

## Architecture

```
MCP client --HTTP(S)--> /mcp.ashx (mcpserver.js)
                          |  login-token auth -> MeshCentral user object
                          |  tool dispatch + per-node rights checks
                          v
                 mcpdesktop.js        mcpagent.js
                 (headless viewer)    (runcommands / console / clipboard)
                          |
                 desktop multiplexor <-> MeshAgent
```

### 1. `mcpserver.js` (new)

- `CreateMcpServer(webserver)`, created from `webserver.js` when `config.settings.mcp` is set.
- Routes registered in the same per-domain loop as the other `.ashx` endpoints
  (`webserver.js:7550-7600`, alongside `control.ashx` at 7550 and `meshrelay.ashx` at 7598):
  `POST` plus `GET`/`DELETE` for the Streamable HTTP session lifecycle.
- Auth: `Authorization: Basic <tokenUser:tokenPass>`, verified against the `logintoken-*` DB
  records exactly as `webserver.js:619` does, yielding `obj.users[loginToken.userid]`. Honors
  token expiry and the `domain.passwordrequirements.logintokens` allow-list. No new credential
  type.
- Protocol: `@modelcontextprotocol/sdk` `Server` + `StreamableHTTPServerTransport`, one
  transport per MCP session, mapped `mcp-session-id -> { transport, user, domain, desktops }`.
  Pin the version and confirm `require()` interop in Phase 1; if the published build is ESM-only,
  load it with dynamic `import()` (fine on the Node >= 20 floor in `package.json`).
- Every tool call re-checks rights at call time via `webserver.GetNodeRights(user, node.meshid,
  node._id)` — never trusts a cached decision from session setup.

### 2. `mcpdesktop.js` (new)

- **Attaching.** Build a synthetic `req` (`{ query: { browser: 1, p: 2, nodeid, id }, clientIp,
  headers }`) and a shim `ws`, then call `CreateMeshRelay(webserver, ws, req, domain, user,
  cookie)` with a device-share-shaped cookie (`nid`, `r` = computed rights, `cf` = consent flags,
  `gn` = guest name, e.g. `MCP: <username>`). That branch
  (`meshdesktopmultiplex.js:1332-1377`, tunnel command built at 1347) already sends the agent
  tunnel command with all `domain.consentmessages` / `notificationmessages` options and joins the
  multiplexor — so consent prompts, view-only enforcement, recording and the viewer list work
  with no changes to that path.
- **ws shim.** The relay and multiplexor use exactly `ws.send(data, cb)`, `ws.close()`,
  `ws.on('message'|'error'|'close')` and `ws._socket.{setKeepAlive, pause, resume, bytesRead,
  bytesWritten, _parent.end}` (`meshdesktopmultiplex.js:388`, `460-462`, `1190`, `1244-1273`).
  ~60 lines on an `EventEmitter` satisfies all of them.
- **Lifecycle.** Lazily created per (mcp-session, nodeid), reference-counted, torn down after an
  idle timeout (default 60s). Capture-only sessions send pause (command 8) between captures.

### 3. Screen capture

- **Fast path** — a multiplexor already exists (`webserver.desktoprelays[nodeid]`). Add
  `getScreenTiles()` to `meshdesktopmultiplex.js`, walking `obj.images` from `obj.firstData` to
  `obj.lastData` and returning `{ width, height, tiles: [{ x, y, data }] }` — the same byte
  sequence a freshly connected viewer receives, costing the agent nothing.
- **Cold path** — no session yet: attach, send compression settings (command 5:
  `[0x0005][len][type=1 JPEG][quality][scaling u16][framerate u16]`), unpause (command 8), then
  refresh (command 6) and collect command-3 tiles until the screen is covered or ~5s elapses.
- **Compositor** — decode each tile with `jpeg-js`, blit into a `width * height * 4` RGBA buffer
  at the tile's `x`/`y` (header parsed as at `meshdesktopmultiplex.js:700-703`), optionally
  downscale to `maxWidth`, re-encode as JPEG or PNG (`pngjs`), return base64 MCP `image` content.
  Pure JS, no native dependency, consistent with the existing `image-size` usage.

**Prerequisite now satisfied:** the merged tree includes the jumbo-packet padding fix
(`meshdesktopmultiplex.js:690`, `data.length >= (cmdsize + 8)`). Before it, the agent's 8-byte
padding made complete large tiles fail an exact-equality check and get dropped as partial, so
full-frame captures would have silently come back with holes.

### 4. Input encoding

Byte formats from `public/scripts/agent-desktop-0.0.2.js`, cross-checked against the viewer-side
switch at `meshdesktopmultiplex.js:546-658`:

| Action | Frame |
|---|---|
| Mouse down/up/move | `00 02 00 0A 00 <button> <Xhi Xlo> <Yhi Ylo>` (line 626) |
| Double-click | `00 02 00 0A 00 88 <X> <Y>` (line 620) |
| Scroll | `00 02 00 0C 00 00 <X> <Y> <deltaHi deltaLo>` (line 624) |
| Key down/up | `00 01 00 06 <up> <keycode>` (line 521); `up`: 0=down, 1=up, 3/4=extended |
| Unicode char | `00 55 00 07 <0\|1> <charHi charLo>` (lines 528-529, 536) |
| Ctrl-Alt-Del | command 10 |
| Get/set display | commands 11 / 12 |

**Changed upstream — Right Shift** (`5789825`, #8153): `ShiftRight` was removed from
`extendedKeyTable` (`agent-desktop-0.0.2.js:411`) and now sends **keycode 161, non-extended**
(lines 428-430), because right Shift has its own scan code rather than an extended left-Shift
one. Gated on `obj.UseExtendedKeyFlag` (line 57, defaults true) or `extkeys=1`. The MCP key
encoder must mirror this or right Shift will be wrong on Windows agents.

Input frames are sent only when `settings.mcp.allowInput === true`, the user holds
`MESHRIGHT_REMOTECONTROL`, and the session is not view-only — the multiplexor independently
drops input from view-only viewers (`meshdesktopmultiplex.js:577-581`), so this is defense in
depth.

### 5. Non-pixel capability (`mcpagent.js`, new)

Screenshots are the most expensive thing an agent can do (~2.7k image tokens for a 1080p frame
vs tens of tokens for a text answer), so pixels should be the fallback, not the main loop.

- **`runcommands`** (`meshuser.js:3089`, agent side `agents/meshcore.js:1917`) — `type` 1 =
  cmd.exe, 2 = PowerShell, 3 = bash/sh; `reply: true` returns stdout+stderr; `runAsUser` 0 =
  agent/SYSTEM, 1 = user-or-agent, 2 = user-only. For 1/2 the agent spawns through
  `user-sessions.consoleUid()` with `SpawnTypes.TERM`, i.e. inside the interactive desktop
  session — the AutoHotkey substrate: PowerShell `System.Windows.Automation`/`SendKeys` on
  Windows, `xdotool`/`wmctrl` on Linux, `osascript` on macOS.
- **Agent console** (`{action:'msg', type:'console', value}`) — ~90 built-ins listed at
  `agents/meshcore.js:4701`: `ps`, `kill`, `service`, `users`, `netinfo`, `sysinfo`,
  `installedapps`, `wmi`, `idletime`, `openurl`, `openfile`, `toast`, `httpget`, `zip`/`unzip`.
- **Clipboard** (`agents/meshcore.js:1605-1660`, gated by `domain.clipboardget` /
  `clipboardset`) — Ctrl+A/Ctrl+C then `getclip` reads remote text with no OCR; `setclip` +
  Ctrl+V pastes a paragraph in one round trip instead of hundreds of key events.
- **Cheap screen deltas** — incoming tiles carry `x`/`y` and bump `obj.counter`
  (`meshdesktopmultiplex.js:700-722`), so change detection needs no JPEG decoding.

**Critical, from upstream `4ca56d4` (#8080):** the server **broadcasts a `runcommands` reply to
every open control session under the same login**, not just the requester. `meshctrl` reproduced
3-4 concurrent `--reply` calls all printing whichever device answered first — silently
mislabeled, no error. An MCP server issuing concurrent `run_script` calls hits this directly.
Each call must carry a **unique `responseid`** (e.g. `crypto.randomUUID()`) and the reply handler
must match on it strictly, rather than awaiting "the next `runcommands` reply".

Limits for the tool descriptions: helper binaries must exist on the endpoint, and none of this
reaches the Windows secure desktop (login screen, UAC) or a machine with no user session — KVM
capture and input remain the only path there.

## Tools exposed

Pixel tools:

| Tool | Rights | Notes |
|---|---|---|
| `list_devices` | per-node visibility | id, name, os, online state, group |
| `get_screen_info` | REMOTEVIEW | resolution + display list (commands 11/82) |
| `capture_screen` | REMOTEVIEW | `nodeid`, `maxWidth`, `quality`, `format`, `display`, `region` |
| `wait_for_screen_change` | REMOTEVIEW | tile-delta only, returns changed regions, no decode |
| `set_display` | REMOTECONTROL | multi-monitor selection |
| `mouse_move` / `mouse_click` / `mouse_scroll` | REMOTECONTROL + `allowInput` | absolute pixel coords |
| `key_press` | REMOTECONTROL + `allowInput` | chords; Right Shift special case above |
| `type_text` | REMOTECONTROL + `allowInput` | unicode keys; prefers clipboard paste for long text |
| `send_ctrl_alt_del` | REMOTECONTROL + `allowInput` | command 10 |

Cheaper-than-pixels tools (tool descriptions should say to prefer these):

| Tool | Rights | Notes |
|---|---|---|
| `run_script` | AGENTCONSOLE/REMOTECONTROL + `allowShell` | `runcommands`, unique `responseid`, timeout |
| `agent_console` | AGENTCONSOLE + `allowShell` | meshcore built-in command set |
| `list_windows` | AGENTCONSOLE + `allowShell` | per-OS canned script over `run_script` |
| `list_processes` / `get_sysinfo` | DEVICEDETAILS | `ps` / existing `getsysinfo` |
| `get_clipboard` / `set_clipboard` | REMOTECONTROL | honors `clipboardget`/`clipboardset` |
| `open_url` / `open_file` | REMOTECONTROL | launches in the user's desktop session |
| `show_toast` | REMOTECONTROL | existing `toast` path (`meshuser.js:3328`) |

## Configuration

```json
"settings": {
  "mcp": {
    "enabled": true,
    "allowInput": false,
    "allowShell": false,
    "maxImageWidth": 1280,
    "imageQuality": 60,
    "sessionIdleTimeout": 60,
    "scriptTimeout": 30
  }
}
```

- `meshcentral.js` — conditional module install next to the existing desktop-multiplex entry
  (`meshcentral.js:4449`): push the pinned MCP SDK, `jpeg-js`, `pngjs` and `image-size`.
- `meshcentral-config-schema.json` (near `desktopMultiplex` at line 653) and
  `sample-config-advanced.json` — document the block.
- MCP requires the desktop multiplexor; if `settings.desktopMultiplex` is off, log a clear
  startup error and leave the endpoint disabled.

## Safety and auditing

- Endpoint absent unless `settings.mcp.enabled`; input tools absent from `tools/list` unless
  `allowInput`; `run_script` / `agent_console` / `list_windows` absent unless `allowShell`.
- `run_script` is arbitrary RCE — requires `MESHRIGHT_AGENTCONSOLE`, capped by `scriptTimeout`,
  and inherits the existing `runcommands` audit event (`meshuser.js:3178`/`3186`), so every run
  is logged with user and command text. `runAsUser` defaults to 2 (user-only).
- Per-call `GetNodeRights`; `domain.desktop.viewonly` continues to force view-only.
- Consent prompts and notification bars fire as for a browser viewer, since the tunnel command is
  built by the existing relay path.
- Session recording (`startRecording`, `meshdesktopmultiplex.js:831`) applies unchanged.
- The MCP viewer appears in `sendSessionMetadata` viewer lists under its guest name, so operators
  can see an agent is watching.
- Dispatch a login event with `tokenName`/`tokenUser` (mirroring `webserver.js:1665`) and a relay
  event per desktop attach.
- Rate-limit input calls and cap concurrent MCP desktop sessions per user.
- Review the recently merged tightenings before finalizing auth: `8a63537` (device share cookies
  on control sessions — the cookie shape the headless viewer borrows), `f15d30d` (share guest
  checks), `2a077f3` (No-Files on the file endpoint), `ed76eba`/`2207214` (agent enrollment by
  source IP).

## Files

| File | Change |
|---|---|
| `mcpserver.js` | new — transport, auth, tool registry/dispatch |
| `mcpdesktop.js` | new — ws shim, KVM encode/decode, JPEG compositor |
| `mcpagent.js` | new — `runcommands`/console/clipboard tools, per-OS window scripts |
| `meshdesktopmultiplex.js` | add `getScreenTiles()` (read-only walk of existing state) |
| `webserver.js` | instantiate MCP server, register `/mcp.ashx` in the domain loop (~7550) |
| `meshcentral.js` | conditional module install (~4449), config validation |
| `meshcentral-config-schema.json`, `sample-config-advanced.json` | `mcp` settings block |
| `docs/` or `readme.md` | short setup section |

## Phases

1. **Done.** Config plumbing, `/mcp.ashx` transport, login-token auth, `list_devices`,
   `get_screen_info`. See `mcpserver.js`.
2. **Done.** Non-pixel tools in `mcpagent.js`: `run_script`, `agent_console`,
   `list_processes`, `get_sysinfo`, `list_windows`, `get_clipboard`, `set_clipboard`,
   `open_url`.
3. `getScreenTiles()`, cold-path attach, JPEG compositor, `capture_screen`,
   `wait_for_screen_change`.
4. Input tools behind `allowInput` (including the Right Shift case) and `set_display`.
5. Rate limits, docs, and a first run inside a live server.

### Corrections the implementation forced on this plan

- Login token usernames are `'~t:' + base64`, so they contain a colon and cannot be split
  as an HTTP Basic userinfo field on the first colon. The separator is the first colon
  after the prefix; `Bearer` is also accepted.
- There is no `MESHRIGHT_REMOTEVIEW`. `0x100` is `REMOTEVIEWONLY`, a restriction. Desktop
  access is `REMOTECONTROL` without `NODESKTOP`. Full rights (`0xFFFFFFFF`) contains every
  restriction bit, so those bits must not be tested for an administrator.
- Agent replies are routed by `webserver.routeAgentCommand()` through
  `webserver.wssessions2[sessionid]`, so each call registers a short-lived pseudo-session
  there. Carrying a per-call `sessionid` is what actually prevents the #8080 cross-talk; a
  unique `responseid` alone does not, because a reply with no `sessionid` is broadcast to
  every control session under the same login.
- `authenticate()` already understands login tokens, so no token verification is
  reimplemented.

## Related work already on the branch

The `win-uiautomation.js` spike (`agents/modules_meshcore/win-uiautomation.js`) is **done and
answered on real Windows hardware**. Driving the Win32 windowing API from agent JavaScript
through `_GenericMarshal` works: `GetTopWindow` + `GetWindow(GW_HWNDNEXT)` enumerated 132
top-level windows, with titles, class names, PIDs and rectangles read correctly via
`GetWindowTextW` / `GetClassNameW` / `GetWindowRect`, dispatched into the interactive session
(`sessionId: 1`) from the SYSTEM agent in session 0.

`EnumWindows` with a `CreateCallbackProxy` WNDENUMPROC was tried and rejected on two measured
grounds: passing lParam 0 killed the process with a native fault (the thunk locates the JS
function through that context value, so it must receive `.State`), and even with `.State` passed
correctly the callback visited exactly one window and stopped, because the JS return value never
reaches native code and `EnumWindows` reads a non-TRUE return as "stop". The callback path is
removed from the module.

So `list_windows` should call this module directly rather than shelling out to PowerShell or
AutoHotkey — no endpoint prerequisites, and it is already proven. The same `_GenericMarshal`
idiom extends to `SetForegroundWindow`, `SendMessageW` and the rest of the Win32 surface, with
one constraint recorded: **anything requiring a native callback is off the table** on this agent
runtime, so prefer enumeration APIs that return values over ones that call you back.

## Verification

No automated test suite in the repo, so verification is manual end-to-end:

1. Start a server with `"desktopMultiplex": true` and the `mcp` block enabled:
   `node meshcentral.js --debug relay,mcp`. Or use the branch's Docker image from
   `docker-ghcr.yml`.
2. Enroll a test agent (Windows for the input and window-automation paths).
3. Create a login token in the web UI (My Account -> Security -> Login tokens).
4. `claude mcp add --transport http meshcentral https://<server>/mcp.ashx --header "Authorization: Basic <base64 tokenUser:tokenPass>"`,
   then confirm `tools/list` shows only capture tools while `allowInput`/`allowShell` are false.
5. `capture_screen` with no browser session open (cold path), then with the device's desktop tab
   open in the web UI (fast path). Compare both against what the browser shows, and confirm the
   browser session keeps working while the MCP viewer is attached.
6. Enable `allowInput`; drive a click plus `type_text` into a remote editor. Verify right Shift
   specifically, given the upstream encoding change.
7. Enable `allowShell`; `run_script` a PowerShell one-liner at `runAsUser: 2` and confirm stdout
   returns and a `runcommands` audit event appears. Then fire 3-4 concurrent `run_script` calls
   at different devices under one login and confirm each reply is matched to the right call —
   this is the #8080 cross-talk case.
8. Negative tests: user without `REMOTECONTROL` denied; view-only group ignores input; expired or
   revoked login token rejected; non-multiplexed server refuses to start the endpoint; clipboard
   tools respect `clipboardget`/`clipboardset` being false.
9. Confirm a `.mcrec` recording is produced when session recording is on, and that it replays in
   the built-in player.
