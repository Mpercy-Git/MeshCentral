/*
Copyright 2024 Intel Corporation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

//
// SPIKE: Windows top-level window enumeration and activation from agent JavaScript.
//
// The point of this module is to answer one question: can we drive the Win32 windowing
// API from the agent's JS runtime through _GenericMarshal, so that remote UI automation
// can target windows by name instead of hunting for them in a screenshot?
//
// Two independent enumeration paths are implemented on purpose:
//
//   'walk'     - GetTopWindow(NULL) followed by GetWindow(hwnd, GW_HWNDNEXT). Uses only
//                scalar returns, no callback ABI involved. This is the default.
//
//   'callback' - EnumWindows() with a WNDENUMPROC built by Marshal.CreateCallbackProxy().
//                The idiomatic Win32 way, and opt-in only, for the reason below.
//
// Finding from a real agent (2026-09-19): calling EnumWindows with lParam 0 killed the
// process outright with a native "FATAL EXCEPTION @ ILibParsers.c:2786", rather than
// raising a catchable JS error. The cause is that _GenericMarshal's thunk locates the JS
// function through the context value the API passes back, which is why
// wifi-scanner-windows.js:133 hands .Callback and .State to WlanRegisterNotification's
// callback and context parameters together. EnumWindows' lParam is that same context
// slot, so it must receive .State. That is now what this module does.
//
// Because a mistake on that path is a process-killing fault rather than an error, the
// walk is the default and the callback runs only when asked for by name. A second open
// question remains for the callback path: whether the JS return value reaches native
// code at all. EnumWindows reads a FALSE return as "stop", so a proxy that always yields
// 0 returns just the first window - hence the fallback when it produces fewer than two.
//
// selfTest() always runs the walk, and attempts the callback only when asked.
//
// Session note: the agent normally runs as LocalSystem in session 0, which has its own
// window station and therefore cannot see the interactive user's windows. Every exported
// function takes an optional tsid and dispatches into the target session using the same
// child-process pattern as modules_meshcore/win-deskutils.js. Enumerating from session 0
// without a tsid is expected to return few or no windows - that is correct behavior, not
// a failure of the FFI path.
//

if (process.platform != 'win32') { throw ('win-uiautomation is only supported on Windows'); }

var GM = require('_GenericMarshal');

var user32 = GM.CreateNativeProxy('user32.dll');
user32.CreateMethod('EnumWindows');
user32.CreateMethod('GetTopWindow');
user32.CreateMethod('GetWindow');
user32.CreateMethod('GetForegroundWindow');
user32.CreateMethod('SetForegroundWindow');
user32.CreateMethod('ShowWindow');
user32.CreateMethod('IsWindowVisible');
user32.CreateMethod('IsIconic');
user32.CreateMethod('GetWindowTextW');
user32.CreateMethod('GetClassNameW');
user32.CreateMethod('GetWindowRect');
user32.CreateMethod('GetWindowThreadProcessId');

var GW_HWNDNEXT = 2;
var SW_RESTORE = 9;
var MAX_WINDOWS = 5000;      // Guard against a corrupt sibling chain looping forever
var TEXT_CHARS = 256;        // Character capacity of the title/class buffers

// Keeps the callback proxy referenced for the duration of the EnumWindows call, and
// collects the handles the callback sees. Module scope rather than closure state so that
// nothing depends on how the proxy binds 'this'.
var _enumProxy = null;
var _enumAccum = null;

//
// Normalize whatever _GenericMarshal hands us into a plain JS number.
// Return values expose .Val; callback arguments may arrive as marshal objects instead.
//
function handleOf(x)
{
    if (x == null) { return 0; }
    if (typeof x == 'number') { return x; }
    try { if (typeof x.Val == 'number') { return x.Val; } } catch (e) { }
    try
    {
        var b = x.toBuffer();
        if (GM.PointerSize == 8) { return b.readUInt32LE(0) + (b.readUInt32LE(4) * 4294967296); }
        return b.readUInt32LE(0);
    }
    catch (e) { }
    return Number(x);
}

//
// Decode a UTF-16LE buffer filled in by a *W API. Done by hand rather than through a
// Buffer encoding so this does not depend on the agent's Buffer supporting 'ucs2'.
//
function wideToString(v, maxChars)
{
    var buf = v.toBuffer();
    var s = '';
    for (var i = 0; i < maxChars; ++i)
    {
        var c = buf.readUInt16LE(i * 2);
        if (c == 0) { break; }
        s += String.fromCharCode(c);
    }
    return s;
}

//
// WNDENUMPROC. Must return TRUE to keep enumerating - see the header note about whether
// this return value actually reaches native code.
//
function enumWindowsProc(hwnd, lparam)
{
    try { _enumAccum.push(handleOf(hwnd)); } catch (e) { }
    return 1;
}

//
// Enumeration path 1: EnumWindows + callback proxy.
//
// The lParam must be the proxy's State pointer, not 0. _GenericMarshal's native thunk
// uses the context value the API hands back to locate the JS function, which is why
// wifi-scanner-windows.js:133 passes .Callback and .State together into
// WlanRegisterNotification's callback and context parameters. EnumWindows' lParam is
// that same context slot. Passing 0 made the thunk dereference a null context and
// killed the process with a native FATAL EXCEPTION in ILibParsers.c, observed on a
// real agent. Because that is a hard crash rather than a catchable error, this path is
// never taken unless the caller asks for it by name.
//
function enumViaCallback(lparamMode)
{
    _enumAccum = [];
    _enumProxy = GM.CreateCallbackProxy(enumWindowsProc, 2);
    try
    {
        // 'zero' reproduces the original crash on purpose; only useful for confirming it.
        user32.EnumWindows(_enumProxy.Callback, (lparamMode == 'zero') ? 0 : _enumProxy.State);
    }
    finally
    {
        _enumProxy = null;
    }
    var list = _enumAccum;
    _enumAccum = null;
    return list;
}

//
// Enumeration path 2: sibling walk. No callback ABI, only scalar returns.
//
function enumViaWalk()
{
    var list = [];
    var seen = {};
    var h = handleOf(user32.GetTopWindow(0));
    while ((h != 0) && (list.length < MAX_WINDOWS))
    {
        if (seen[h] === 1) { break; } // Cycle guard
        seen[h] = 1;
        list.push(h);
        h = handleOf(user32.GetWindow(h, GW_HWNDNEXT));
    }
    return list;
}

//
// Collect the descriptive properties of a single window handle.
//
function describe(hwnd)
{
    var title = GM.CreateVariable(TEXT_CHARS * 2);
    var cls = GM.CreateVariable(TEXT_CHARS * 2);
    var rect = GM.CreateVariable(16);   // RECT: 4 x LONG
    var pid = GM.CreateVariable(4);

    user32.GetWindowTextW(hwnd, title, TEXT_CHARS);
    user32.GetClassNameW(hwnd, cls, TEXT_CHARS);
    user32.GetWindowRect(hwnd, rect);
    user32.GetWindowThreadProcessId(hwnd, pid);

    var r = rect.toBuffer();
    return {
        handle: hwnd,
        title: wideToString(title, TEXT_CHARS),
        className: wideToString(cls, TEXT_CHARS),
        pid: pid.toBuffer().readUInt32LE(0),
        visible: (handleOf(user32.IsWindowVisible(hwnd)) != 0),
        minimized: (handleOf(user32.IsIconic(hwnd)) != 0),
        rect: {
            left: r.readInt32LE(0),
            top: r.readInt32LE(4),
            right: r.readInt32LE(8),
            bottom: r.readInt32LE(12)
        }
    };
}

//
// options: { method: 'walk' | 'callback', lparamMode: 'state' | 'zero',
//            visibleOnly: bool, titledOnly: bool }
//
// The default is deliberately 'walk'. The callback path can take the whole process down
// rather than raising a catchable error, so it is opt-in only.
//
function enumerateLocal(options)
{
    if (options == null) { options = {}; }
    var method = (options.method == null) ? 'walk' : options.method;
    var visibleOnly = (options.visibleOnly !== false);
    var titledOnly = (options.titledOnly !== false);

    var handles = [];
    var used = method;
    if (method == 'callback')
    {
        try { handles = enumViaCallback(options.lparamMode); } catch (e) { handles = []; }
        // A callback that yields fewer than two windows means the return value was not
        // propagated, so enumeration stopped early. Fall back rather than silently
        // reporting an almost-empty desktop.
        if (handles.length < 2)
        {
            var walked = enumViaWalk();
            if (walked.length > handles.length) { handles = walked; used = 'walk'; }
        }
    }
    else
    {
        handles = enumViaWalk();
        used = 'walk';
    }

    var out = [];
    for (var i = 0; i < handles.length; ++i)
    {
        var w;
        try { w = describe(handles[i]); } catch (e) { continue; }
        if (visibleOnly && (w.visible == false)) { continue; }
        if (titledOnly && (w.title == '')) { continue; }
        out.push(w);
    }
    return { method: used, count: out.length, windows: out };
}

function findLocal(titleSubstring)
{
    var needle = ('' + titleSubstring).toLowerCase();
    var all = enumerateLocal({}).windows;
    var hits = [];
    for (var i = 0; i < all.length; ++i)
    {
        if (all[i].title.toLowerCase().indexOf(needle) >= 0) { hits.push(all[i]); }
    }
    return hits;
}

function activateLocal(hwnd)
{
    hwnd = Number(hwnd);
    if (handleOf(user32.IsIconic(hwnd)) != 0) { user32.ShowWindow(hwnd, SW_RESTORE); }
    var ok = (handleOf(user32.SetForegroundWindow(hwnd)) != 0);
    // SetForegroundWindow is subject to foreground lock, so confirm rather than trust it.
    return { requested: hwnd, result: ok, foreground: handleOf(user32.GetForegroundWindow()) };
}

function foregroundLocal()
{
    var h = handleOf(user32.GetForegroundWindow());
    if (h == 0) { return null; }
    return describe(h);
}

//
// Runs both enumeration paths and reports whether they agree. This is what proves or
// disproves the callback path on a given machine.
//
// The walk always runs. The callback is attempted only when includeCallback is set,
// because a bad call there is a process-killing native fault, not an exception.
function selfTestLocal(includeCallback)
{
    var res = {
        platform: process.platform,
        pointerSize: GM.PointerSize,
        isRoot: null,
        sessionId: null,
        walk: { ok: false, count: 0, error: null },
        callback: { attempted: false, ok: false, count: 0, error: null }
    };

    try { res.isRoot = require('user-sessions').isRoot(); } catch (e) { }
    try { res.sessionId = require('user-sessions').getProcessOwnerName(process.pid).tsid; } catch (e) { }

    var wk = [];
    try { wk = enumViaWalk(); res.walk.ok = true; res.walk.count = wk.length; }
    catch (e) { res.walk.error = '' + e; }

    var cb = [];
    if (includeCallback)
    {
        res.callback.attempted = true;
        try { cb = enumViaCallback(); res.callback.ok = true; res.callback.count = cb.length; }
        catch (e) { res.callback.error = '' + e; }
        res.agree = (res.callback.ok && res.walk.ok && (Math.abs(cb.length - wk.length) <= 2));
        res.callbackReturnValueHonored = (res.callback.ok && (cb.length > 1));
    }

    // A small sample of real windows, so the output shows this reached actual UI state.
    res.sample = [];
    try
    {
        var e = enumerateLocal({});
        res.methodUsed = e.method;
        res.titledVisibleCount = e.count;
        for (var i = 0; (i < e.windows.length) && (i < 5); ++i)
        {
            res.sample.push({ title: e.windows[i].title, className: e.windows[i].className, pid: e.windows[i].pid });
        }
    }
    catch (ex) { res.sampleError = '' + ex; }

    return res;
}

//
// Dispatch a call into a specific user session. Same approach as
// modules_meshcore/win-deskutils.js:43 - spawn the agent binary inside the target session
// and relay the JSON result back over stdout, because session 0 cannot see the
// interactive desktop's windows.
//
function sessionDispatch(tsid, parent, method, args)
{
    var sid = undefined;
    var stype = require('user-sessions').getProcessOwnerName(process.pid).tsid == 0 ? 1 : 0;

    if (stype == 1)
    {
        if ((tsid == null) && (require('MeshAgent')._tsid != null))
        {
            stype = 5;                          // ILibProcessPipe_SpawnTypes_SPECIFIED_USER
            sid = require('MeshAgent')._tsid;
        }
        else
        {
            sid = tsid;
        }
    }

    var prog = "try { addModule('win-uiautomation', process.env['win_uiautomation']);} catch (x) { } var x;try{x=require('win-uiautomation').dispatch('" + parent + "', '" + method + "', " + JSON.stringify(args) + ");console.log(x);}catch(z){console.log(z);process.exit(1);}process.exit(0);";
    var child = require('child_process').execFile(process.execPath, [process.execPath.split('\\').pop(), '-b64exec', Buffer.from(prog).toString('base64')], { type: stype, uid: sid, env: { win_uiautomation: getJSModule('win-uiautomation') } });

    child.stdout.str = '';
    child.stdout.on('data', function (c) { this.str += c.toString(); });
    child.stderr.on('data', function (c) { });
    child.on('exit', function (c) { this.exitCode = c; });
    child.waitExit();

    if (child.exitCode == 0) { return (child.stdout.str.trim()); }
    throw (child.stdout.str.trim());
}

function dispatch(parent, method, args)
{
    try
    {
        return (this[parent][method].apply(this, args));
    }
    catch (e)
    {
        console.log('ERROR: ' + e);
        throw ('Error occured trying to dispatch: ' + method);
    }
}

//
// Public API. Each function runs locally when tsid is undefined, or dispatches into the
// given session when a tsid is supplied (pass null to mean "the console session").
//
function enumerateWindows(options, tsid)
{
    if (tsid !== undefined) { return JSON.parse(sessionDispatch(tsid, 'json', 'enumerate', [options])); }
    return enumerateLocal(options);
}

function findWindow(titleSubstring, tsid)
{
    if (tsid !== undefined) { return JSON.parse(sessionDispatch(tsid, 'json', 'find', [titleSubstring])); }
    return findLocal(titleSubstring);
}

function activateWindow(hwnd, tsid)
{
    if (tsid !== undefined) { return JSON.parse(sessionDispatch(tsid, 'json', 'activate', [hwnd])); }
    return activateLocal(hwnd);
}

function getForegroundWindow(tsid)
{
    if (tsid !== undefined) { return JSON.parse(sessionDispatch(tsid, 'json', 'foreground', [])); }
    return foregroundLocal();
}

function selfTest(tsid, includeCallback)
{
    if (tsid !== undefined) { return JSON.parse(sessionDispatch(tsid, 'json', 'selfTest', [includeCallback === true])); }
    return selfTestLocal(includeCallback === true);
}

// String-returning variants, used by sessionDispatch because the child relays over stdout.
module.exports = {
    enumerateWindows: enumerateWindows,
    findWindow: findWindow,
    activateWindow: activateWindow,
    getForegroundWindow: getForegroundWindow,
    selfTest: selfTest,
    dispatch: dispatch
};
module.exports.json = {
    enumerate: function (options) { return JSON.stringify(enumerateLocal(options)); },
    find: function (t) { return JSON.stringify(findLocal(t)); },
    activate: function (h) { return JSON.stringify(activateLocal(h)); },
    foreground: function () { return JSON.stringify(foregroundLocal()); },
    selfTest: function (includeCallback) { return JSON.stringify(selfTestLocal(includeCallback === true)); }
};
