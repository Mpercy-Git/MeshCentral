/**
* @description MeshCentral MCP agent tools
* @author Ylian Saint-Hilaire
* @copyright Intel Corporation 2018-2024
* @license Apache-2.0
* @version v0.0.1
*/

/*jslint node: true */
/*jshint node: true */
/*jshint strict:false */
/*jshint -W097 */
/*jshint esversion: 6 */
'use strict';

// Tools that reach a device without moving pixels: running commands, the agent console,
// the clipboard, and window enumeration. These are far cheaper than a screenshot (a 1080p
// frame is on the order of 2700 image tokens against tens for a text answer) and are
// usually more accurate, so a model should reach for these first.
//
// Replies from an agent are routed by webserver.routeAgentCommand(), which looks the
// sessionid up in webserver.wssessions2 and calls send() on whatever it finds. Rather
// than add a routing path, each request registers a short-lived pseudo-session there for
// the duration of the call. That matters for correctness, not just convenience: without a
// sessionid the agent's reply is broadcast to every control session under the same login,
// which is the cross-talk fixed upstream in meshctrl by #8080. Carrying a per-call
// sessionid and a per-call responseid means a reply can only ever reach its own caller.

const MESHRIGHT_REMOTECONTROL = 0x00000008;
const MESHRIGHT_AGENTCONSOLE = 0x00000010;
const MESHRIGHT_FULL = 0xFFFFFFFF;

// Agent type codes for 'runcommands'.
const RUNCMD_WINDOWS_BATCH = 1;
const RUNCMD_WINDOWS_POWERSHELL = 2;
const RUNCMD_POSIX_SHELL = 3;

module.exports.CreateMcpAgent = function (parent, mcp) {
    var obj = {};
    const config = ((parent.parent.config.settings != null) && (typeof parent.parent.config.settings.mcp == 'object')) ? parent.parent.config.settings.mcp : {};
    // See mcpConfigValue: config keys arrive lowercased, so "scriptTimeout" is "scripttimeout".
    const scriptTimeoutValue = require('./mcpserver.js').mcpConfigValue(config, 'scriptTimeout');
    const scriptTimeout = ((typeof scriptTimeoutValue == 'number') ? scriptTimeoutValue : 30) * 1000;

    // Console output arrives as a series of messages with no end marker, so collect until
    // the agent has been quiet for this long, bounded by the overall timeout.
    const CONSOLE_QUIET_MS = 700;

    function hasConsoleRights(rights) {
        if (rights == MESHRIGHT_FULL) { return true; }
        return ((rights & (MESHRIGHT_REMOTECONTROL | MESHRIGHT_AGENTCONSOLE)) == (MESHRIGHT_REMOTECONTROL | MESHRIGHT_AGENTCONSOLE));
    }
    function hasRemoteControl(rights) {
        if (rights == MESHRIGHT_FULL) { return true; }
        return ((rights & MESHRIGHT_REMOTECONTROL) != 0);
    }

    // True if this device runs a Windows agent. Agent ids 1-4 and 42-43 are the Windows
    // builds, matching the check in meshuser.js before dispatching runcommands.
    function isWindows(node) {
        if ((node.agent == null) || (typeof node.agent.id != 'number')) { return null; }
        const id = node.agent.id;
        return (((id > 0) && (id < 5)) || ((id > 41) && (id < 44)));
    }

    //
    // Send a command to an agent and collect the replies addressed to this call.
    //
    // opts.match(msg)    - true if this reply belongs to the request
    // opts.done(msg)     - true if the request is complete (default: first match)
    // opts.collect       - accumulate every match and resolve with the array
    // opts.timeout       - milliseconds before giving up
    //
    function agentRequest(ctx, node, command, opts, func) {
        const agent = parent.wsagents[node._id];
        if (agent == null) {
            // Peer servers would need DispatchMessageSingleServer here; say so plainly
            // rather than timing out with no explanation.
            func((parent.parent.multiServer != null) ? 'Device is not connected to this server' : 'Device is not connected');
            return;
        }

        const sessionId = ctx.user._id + '/mcp' + parent.parent.crypto.randomBytes(8).toString('hex');
        var finished = false, collected = [], quietTimer = null;

        const timer = setTimeout(function () { finish('Timed out waiting for the device to reply'); }, (opts.timeout != null) ? opts.timeout : scriptTimeout);

        function finish(err, result) {
            if (finished) { return; }
            finished = true;
            if (timer != null) { clearTimeout(timer); }
            if (quietTimer != null) { clearTimeout(quietTimer); }
            if (parent.wssessions2[sessionId] === pseudoSession) { delete parent.wssessions2[sessionId]; }
            func(err, result);
        }

        // Only send() / userid / domainid are ever touched on a session object by the
        // server (routeAgentCommand, the admin trace broadcast, and the session counters).
        const pseudoSession = {
            userid: ctx.user._id,
            domainid: ctx.domain.id,
            sessionId: sessionId,
            send: function (data) {
                if (finished) { return; }
                var msg = null;
                try { msg = JSON.parse(data); } catch (ex) { return; }
                if ((msg == null) || (opts.match(msg) == false)) { return; } // Not ours; unrelated server traffic lands here too
                if (opts.collect === true) {
                    collected.push(msg);
                    if ((opts.done != null) && (opts.done(msg) == true)) { finish(null, collected); return; }
                    // No end marker, so settle once the agent stops talking.
                    if (quietTimer != null) { clearTimeout(quietTimer); }
                    quietTimer = setTimeout(function () { finish(null, collected); }, CONSOLE_QUIET_MS);
                } else {
                    finish(null, msg);
                }
            }
        };
        parent.wssessions2[sessionId] = pseudoSession;

        command.sessionid = sessionId;
        try { agent.send(JSON.stringify(command)); } catch (ex) { finish('Unable to reach the device'); }
    }

    // Run an agent console command and return its text output.
    function consoleCommand(ctx, node, rights, cmd, timeout, func) {
        if (hasConsoleRights(rights) == false) { func('Access denied: this account cannot run agent console commands on this device'); return; }
        agentRequest(ctx, node, { action: 'msg', type: 'console', value: cmd, rights: rights }, {
            match: function (m) { return ((m.action == 'msg') && (m.type == 'console') && (typeof m.value == 'string')); },
            collect: true,
            timeout: timeout
        }, function (err, msgs) {
            if (err != null) { func(err); return; }
            var text = '';
            for (var i in msgs) { text += msgs[i].value + '\n'; }
            func(null, text.trim());
        });
    }

    //
    // Tools
    //
    obj.tools = {
        'run_script': {
            needsShell: true,
            description: 'Run a command or script on a device and return its output. Prefer this over reading the screen. On Windows use type "powershell" or "batch", elsewhere use "shell". Runs in the logged-in user\'s desktop session by default, which is required for anything that touches the UI.',
            inputSchema: {
                type: 'object',
                properties: {
                    nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' },
                    script: { type: 'string', description: 'The command or script to run.' },
                    type: { type: 'string', enum: ['powershell', 'batch', 'shell'], description: 'Interpreter to use. Defaults to powershell on Windows and shell elsewhere.' },
                    runAs: { type: 'string', enum: ['user', 'agent', 'userOrAgent'], description: 'Which context to run in. "user" (default) is the interactive desktop session and is required for UI automation. "agent" runs as the agent account, typically SYSTEM or root.' }
                },
                required: ['nodeid', 'script']
            },
            handler: toolRunScript
        },
        'agent_console': {
            needsShell: true,
            description: 'Run a MeshCentral agent console command on a device and return its output. Useful built-ins include ps, services, netinfo, sysinfo, volumes, users, installedapps and openurl. Run "help" to list what a given agent supports.',
            inputSchema: {
                type: 'object',
                properties: {
                    nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' },
                    command: { type: 'string', description: 'The console command, for example "ps" or "help".' }
                },
                required: ['nodeid', 'command']
            },
            handler: toolAgentConsole
        },
        'list_processes': {
            needsShell: true,
            description: 'List the processes running on a device. Cheaper and more reliable than looking at the screen to find out what is running.',
            inputSchema: {
                type: 'object',
                properties: { nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' } },
                required: ['nodeid']
            },
            handler: function (ctx, args, func) { withNode(ctx, args, func, function (node, rights) { consoleCommand(ctx, node, rights, 'ps', null, function (e, t) { func(e, { nodeid: node._id, processes: t }); }); }); }
        },
        'get_sysinfo': {
            needsShell: true,
            description: 'Get operating system, hardware and network information for a device.',
            inputSchema: {
                type: 'object',
                properties: { nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' } },
                required: ['nodeid']
            },
            handler: function (ctx, args, func) { withNode(ctx, args, func, function (node, rights) { consoleCommand(ctx, node, rights, 'osinfo', null, function (e, t) { func(e, { nodeid: node._id, info: t }); }); }); }
        },
        'list_windows': {
            needsShell: true,
            description: 'List the open application windows on a device, with their titles and process ids. Use this instead of taking a screenshot when you need to know what is open, or to find a window to act on.',
            inputSchema: {
                type: 'object',
                properties: { nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' } },
                required: ['nodeid']
            },
            handler: toolListWindows
        },
        'get_clipboard': {
            description: 'Read the clipboard of the logged-in user on a device. To read text out of an application, focus it, send Ctrl+A then Ctrl+C, and call this. That is far cheaper and more accurate than reading text off a screenshot.',
            inputSchema: {
                type: 'object',
                properties: { nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' } },
                required: ['nodeid']
            },
            handler: toolGetClipboard
        },
        'set_clipboard': {
            description: 'Write text to the clipboard of the logged-in user on a device. To enter a long passage of text, set it here and then send Ctrl+V, rather than typing it key by key.',
            inputSchema: {
                type: 'object',
                properties: {
                    nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' },
                    text: { type: 'string', description: 'Text to place on the clipboard.' }
                },
                required: ['nodeid', 'text']
            },
            handler: toolSetClipboard
        },
        'open_url': {
            needsShell: true,
            description: 'Open a URL in the default browser of the logged-in user on a device.',
            inputSchema: {
                type: 'object',
                properties: {
                    nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' },
                    url: { type: 'string', description: 'The URL to open, including the scheme.' }
                },
                required: ['nodeid', 'url']
            },
            handler: toolOpenUrl
        }
    };

    // Shared prologue: resolve the device, check the caller still has rights on it.
    function withNode(ctx, args, func, next) {
        mcp.getNodeWithRights(ctx, args.nodeid, function (err, node, rights) {
            if (err != null) { func(err); return; }
            next(node, rights);
        });
    }

    function toolRunScript(ctx, args, func) {
        if (typeof args.script != 'string' || args.script.length == 0) { func('A script is required'); return; }
        withNode(ctx, args, func, function (node, rights) {
            if (hasConsoleRights(rights) == false) { func('Access denied: this account cannot run commands on this device'); return; }

            const win = isWindows(node);
            var type;
            if (args.type == 'powershell') { type = RUNCMD_WINDOWS_POWERSHELL; }
            else if (args.type == 'batch') { type = RUNCMD_WINDOWS_BATCH; }
            else if (args.type == 'shell') { type = RUNCMD_POSIX_SHELL; }
            else { type = (win === false) ? RUNCMD_POSIX_SHELL : RUNCMD_WINDOWS_POWERSHELL; }

            // The agent rejects a mismatched interpreter silently, so refuse here with a
            // reason the model can act on.
            if ((win === true) && (type == RUNCMD_POSIX_SHELL)) { func('This is a Windows device; use type "powershell" or "batch"'); return; }
            if ((win === false) && (type != RUNCMD_POSIX_SHELL)) { func('This is not a Windows device; use type "shell"'); return; }

            // 2 = user only, 1 = user or agent, 0 = agent. Default to the interactive
            // session, since that is what UI automation needs.
            var runAsUser = 2;
            if (args.runAs == 'agent') { runAsUser = 0; }
            else if (args.runAs == 'userOrAgent') { runAsUser = 1; }

            const responseid = 'mcp' + parent.parent.crypto.randomBytes(8).toString('hex');
            agentRequest(ctx, node, { action: 'runcommands', type: type, cmds: args.script, runAsUser: runAsUser, reply: true, responseid: responseid }, {
                // Both must match: the sessionid gets it to this caller, the responseid
                // guards against a stale reply from an earlier call on the same session.
                match: function (m) { return ((m.action == 'msg') && (m.type == 'runcommands') && (m.responseid == responseid)); }
            }, function (err, msg) {
                if (err != null) { func(err); return; }
                func(null, { nodeid: node._id, ranAs: (runAsUser == 2) ? 'user' : ((runAsUser == 1) ? 'userOrAgent' : 'agent'), output: (msg.result != null) ? msg.result : '' });
            });

            // Record who ran what, matching the event meshuser dispatches for runcommands.
            const targets = parent.CreateNodeDispatchTargets(node.meshid, node._id, ['server-users', ctx.user._id]);
            parent.parent.DispatchEvent(targets, obj, {
                etype: 'node', userid: ctx.user._id, username: ctx.user.name, nodeid: node._id,
                action: 'runcommands', msg: 'Running commands (MCP)', cmds: args.script, cmdType: type,
                runAsUser: runAsUser, domain: ctx.domain.id
            });
        });
    }

    function toolAgentConsole(ctx, args, func) {
        if (typeof args.command != 'string' || args.command.length == 0) { func('A command is required'); return; }
        withNode(ctx, args, func, function (node, rights) {
            consoleCommand(ctx, node, rights, args.command, null, function (err, text) {
                if (err != null) { func(err); return; }
                func(null, { nodeid: node._id, output: text });
            });
        });
    }

    function toolListWindows(ctx, args, func) {
        withNode(ctx, args, func, function (node, rights) {
            const win = isWindows(node);
            if (win === true) {
                // The agent-side module enumerates through the Win32 API directly, so this
                // needs nothing installed on the device.
                consoleCommand(ctx, node, rights, 'uiwindows list', null, function (err, text) {
                    if (err != null) { func(err); return; }
                    if (/Unknown command/.test(text)) { func('This agent does not have the window automation module; its core may predate it.'); return; }
                    var parsed = null;
                    try { parsed = JSON.parse(text); } catch (ex) { }
                    if (parsed == null) { func(null, { nodeid: node._id, raw: text }); return; }
                    func(null, { nodeid: node._id, count: parsed.count, windows: parsed.windows });
                });
            } else {
                // No equivalent agent module off Windows, so fall back to the usual X11
                // tools and say clearly when they are absent.
                const script = 'command -v wmctrl >/dev/null 2>&1 && wmctrl -lp || (command -v xdotool >/dev/null 2>&1 && xdotool search --onlyvisible --name "" getwindowname %@ || echo "NO_WINDOW_TOOL")';
                agentRunPosix(ctx, node, rights, script, function (err, out) {
                    if (err != null) { func(err); return; }
                    if (/NO_WINDOW_TOOL/.test(out)) { func('This device has neither wmctrl nor xdotool installed, so its windows cannot be listed.'); return; }
                    func(null, { nodeid: node._id, windows: out });
                });
            }
        });
    }

    function agentRunPosix(ctx, node, rights, script, func) {
        if (hasConsoleRights(rights) == false) { func('Access denied: this account cannot run commands on this device'); return; }
        const responseid = 'mcp' + parent.parent.crypto.randomBytes(8).toString('hex');
        agentRequest(ctx, node, { action: 'runcommands', type: RUNCMD_POSIX_SHELL, cmds: script, runAsUser: 2, reply: true, responseid: responseid }, {
            match: function (m) { return ((m.action == 'msg') && (m.type == 'runcommands') && (m.responseid == responseid)); }
        }, function (err, msg) { func(err, (msg && msg.result != null) ? msg.result : ''); });
    }

    function toolGetClipboard(ctx, args, func) {
        withNode(ctx, args, func, function (node, rights) {
            if (ctx.domain.clipboardget == false) { func('Reading the clipboard is disabled on this server'); return; }
            if (hasRemoteControl(rights) == false) { func('Access denied'); return; }
            agentRequest(ctx, node, { action: 'msg', type: 'getclip', tag: 1 }, {
                match: function (m) { return ((m.action == 'msg') && (m.type == 'getclip')); }
            }, function (err, msg) {
                if (err != null) { func(err); return; }
                func(null, { nodeid: node._id, text: (msg.data != null) ? msg.data : '' });
            });
        });
    }

    function toolSetClipboard(ctx, args, func) {
        if (typeof args.text != 'string') { func('Text is required'); return; }
        withNode(ctx, args, func, function (node, rights) {
            if (ctx.domain.clipboardset == false) { func('Writing the clipboard is disabled on this server'); return; }
            if (hasRemoteControl(rights) == false) { func('Access denied'); return; }
            agentRequest(ctx, node, { action: 'msg', type: 'setclip', data: args.text }, {
                match: function (m) { return ((m.action == 'msg') && (m.type == 'setclip')); }
            }, function (err, msg) {
                if (err != null) { func(err); return; }
                func(null, { nodeid: node._id, set: (msg.success === true), length: args.text.length });
            });
        });
    }

    function toolOpenUrl(ctx, args, func) {
        if ((typeof args.url != 'string') || (/^https?:\/\//i.test(args.url) == false)) { func('A http or https URL is required'); return; }
        if (/[\r\n"]/.test(args.url)) { func('Invalid URL'); return; } // Never let a URL break out of the console command line
        withNode(ctx, args, func, function (node, rights) {
            consoleCommand(ctx, node, rights, 'openurl "' + args.url + '"', null, function (err, text) {
                if (err != null) { func(err); return; }
                func(null, { nodeid: node._id, result: text });
            });
        });
    }

    return obj;
};
