/**
* @description MeshCentral Model Context Protocol (MCP) server
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

// Serves the Model Context Protocol over Streamable HTTP at /mcp.ashx, letting an MCP
// client (Claude Code, Claude Desktop, ...) inspect and act on managed devices.
//
// The JSON-RPC and session layer is implemented here rather than with
// @modelcontextprotocol/sdk on purpose. That package is ESM-only and pulls in 91
// transitive packages against this project's 18 direct dependencies, and require() of an
// ESM package only works from Node 20.19 onward while package.json allows >=20.0.0. The
// subset of the protocol needed for tools is small, so it is carried here with no
// dependency. It is verified against the official SDK client in the test harness.

const MESHRIGHT_REMOTECONTROL = 0x00000008;
const MESHRIGHT_AGENTCONSOLE = 0x00000010;
const MESHRIGHT_REMOTEVIEWONLY = 0x00000100;
const MESHRIGHT_NODESKTOP = 0x00010000;
const MESHRIGHT_FULL = 0xFFFFFFFF;

// Full rights means full rights: the restriction bits (NODESKTOP, REMOTEVIEWONLY) are
// part of that mask, so testing them directly would deny an administrator everything.
// The desktop multiplexor special-cases 0xFFFFFFFF the same way before checking
// REMOTEVIEWONLY, see meshdesktopmultiplex.js.
function hasDesktopAccess(rights) {
    if (rights == MESHRIGHT_FULL) { return true; }
    return (((rights & MESHRIGHT_REMOTECONTROL) != 0) && ((rights & MESHRIGHT_NODESKTOP) == 0));
}
function isViewOnly(rights) {
    if (rights == MESHRIGHT_FULL) { return false; }
    return ((rights & MESHRIGHT_REMOTEVIEWONLY) != 0);
}
function canRunCommands(rights) {
    if (rights == MESHRIGHT_FULL) { return true; }
    return ((rights & MESHRIGHT_AGENTCONSOLE) != 0);
}

// Protocol versions this server understands, newest first.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// JSON-RPC 2.0 error codes.
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

module.exports.CreateMcpServer = function (parent) {
    var obj = {};
    obj.parent = parent;                    // The web server
    obj.sessions = {};                      // mcp-session-id --> session state
    obj.sessionCount = 0;

    const config = ((parent.parent.config.settings != null) && (typeof parent.parent.config.settings.mcp == 'object')) ? parent.parent.config.settings.mcp : {};
    obj.allowInput = (config.allowInput === true);
    obj.allowShell = (config.allowShell === true);
    const sessionIdleTimeout = (typeof config.sessionIdleTimeout == 'number') ? (config.sessionIdleTimeout * 1000) : 600000;
    const maxSessionsPerUser = (typeof config.maxSessionsPerUser == 'number') ? config.maxSessionsPerUser : 8;

    // Drop sessions that have gone quiet. A session holds only a userid, so this is
    // bookkeeping rather than resource release, but it keeps the table bounded.
    function expireSessions() {
        const now = Date.now();
        for (var i in obj.sessions) {
            if ((now - obj.sessions[i].lastSeen) > sessionIdleTimeout) { delete obj.sessions[i]; obj.sessionCount--; }
        }
    }

    //
    // Tool registry. Each tool declares the MCP schema it advertises and a handler.
    // Handlers receive (ctx, args, func) where ctx has { user, domain } and func is
    // called with (err, result). The result is turned into MCP content by callTool().
    //
    const tools = {
        'list_devices': {
            description: 'List the devices this account can access, with their online state. Use this first to find a device id for the other tools.',
            inputSchema: {
                type: 'object',
                properties: {
                    onlineOnly: { type: 'boolean', description: 'Only return devices that are currently connected.' },
                    group: { type: 'string', description: 'Only return devices in the device group with this name.' }
                }
            },
            handler: toolListDevices
        },
        'get_screen_info': {
            description: 'Get the current screen resolution of a device, if a remote desktop session is already active for it. Does not connect to the device.',
            inputSchema: {
                type: 'object',
                properties: {
                    nodeid: { type: 'string', description: 'Device id, as returned by list_devices.' }
                },
                required: ['nodeid']
            },
            handler: toolGetScreenInfo
        }
    };

    // Complete a possibly short device id into a full "node/domain/id" identifier.
    function fullNodeId(nodeid, domain) {
        if (typeof nodeid != 'string') { return null; }
        if (nodeid.indexOf('/') == -1) { return 'node/' + domain.id + '/' + nodeid; }
        return nodeid;
    }

    // Resolve a device and the calling user's rights on it, refusing anything the user
    // cannot see. Every tool that names a device goes through here.
    function getNodeWithRights(ctx, nodeid, func) {
        const id = fullNodeId(nodeid, ctx.domain);
        if (id == null) { func('Invalid device id'); return; }
        if (id.split('/')[1] != ctx.domain.id) { func('Invalid device id'); return; } // No cross-domain access
        parent.db.Get(id, function (err, docs) {
            if ((err != null) || (docs == null) || (docs.length != 1)) { func('Device not found'); return; }
            const node = docs[0];
            const rights = parent.GetNodeRights(ctx.user, node.meshid, node._id);
            if (rights == 0) { func('Access denied'); return; }
            func(null, node, rights);
        });
    }

    function toolListDevices(ctx, args, func) {
        // Only device groups this user holds rights on, so the db query can never return
        // a device the caller cannot see.
        const meshes = parent.GetAllMeshWithRights(ctx.user);
        var links = [];
        for (var i in meshes) {
            if ((typeof args.group == 'string') && (meshes[i].name != args.group)) { continue; }
            links.push(meshes[i]._id);
        }
        if (links.length == 0) { func(null, { devices: [], count: 0 }); return; }

        parent.db.GetAllTypeNoTypeFieldMeshFiltered(links, null, ctx.domain.id, 'node', null, 0, 0, function (err, docs) {
            if (err != null) { func('Unable to list devices'); return; }
            if (docs == null) { docs = []; }
            var devices = [];
            for (var i in docs) {
                const node = docs[i];
                const state = parent.parent.GetConnectivityState(node._id);
                const online = ((state != null) && (state.connectivity != null) && ((state.connectivity & 1) != 0));
                if ((args.onlineOnly === true) && (online == false)) { continue; }
                const rights = parent.GetNodeRights(ctx.user, node.meshid, node._id);
                devices.push({
                    nodeid: node._id,
                    name: node.name,
                    online: online,
                    os: (node.osdesc != null) ? node.osdesc : null,
                    groupid: node.meshid,
                    // Surfaced so a model can tell why a later call may be refused.
                    canControlDesktop: hasDesktopAccess(rights),
                    viewOnly: isViewOnly(rights),
                    canRunCommands: canRunCommands(rights)
                });
            }
            func(null, { devices: devices, count: devices.length });
        });
    }

    function toolGetScreenInfo(ctx, args, func) {
        getNodeWithRights(ctx, args.nodeid, function (err, node, rights) {
            if (err != null) { func(err); return; }
            // Desktop access is REMOTECONTROL without NODESKTOP. There is no separate
            // "view" grant; REMOTEVIEWONLY is a restriction on input, not on viewing.
            if (hasDesktopAccess(rights) == false) { func('Access denied'); return; }

            const relay = parent.desktoprelays[node._id];
            if ((relay == null) || (typeof relay != 'object') || (relay.width == null) || (relay.width == 0)) {
                func(null, { nodeid: node._id, name: node.name, activeSession: false, note: 'No remote desktop session is currently active for this device, so its resolution is not known to the server.' });
                return;
            }
            func(null, {
                nodeid: node._id,
                name: node.name,
                activeSession: true,
                width: relay.width,
                height: relay.height,
                viewers: (relay.viewers != null) ? relay.viewers.length : 0
            });
        });
    }

    //
    // Authentication. Login tokens are ordinary credentials to obj.authenticate(), which
    // already understands the "~t:" prefix, so no separate token path is needed here.
    //
    function authenticate(req, domain, func) {
        const header = req.headers['authorization'];
        if (typeof header != 'string') { func('Missing Authorization header'); return; }
        const parts = header.split(' ');
        if (parts.length != 2) { func('Invalid Authorization header'); return; }
        const scheme = parts[0].toLowerCase();

        var decoded = null;
        if (scheme == 'basic') {
            try { decoded = Buffer.from(parts[1], 'base64').toString('utf8'); } catch (ex) { }
        } else if (scheme == 'bearer') {
            // Accepted because a login token username contains a colon, which some HTTP
            // clients will not accept in the Basic userinfo field.
            decoded = parts[1];
        } else { func('Expected Basic or Bearer authorization'); return; }
        if (decoded == null) { func('Invalid authorization encoding'); return; }

        // A login token username is '~t:' followed by base64 without '+' or '/', so it
        // always holds exactly one colon, at index 2 (meshuser.js createLoginToken).
        // Splitting on the first colon would therefore read the username as '~t'. Split
        // after the prefix instead, which is exact and independent of the password.
        const sep = decoded.startsWith('~t:') ? decoded.indexOf(':', 3) : decoded.indexOf(':');
        if (sep < 0) { func('Invalid authorization format'); return; }
        const username = decoded.substring(0, sep), password = decoded.substring(sep + 1);

        parent.authenticate(username, password, domain, function (err, userid) {
            if ((err != null) || (userid == null)) { func('Invalid credentials'); return; }
            const user = parent.users[userid];
            if (user == null) { func('Invalid credentials'); return; }
            if ((user.siteadmin != null) && (user.siteadmin != 0xFFFFFFFF) && ((user.siteadmin & 32) != 0)) { func('Account locked'); return; }
            func(null, user);
        });
    }

    //
    // JSON-RPC plumbing
    //
    function rpcResult(id, result) { return { jsonrpc: '2.0', id: id, result: result }; }
    function rpcError(id, code, message) { return { jsonrpc: '2.0', id: (id === undefined) ? null : id, error: { code: code, message: message } }; }

    // Turn a tool handler's output into MCP tool content. Errors become an isError
    // result rather than a JSON-RPC error, which is what the spec asks for: the model
    // should see the failure and be able to act on it.
    function toolContent(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
    function toolErrorContent(message) { return { content: [{ type: 'text', text: message }], isError: true }; }

    // Tools the caller is not allowed to use are not advertised at all, so a model never
    // plans around a capability the server will refuse.
    function visibleTools() {
        var out = [];
        for (var name in tools) {
            const t = tools[name];
            if ((t.needsInput === true) && (obj.allowInput == false)) { continue; }
            if ((t.needsShell === true) && (obj.allowShell == false)) { continue; }
            out.push({ name: name, description: t.description, inputSchema: t.inputSchema });
        }
        return out;
    }

    function handleRpc(session, msg, funcRaw) {
        // Guarantees a single reply. An exception raised while the caller is processing
        // our reply would otherwise unwind into the tool try/catch below and reply again.
        var replied = false;
        function func(r) { if (replied) { return; } replied = true; funcRaw(r); }

        if ((msg == null) || (typeof msg != 'object') || (msg.jsonrpc != '2.0') || (typeof msg.method != 'string')) {
            func(rpcError(msg ? msg.id : null, JSONRPC_INVALID_REQUEST, 'Invalid JSON-RPC request'));
            return;
        }
        const isNotification = (msg.id === undefined) || (msg.id === null);
        const params = (msg.params != null) ? msg.params : {};

        switch (msg.method) {
            case 'initialize': {
                // Echo the client's protocol version when we support it, otherwise offer ours.
                var version = SUPPORTED_PROTOCOL_VERSIONS[0];
                if ((typeof params.protocolVersion == 'string') && (SUPPORTED_PROTOCOL_VERSIONS.indexOf(params.protocolVersion) >= 0)) { version = params.protocolVersion; }
                session.protocolVersion = version;
                session.initialized = true;
                func(rpcResult(msg.id, {
                    protocolVersion: version,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: 'meshcentral', version: parent.parent.currentVer ? parent.parent.currentVer : '0.0.0' }
                }));
                break;
            }
            case 'notifications/initialized': { func(null); break; }
            case 'ping': { func(rpcResult(msg.id, {})); break; }
            case 'tools/list': { func(rpcResult(msg.id, { tools: visibleTools() })); break; }
            case 'tools/call': {
                const name = params.name;
                const tool = (typeof name == 'string') ? tools[name] : null;
                if (tool == null) { func(rpcError(msg.id, JSONRPC_INVALID_PARAMS, 'Unknown tool: ' + name)); return; }
                if ((tool.needsInput === true) && (obj.allowInput == false)) { func(rpcError(msg.id, JSONRPC_INVALID_PARAMS, 'Unknown tool: ' + name)); return; }
                if ((tool.needsShell === true) && (obj.allowShell == false)) { func(rpcError(msg.id, JSONRPC_INVALID_PARAMS, 'Unknown tool: ' + name)); return; }

                const args = (params.arguments != null) ? params.arguments : {};
                const ctx = { user: parent.users[session.userid], domain: session.domain };
                if (ctx.user == null) { func(rpcError(msg.id, JSONRPC_INTERNAL_ERROR, 'Session user no longer exists')); return; }

                try {
                    tool.handler(ctx, args, function (err, result) {
                        if (isNotification) { func(null); return; }
                        if (err != null) { func(rpcResult(msg.id, toolErrorContent('' + err))); return; }
                        func(rpcResult(msg.id, toolContent(result)));
                    });
                } catch (ex) {
                    // Only reaches here for a synchronous throw inside the handler; the
                    // once-guard keeps a later throw from producing a second reply.
                    func(rpcResult(msg.id, toolErrorContent('Tool failed: ' + ex)));
                }
                break;
            }
            default: {
                if (isNotification) { func(null); return; } // Unknown notifications are ignored, per spec
                func(rpcError(msg.id, JSONRPC_METHOD_NOT_FOUND, 'Method not found: ' + msg.method));
                break;
            }
        }
    }

    //
    // HTTP entry point. Registered by webserver.js for each domain.
    //
    obj.handleRequest = function (req, res, domain) {
        // CORS is intentionally not enabled: this endpoint is for local MCP clients, and
        // allowing browser origins would expose it to any page the user visits.
        if (req.method == 'DELETE') {
            const sid = req.headers['mcp-session-id'];
            if ((typeof sid == 'string') && (obj.sessions[sid] != null)) { delete obj.sessions[sid]; obj.sessionCount--; }
            res.sendStatus(204);
            return;
        }
        if (req.method == 'GET') {
            // The spec allows a server to decline the SSE stream. This server has no
            // server-initiated messages, so there is nothing to stream.
            res.set('Allow', 'POST, DELETE').sendStatus(405);
            return;
        }
        if (req.method != 'POST') { res.set('Allow', 'POST, DELETE').sendStatus(405); return; }

        authenticate(req, domain, function (err, user) {
            if (err != null) {
                res.set('WWW-Authenticate', 'Basic realm="MeshCentral MCP"').status(401).send(JSON.stringify(rpcError(null, JSONRPC_INVALID_REQUEST, err)));
                parent.parent.debug('mcp', 'Authentication failed: ' + err + ' (' + req.clientIp + ')');
                return;
            }

            expireSessions();

            // Resume a session or open one. An unknown session id is treated as expired
            // so the client can recover by initializing again.
            var sessionId = req.headers['mcp-session-id'];
            var session = ((typeof sessionId == 'string') && (obj.sessions[sessionId] != null)) ? obj.sessions[sessionId] : null;
            if ((session != null) && (session.userid != user._id)) { session = null; } // Never hand a session to a different account
            if (session == null) {
                var userSessions = 0;
                for (var i in obj.sessions) { if (obj.sessions[i].userid == user._id) { userSessions++; } }
                if (userSessions >= maxSessionsPerUser) { res.status(429).send(JSON.stringify(rpcError(null, JSONRPC_INVALID_REQUEST, 'Too many MCP sessions for this account'))); return; }
                sessionId = parent.parent.crypto.randomBytes(16).toString('hex');
                session = { id: sessionId, userid: user._id, domain: domain, created: Date.now(), initialized: false };
                obj.sessions[sessionId] = session;
                obj.sessionCount++;
                parent.parent.debug('mcp', 'New session ' + sessionId + ' for ' + user._id + ' (' + req.clientIp + ')');
            }
            session.lastSeen = Date.now();

            const body = req.body;
            if (body == null) { res.status(400).send(JSON.stringify(rpcError(null, JSONRPC_PARSE_ERROR, 'Invalid JSON body'))); return; }

            // A batch is answered with an array; notification-only batches get 202.
            const batch = Array.isArray(body) ? body : [body];
            if (batch.length == 0) { res.status(400).send(JSON.stringify(rpcError(null, JSONRPC_INVALID_REQUEST, 'Empty batch'))); return; }

            var replies = [], pending = batch.length;
            for (var i = 0; i < batch.length; i++) {
                handleRpc(session, batch[i], function (reply) {
                    if (reply != null) { replies.push(reply); }
                    if (--pending > 0) { return; }
                    res.set('Mcp-Session-Id', session.id);
                    if (replies.length == 0) { res.sendStatus(202); return; } // Notifications only
                    res.set('Content-Type', 'application/json').send(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
                });
            }
        });
    };

    return obj;
};
