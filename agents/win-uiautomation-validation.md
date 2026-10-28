# Windows UI automation validation

The Node mock suite validates control flow, handle-set comparison, text decoding,
and session dispatch plumbing. Even when run on a Windows CI worker, it does not
exercise MeshAgent's native `_GenericMarshal` or an interactive Windows desktop.

## Run on a real Windows agent

1. Update the server to this fork's current code, rebuild/upload its default agent
   core, and confirm the Windows agent has loaded the updated core. Open the
   agent's console from MeshCentral using an account permitted to use that console.
2. Sign in to Windows and open at least two named application windows, including
   Notepad. Keep the desktop stable while comparing enumeration paths.
3. Run `uiwindows selftest`. Save the complete JSON, the agent version, Windows
   version and architecture, and this fork's commit SHA. The report's `sessionId`
   should identify the interactive session rather than session 0. Both paths
   should have `ok: true`; `agree` compares actual handles, not approximate counts.
   Differences are exposed in `missingFromCallback` and `missingFromWalk`. Retry
   on a stable desktop if windows opened or closed during the test.
4. `callbackReturnValueHonored: true` means callbacks continued beyond one window.
   `false` means the callback path stopped early while the walk saw multiple
   windows; `null` means there was insufficient evidence. An empty desktop does
   not prove the native callback ABI. If callbacks fail, `uiwindows list` should
   still enumerate windows using the `walk` fallback.
5. Run `uiwindows list` and `uiwindows find Notepad`; verify titles, PIDs, rectangles,
   visibility and minimized state against the actual desktop. Include a window
   with a non-ASCII title and, if available, one on a monitor with negative coordinates.
6. Minimize Notepad, then run `uiwindows activate <handle>` using the returned
   numeric handle. Check that the window restores. Windows foreground-lock rules
   can deny activation: inspect both `result` and `foreground`, then confirm with
   `uiwindows foreground` and the visible desktop.
7. Repeat `uiwindows selftest --session <tsid>` for the intended user session,
   including an RDP session if used. Compare with `uiwindows selftest --local`,
   which runs inside the service's session 0 and may legitimately see no user windows.

Record failures and full console output before treating native validation as
complete. No real Windows-agent validation result is checked into this fork yet.
