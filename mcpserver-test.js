// Tests for mcpserver.js. Uses only Node built-ins: the MeshCentral internals the MCP
// server touches are stubbed, and express req/res are shimmed, so this runs with no
// node_modules present.
//
//   node mcpserver-test.js

const assert = require('assert');

var failures = 0, checks = 0;
function check(name, cond, detail) {
    checks++;
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
    if (!cond) { failures++; }
}

// ---- stubbed MeshCentral -------------------------------------------------

const USER_ADMIN = { _id: 'user//admin', name: 'admin', siteadmin: 0xFFFFFFFF };
const USER_LIMITED = { _id: 'user//limited', name: 'limited', siteadmin: 0 };
const USER_LOCKED = { _id: 'user//locked', name: 'locked', siteadmin: 32 };

const NODES = {
    'node//win1': { _id: 'node//win1', name: 'Windows Box', meshid: 'mesh//a', osdesc: 'Windows 11' },
    'node//lin1': { _id: 'node//lin1', name: 'Linux Box', meshid: 'mesh//a', osdesc: 'Ubuntu 24.04' },
    'node//other': { _id: 'node//other', name: 'Not Yours', meshid: 'mesh//b', osdesc: 'Windows 10' }
};

// rights[userid][meshid]
const RIGHTS = {
    'user//admin': { 'mesh//a': 0xFFFFFFFF, 'mesh//b': 0xFFFFFFFF },
    'user//limited': { 'mesh//a': 0x00000108 }  // REMOTECONTROL | REMOTEVIEWONLY
};

function makeParent(mcpConfig) {
    const parent = {
        users: { 'user//admin': USER_ADMIN, 'user//limited': USER_LIMITED, 'user//locked': USER_LOCKED },
        desktoprelays: {},
        db: {
            Get: function (id, func) { func(null, NODES[id] ? [NODES[id]] : []); },
            GetAllTypeNoTypeFieldMeshFiltered: function (links, extra, domainid, type, id, skip, limit, func) {
                var out = [];
                for (var i in NODES) { if (links.indexOf(NODES[i].meshid) >= 0) { out.push(NODES[i]); } }
                func(null, out);
            }
        },
        GetNodeRights: function (user, meshid, nodeid) {
            if (typeof user == 'string') { user = parent.users[user]; }
            if (user == null) { return 0; }
            const r = RIGHTS[user._id];
            return (r && r[meshid]) ? r[meshid] : 0;
        },
        GetAllMeshWithRights: function (user) {
            const r = RIGHTS[user._id] || {};
            var out = [];
            for (var m in r) { out.push({ _id: m, name: (m == 'mesh//a') ? 'Group A' : 'Group B' }); }
            return out;
        },
        authenticate: function (name, pass, domain, func) {
            // Mirrors webserver.authenticate: login tokens are ordinary credentials.
            if ((name == '~t:token1') && (pass == 'secret')) { func(null, 'user//admin'); return; }
            if ((name == '~t:token2') && (pass == 'secret')) { func(null, 'user//limited'); return; }
            if ((name == '~t:locked') && (pass == 'secret')) { func(null, 'user//locked'); return; }
            func(new Error('invalid'));
        },
        wsagents: {},
        wssessions2: {},
        CreateNodeDispatchTargets: function () { return []; },
        parent: {
            currentVer: '1.2.5',
            multiServer: null,
            DispatchEvent: function () { EVENTS.push(Array.prototype.slice.call(arguments)[2]); },
            crypto: require('crypto'),
            debug: function () { },
            GetConnectivityState: function (nodeid) { return (nodeid == 'node//win1') ? { connectivity: 1 } : null; },
            config: { settings: { mcp: mcpConfig || { enabled: true } } }
        }
    };
    return parent;
}

var EVENTS = [];

// Stands in for a connected MeshAgent. Behaviour is modelled on agents/meshcore.js:
// runcommands echoes back sessionid and responseid, console replies carry sessionid only.
function attachAgent(parent, nodeid, behaviour) {
    parent.wsagents[nodeid] = {
        send: function (str) {
            const cmd = JSON.parse(str);
            function reply(msg, delay) {
                setTimeout(function () {
                    const sess = parent.wssessions2[cmd.sessionid];
                    if (sess != null) { sess.send(JSON.stringify(msg)); }
                }, delay || 1);
            }
            behaviour(cmd, reply);
        }
    };
}

// ---- express req/res shims ----------------------------------------------

function makeRes(done) {
    const res = {
        statusCode: 200, headers: {}, body: null, finished: false,
        set: function (k, v) { if (typeof k == 'object') { for (var i in k) { res.headers[i.toLowerCase()] = k[i]; } } else { res.headers[k.toLowerCase()] = v; } return res; },
        status: function (c) { res.statusCode = c; return res; },
        send: function (b) { res.body = b; res.finished = true; done(res); return res; },
        sendStatus: function (c) { res.statusCode = c; res.finished = true; done(res); return res; }
    };
    return res;
}

function post(server, body, opts, func) {
    opts = opts || {};
    const req = {
        method: opts.method || 'POST',
        headers: Object.assign({ authorization: 'Basic ' + Buffer.from(opts.auth || '~t:token1:secret').toString('base64') }, opts.headers || {}),
        body: body,
        clientIp: '127.0.0.1'
    };
    if (opts.noAuth) { delete req.headers.authorization; }
    server.handleRequest(req, makeRes(function (res) {
        var parsed = null;
        try { parsed = JSON.parse(res.body); } catch (ex) { }
        func(res, parsed);
    }), { id: '' });
}

function rpc(method, params, id) { return { jsonrpc: '2.0', id: (id === undefined) ? 1 : id, method: method, params: params }; }

// ---- tests ---------------------------------------------------------------

function run(tests, done) {
    var i = 0;
    function next() { if (i >= tests.length) { done(); return; } tests[i++](next); }
    next();
}

const server = require('./mcpserver.js').CreateMcpServer(makeParent({ enabled: true }));

run([
    function (next) {
        console.log('\n1. authentication');
        post(server, rpc('initialize', {}), { noAuth: true }, function (res, body) {
            check('missing auth rejected with 401', res.statusCode === 401, 'got ' + res.statusCode);
            check('WWW-Authenticate offered', typeof res.headers['www-authenticate'] === 'string');
            post(server, rpc('initialize', {}), { auth: '~t:token1:wrongpass' }, function (res2) {
                check('bad password rejected', res2.statusCode === 401, 'got ' + res2.statusCode);
                post(server, rpc('initialize', {}), { auth: '~t:locked:secret' }, function (res3) {
                    check('locked account rejected', res3.statusCode === 401, 'got ' + res3.statusCode);
                    next();
                });
            });
        });
    },
    function (next) {
        console.log('\n2. initialize handshake');
        post(server, rpc('initialize', { protocolVersion: '2025-06-18' }), {}, function (res, body) {
            check('200 OK', res.statusCode === 200, 'got ' + res.statusCode);
            check('session id issued', typeof res.headers['mcp-session-id'] === 'string');
            check('protocol version echoed', body.result.protocolVersion === '2025-06-18', body.result.protocolVersion);
            check('tools capability advertised', body.result.capabilities.tools != null);
            check('serverInfo present', body.result.serverInfo.name === 'meshcentral');
            check('jsonrpc envelope', body.jsonrpc === '2.0' && body.id === 1);
            global.SESSION = res.headers['mcp-session-id'];
            next();
        });
    },
    function (next) {
        console.log('\n3. unknown client protocol version falls back to ours');
        post(server, rpc('initialize', { protocolVersion: '1999-01-01' }), {}, function (res, body) {
            check('server offers a supported version', body.result.protocolVersion === '2025-06-18', body.result.protocolVersion);
            next();
        });
    },
    function (next) {
        console.log('\n4. notifications get 202 and no body');
        post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'mcp-session-id': global.SESSION } }, function (res) {
            check('202 Accepted', res.statusCode === 202, 'got ' + res.statusCode);
            check('no body', !res.body);
            next();
        });
    },
    function (next) {
        console.log('\n5. tools/list');
        post(server, rpc('tools/list', {}), { headers: { 'mcp-session-id': global.SESSION } }, function (res, body) {
            const names = body.result.tools.map(function (t) { return t.name; });
            check('list_devices advertised', names.indexOf('list_devices') >= 0, names.join(','));
            check('get_screen_info advertised', names.indexOf('get_screen_info') >= 0);
            check('every tool has an inputSchema', body.result.tools.every(function (t) { return t.inputSchema && t.inputSchema.type === 'object'; }));
            check('every tool has a description', body.result.tools.every(function (t) { return typeof t.description === 'string' && t.description.length > 0; }));
            next();
        });
    },
    function (next) {
        console.log('\n6. list_devices reflects the caller\'s rights');
        post(server, rpc('tools/call', { name: 'list_devices', arguments: {} }), { headers: { 'mcp-session-id': global.SESSION } }, function (res, body) {
            const payload = JSON.parse(body.result.content[0].text);
            check('admin sees all 3 devices', payload.count === 3, 'got ' + payload.count);
            check('online state resolved', payload.devices.find(function (d) { return d.nodeid === 'node//win1'; }).online === true);
            check('offline device marked offline', payload.devices.find(function (d) { return d.nodeid === 'node//lin1'; }).online === false);
            check('admin can control desktop', payload.devices[0].canControlDesktop === true);

            // A user with rights on only one group must not see the other group's device.
            post(server, rpc('tools/call', { name: 'list_devices', arguments: {} }), { auth: '~t:token2:secret' }, function (res2, body2) {
                const p2 = JSON.parse(body2.result.content[0].text);
                check('limited user sees only their group', p2.count === 2, 'got ' + p2.count);
                check('other group device not listed', !p2.devices.some(function (d) { return d.nodeid === 'node//other'; }));
                check('view-only flag surfaced', p2.devices[0].viewOnly === true);
                next();
            });
        });
    },
    function (next) {
        console.log('\n7. list_devices filters');
        post(server, rpc('tools/call', { name: 'list_devices', arguments: { onlineOnly: true } }), { headers: { 'mcp-session-id': global.SESSION } }, function (res, body) {
            const payload = JSON.parse(body.result.content[0].text);
            check('onlineOnly returns just the online device', payload.count === 1 && payload.devices[0].nodeid === 'node//win1', 'got ' + payload.count);
            post(server, rpc('tools/call', { name: 'list_devices', arguments: { group: 'Group B' } }), { headers: { 'mcp-session-id': global.SESSION } }, function (res2, body2) {
                const p2 = JSON.parse(body2.result.content[0].text);
                check('group filter applied', p2.count === 1 && p2.devices[0].nodeid === 'node//other', 'got ' + p2.count);
                next();
            });
        });
    },
    function (next) {
        console.log('\n8. get_screen_info');
        post(server, rpc('tools/call', { name: 'get_screen_info', arguments: { nodeid: 'node//win1' } }), { headers: { 'mcp-session-id': global.SESSION } }, function (res, body) {
            const payload = JSON.parse(body.result.content[0].text);
            check('reports no active session', payload.activeSession === false);
            check('explains why rather than erroring', typeof payload.note === 'string');

            // With a multiplexor present the resolution comes from it.
            server.parent.desktoprelays['node//win1'] = { width: 1920, height: 1080, viewers: [{}, {}] };
            post(server, rpc('tools/call', { name: 'get_screen_info', arguments: { nodeid: 'node//win1' } }), { headers: { 'mcp-session-id': global.SESSION } }, function (res2, body2) {
                const p2 = JSON.parse(body2.result.content[0].text);
                check('resolution read from multiplexor', p2.width === 1920 && p2.height === 1080);
                check('viewer count reported', p2.viewers === 2);
                delete server.parent.desktoprelays['node//win1'];
                next();
            });
        });
    },
    function (next) {
        console.log('\n9. per-call rights are enforced, not just at listing');
        // token2 has no rights at all on mesh//b, so the device must be refused.
        post(server, rpc('tools/call', { name: 'get_screen_info', arguments: { nodeid: 'node//other' } }), { auth: '~t:token2:secret' }, function (res, body) {
            check('access denied surfaced as isError', body.result.isError === true);
            check('denial message returned', /Access denied|not found/.test(body.result.content[0].text), body.result.content[0].text);
            post(server, rpc('tools/call', { name: 'get_screen_info', arguments: { nodeid: 'node//nonexistent' } }), {}, function (res2, body2) {
                check('unknown device is an error result', body2.result.isError === true);
                next();
            });
        });
    },
    function (next) {
        console.log('\n10. short device ids are completed, cross-domain is refused');
        post(server, rpc('tools/call', { name: 'get_screen_info', arguments: { nodeid: 'win1' } }), { headers: { 'mcp-session-id': global.SESSION } }, function (res, body) {
            const payload = JSON.parse(body.result.content[0].text);
            check('bare id resolved to node//win1', payload.nodeid === 'node//win1', body.result.content[0].text);
            post(server, rpc('tools/call', { name: 'get_screen_info', arguments: { nodeid: 'node/otherdomain/win1' } }), {}, function (res2, body2) {
                check('cross-domain id refused', body2.result.isError === true);
                next();
            });
        });
    },
    function (next) {
        console.log('\n11. JSON-RPC error handling');
        post(server, rpc('no/such/method', {}), { headers: { 'mcp-session-id': global.SESSION } }, function (res, body) {
            check('method not found -> -32601', body.error.code === -32601, JSON.stringify(body.error));
            post(server, rpc('tools/call', { name: 'no_such_tool', arguments: {} }), {}, function (res2, body2) {
                check('unknown tool -> invalid params', body2.error.code === -32602, JSON.stringify(body2.error));
                post(server, { jsonrpc: '1.0', id: 9, method: 'ping' }, {}, function (res3, body3) {
                    check('wrong jsonrpc version -> invalid request', body3.error.code === -32600);
                    post(server, { jsonrpc: '2.0', method: 'notifications/unknown' }, {}, function (res4) {
                        check('unknown notification ignored with 202', res4.statusCode === 202, 'got ' + res4.statusCode);
                        next();
                    });
                });
            });
        });
    },
    function (next) {
        console.log('\n12. batches');
        post(server, [rpc('ping', {}, 1), rpc('tools/list', {}, 2)], { headers: { 'mcp-session-id': global.SESSION } }, function (res, body) {
            check('array response for array request', Array.isArray(body), typeof body);
            check('both replies returned', body.length === 2, 'got ' + (body && body.length));
            next();
        });
    },
    function (next) {
        console.log('\n13. session handling');
        check('session id is opaque hex', /^[0-9a-f]{32}$/.test(global.SESSION), global.SESSION);
        // A session must never be handed to a different account.
        post(server, rpc('ping', {}), { auth: '~t:token2:secret', headers: { 'mcp-session-id': global.SESSION } }, function (res) {
            check('other account gets a fresh session', res.headers['mcp-session-id'] !== global.SESSION);
            // Unknown session ids are treated as expired rather than fatal.
            post(server, rpc('ping', {}), { headers: { 'mcp-session-id': 'deadbeef'.repeat(4) } }, function (res2, body2) {
                check('unknown session recovers', res2.statusCode === 200 && body2.result != null);
                next();
            });
        });
    },
    function (next) {
        console.log('\n14. HTTP methods');
        post(server, null, { method: 'GET' }, function (res) {
            check('GET declined with 405', res.statusCode === 405, 'got ' + res.statusCode);
            check('Allow header set', res.headers['allow'] === 'POST, DELETE', res.headers['allow']);
            post(server, null, { method: 'DELETE', headers: { 'mcp-session-id': global.SESSION } }, function (res2) {
                check('DELETE ends session with 204', res2.statusCode === 204, 'got ' + res2.statusCode);
                next();
            });
        });
    },
    function (next) {
        console.log('\n15. input and shell tools are hidden unless enabled');
        const s2 = require('./mcpserver.js').CreateMcpServer(makeParent({ enabled: true }));
        check('allowInput defaults off', s2.allowInput === false);
        check('allowShell defaults off', s2.allowShell === false);
        const s3 = require('./mcpserver.js').CreateMcpServer(makeParent({ enabled: true, allowInput: true, allowShell: true }));
        check('allowInput honored when set', s3.allowInput === true);
        check('allowShell honored when set', s3.allowShell === true);
        next();
    },
    function (next) {
        console.log('\n16. shell tools are hidden unless allowShell is set');
        post(server, rpc('tools/list', {}), {}, function (res, body) {
            const names = body.result.tools.map(function (t) { return t.name; });
            check('run_script hidden', names.indexOf('run_script') < 0, names.join(','));
            check('agent_console hidden', names.indexOf('agent_console') < 0);
            check('clipboard tools still visible', names.indexOf('get_clipboard') >= 0);
            post(server, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//win1', script: 'x' } }), {}, function (res2, body2) {
                check('calling a hidden tool is refused', body2.error != null && body2.error.code === -32602, JSON.stringify(body2));
                // A client that never echoes the session header must keep working: the
                // per-account cap evicts the oldest session instead of locking it out.
                var adminSessions = 0;
                for (var k in server.sessions) { if (server.sessions[k].userid === 'user//admin') { adminSessions++; } }
                check('per-account session cap evicts rather than refusing', adminSessions <= 8, adminSessions + ' admin sessions');
                next();
            });
        });
    },
    function (next) {
        console.log('\n17. run_script round trip');
        const p = makeParent({ enabled: true, allowShell: true });
        p.desktoprelays = {};
        NODES['node//win1'].agent = { id: 4 };   // Windows agent
        attachAgent(p, 'node//win1', function (cmd, reply) {
            check('sessionid carried to the agent', typeof cmd.sessionid === 'string' && cmd.sessionid.indexOf('/mcp') > 0, cmd.sessionid);
            check('reply requested', cmd.reply === true);
            check('runs in the user session by default', cmd.runAsUser === 2, 'got ' + cmd.runAsUser);
            check('powershell chosen for a Windows agent', cmd.type === 2, 'got ' + cmd.type);
            reply({ action: 'msg', type: 'runcommands', result: 'hello from device', responseid: cmd.responseid });
        });
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        post(sv, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//win1', script: 'Get-Date' } }), {}, function (res, body) {
            const payload = JSON.parse(body.result.content[0].text);
            check('output returned to the caller', payload.output === 'hello from device', JSON.stringify(payload));
            check('ranAs reported', payload.ranAs === 'user');
            check('audit event dispatched', EVENTS.some(function (e) { return e && e.action === 'runcommands'; }));
            check('pseudo-session cleaned up', Object.keys(p.wssessions2).length === 0, JSON.stringify(Object.keys(p.wssessions2)));
            next();
        });
    },
    function (next) {
        console.log('\n18. concurrent calls do not cross-talk (upstream #8080)');
        const p = makeParent({ enabled: true, allowShell: true });
        NODES['node//win1'].agent = { id: 4 };
        NODES['node//lin1'].agent = { id: 6 };   // Linux agent
        // Each device answers with its own name, and the slower one replies first.
        attachAgent(p, 'node//win1', function (cmd, reply) { reply({ action: 'msg', type: 'runcommands', result: 'WIN', responseid: cmd.responseid }, 40); });
        attachAgent(p, 'node//lin1', function (cmd, reply) { reply({ action: 'msg', type: 'runcommands', result: 'LIN', responseid: cmd.responseid }, 5); });
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        var got = {};
        var pending = 2;
        function done(which) { return function (res, body) { got[which] = JSON.parse(body.result.content[0].text).output; if (--pending === 0) {
            check('windows call got its own output', got.win === 'WIN', JSON.stringify(got));
            check('linux call got its own output', got.lin === 'LIN', JSON.stringify(got));
            check('all pseudo-sessions cleaned up', Object.keys(p.wssessions2).length === 0);
            next();
        } }; }
        post(sv, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//win1', script: 'a', type: 'powershell' } }), {}, done('win'));
        post(sv, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//lin1', script: 'b', type: 'shell' } }), {}, done('lin'));
    },
    function (next) {
        console.log('\n19. stale and mismatched replies are ignored');
        const p = makeParent({ enabled: true, allowShell: true });
        NODES['node//win1'].agent = { id: 4 };
        attachAgent(p, 'node//win1', function (cmd, reply) {
            reply({ action: 'msg', type: 'runcommands', result: 'WRONG', responseid: 'someone-elses-id' }, 1);
            reply({ action: 'msg', type: 'console', value: 'unrelated chatter' }, 2);
            reply({ action: 'msg', type: 'runcommands', result: 'RIGHT', responseid: cmd.responseid }, 10);
        });
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        post(sv, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//win1', script: 'a' } }), {}, function (res, body) {
            const payload = JSON.parse(body.result.content[0].text);
            check('only the matching responseid is accepted', payload.output === 'RIGHT', JSON.stringify(payload));
            next();
        });
    },
    function (next) {
        console.log('\n20. interpreter mismatch is refused with a reason');
        const p = makeParent({ enabled: true, allowShell: true });
        NODES['node//win1'].agent = { id: 4 };
        NODES['node//lin1'].agent = { id: 6 };
        attachAgent(p, 'node//win1', function () { });
        attachAgent(p, 'node//lin1', function () { });
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        post(sv, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//win1', script: 'x', type: 'shell' } }), {}, function (res, body) {
            check('shell on Windows refused', body.result.isError === true && /Windows device/.test(body.result.content[0].text), body.result.content[0].text);
            post(sv, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//lin1', script: 'x', type: 'powershell' } }), {}, function (res2, body2) {
                check('powershell on Linux refused', body2.result.isError === true && /not a Windows device/.test(body2.result.content[0].text), body2.result.content[0].text);
                next();
            });
        });
    },
    function (next) {
        console.log('\n21. disconnected device and timeout');
        const p = makeParent({ enabled: true, allowShell: true, scriptTimeout: 1 });
        NODES['node//win1'].agent = { id: 4 };
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        post(sv, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//win1', script: 'x' } }), {}, function (res, body) {
            check('offline device reported clearly', body.result.isError === true && /not connected/.test(body.result.content[0].text), body.result.content[0].text);
            // Now attach an agent that never answers, and confirm the call gives up.
            attachAgent(p, 'node//win1', function () { });
            post(sv, rpc('tools/call', { name: 'run_script', arguments: { nodeid: 'node//win1', script: 'x' } }), {}, function (res2, body2) {
                check('silent agent times out', body2.result.isError === true && /Timed out/.test(body2.result.content[0].text), body2.result.content[0].text);
                check('session cleaned up after timeout', Object.keys(p.wssessions2).length === 0);
                next();
            });
        });
    },
    function (next) {
        console.log('\n22. agent console output is collected');
        const p = makeParent({ enabled: true, allowShell: true });
        NODES['node//win1'].agent = { id: 4 };
        attachAgent(p, 'node//win1', function (cmd, reply) {
            check('console rights passed to the agent', cmd.rights === 0xFFFFFFFF, '' + cmd.rights);
            reply({ action: 'msg', type: 'console', value: 'line one' }, 1);
            reply({ action: 'msg', type: 'console', value: 'line two' }, 5);
        });
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        post(sv, rpc('tools/call', { name: 'agent_console', arguments: { nodeid: 'node//win1', command: 'ps' } }), {}, function (res, body) {
            const payload = JSON.parse(body.result.content[0].text);
            check('multi-line output joined', payload.output === 'line one\nline two', JSON.stringify(payload.output));
            next();
        });
    },
    function (next) {
        console.log('\n23. console rights are required');
        const p = makeParent({ enabled: true, allowShell: true });
        NODES['node//win1'].agent = { id: 4 };
        attachAgent(p, 'node//win1', function () { });
        // token2 holds REMOTECONTROL|REMOTEVIEWONLY on mesh//a but not AGENTCONSOLE.
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        post(sv, rpc('tools/call', { name: 'agent_console', arguments: { nodeid: 'node//win1', command: 'ps' } }), { auth: '~t:token2:secret' }, function (res, body) {
            check('console refused without AGENTCONSOLE', body.result.isError === true && /Access denied/.test(body.result.content[0].text), body.result.content[0].text);
            next();
        });
    },
    function (next) {
        console.log('\n24. clipboard');
        const p = makeParent({ enabled: true });
        NODES['node//win1'].agent = { id: 4 };
        attachAgent(p, 'node//win1', function (cmd, reply) {
            if (cmd.type === 'getclip') { reply({ action: 'msg', type: 'getclip', data: 'clipboard contents' }); }
            if (cmd.type === 'setclip') { check('text delivered to the agent', cmd.data === 'pasted text', cmd.data); reply({ action: 'msg', type: 'setclip', success: true }); }
        });
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        post(sv, rpc('tools/call', { name: 'get_clipboard', arguments: { nodeid: 'node//win1' } }), {}, function (res, body) {
            check('clipboard read', JSON.parse(body.result.content[0].text).text === 'clipboard contents');
            post(sv, rpc('tools/call', { name: 'set_clipboard', arguments: { nodeid: 'node//win1', text: 'pasted text' } }), {}, function (res2, body2) {
                check('clipboard written', JSON.parse(body2.result.content[0].text).set === true);
                next();
            });
        });
    },
    function (next) {
        console.log('\n25. server clipboard policy is honoured');
        const p = makeParent({ enabled: true });
        NODES['node//win1'].agent = { id: 4 };
        attachAgent(p, 'node//win1', function (cmd, reply) { reply({ action: 'msg', type: 'getclip', data: 'secret' }); });
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        const req = {
            method: 'POST',
            headers: { authorization: 'Basic ' + Buffer.from('~t:token1:secret').toString('base64') },
            body: rpc('tools/call', { name: 'get_clipboard', arguments: { nodeid: 'node//win1' } }),
            clientIp: '127.0.0.1'
        };
        sv.handleRequest(req, makeRes(function (res) {
            const body = JSON.parse(res.body);
            check('clipboardget=false refuses the read', body.result.isError === true && /disabled/.test(body.result.content[0].text), body.result.content[0].text);
            next();
        }), { id: '', clipboardget: false });
    },
    function (next) {
        console.log('\n26. open_url rejects anything that could break the command line');
        const p = makeParent({ enabled: true, allowShell: true });
        NODES['node//win1'].agent = { id: 4 };
        attachAgent(p, 'node//win1', function (cmd, reply) { reply({ action: 'msg', type: 'console', value: 'Success.' }); });
        const sv = require('./mcpserver.js').CreateMcpServer(p);
        post(sv, rpc('tools/call', { name: 'open_url', arguments: { nodeid: 'node//win1', url: 'file:///etc/passwd' } }), {}, function (res, body) {
            check('non-http scheme refused', body.result.isError === true, body.result.content[0].text);
            post(sv, rpc('tools/call', { name: 'open_url', arguments: { nodeid: 'node//win1', url: 'https://x.test/\" evil' } }), {}, function (res2, body2) {
                check('quote injection refused', body2.result.isError === true, body2.result.content[0].text);
                post(sv, rpc('tools/call', { name: 'open_url', arguments: { nodeid: 'node//win1', url: 'https://example.test/page' } }), {}, function (res3, body3) {
                    check('valid URL accepted', body3.result.isError !== true, body3.result.content[0].text);
                    next();
                });
            });
        });
    }
], function () {
    console.log('\n' + checks + ' checks, ' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'));
    process.exit(failures === 0 ? 0 : 1);
});
