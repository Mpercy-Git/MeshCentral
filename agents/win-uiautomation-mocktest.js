// Off-Windows harness for agents/modules_meshcore/win-uiautomation.js.
// Stubs _GenericMarshal + user32 so the module's control flow (callback path, sibling
// walk, auto-fallback, UTF-16 decoding, filtering) can be exercised on Linux.
// This proves the module's logic. It does NOT prove the real Win32 FFI.

const Module = require('module');
const origLoad = Module._load;

Object.defineProperty(process, 'platform', { value: 'win32' });

// ---- fake desktop -------------------------------------------------------
const WINDOWS = {
    100: { title: 'Untitled - Notepad', cls: 'Notepad', pid: 4242, visible: 1, iconic: 0, rect: [0, 0, 800, 600] },
    200: { title: 'Calculator', cls: 'ApplicationFrameWindow', pid: 4243, visible: 1, iconic: 1, rect: [10, 10, 410, 610] },
    300: { title: '', cls: 'HiddenHelperWnd', pid: 4244, visible: 1, iconic: 0, rect: [0, 0, 0, 0] },
    400: { title: 'Invisible Thing', cls: 'Ghost', pid: 4245, visible: 0, iconic: 0, rect: [0, 0, 5, 5] },
    500: { title: 'Ünïcødé Wîndow 中文', cls: 'Chrome_WidgetWin_1', pid: 4246, visible: 1, iconic: 0, rect: [-1920, 0, 0, 1080] }
};
const ORDER = [100, 200, 300, 400, 500];


function wideWrite(v, str, maxChars) {
    const buf = v.toBuffer();
    buf.fill(0);
    for (let i = 0; i < Math.min(str.length, maxChars - 1); i++) buf.writeUInt16LE(str.charCodeAt(i), i * 2);
}

const GM = {
    PointerSize: 8,
    CreateVariable: function (arg) {
        const size = (typeof arg === 'number') ? arg : Buffer.byteLength(arg) + 1;
        const buf = Buffer.alloc(size);
        if (typeof arg === 'string') buf.write(arg);
        return { _size: size, toBuffer: () => buf, get String() { return buf.toString().split('\0')[0]; } };
    },
    CreatePointer: function () { const b = Buffer.alloc(8); return { toBuffer: () => b, Deref: () => null }; },
    CreateNativeProxy: function (dll) {
        const p = { _dll: dll, CreateMethod: function (n, alias) { p[alias || n] = (...a) => impl[n](...a); } };
        return p;
    }
};

const impl = {
    GetTopWindow: () => ({ Val: ORDER[0] }),
    GetWindow: (h, cmd) => { const i = ORDER.indexOf(Number(h)); return { Val: (i >= 0 && i + 1 < ORDER.length) ? ORDER[i + 1] : 0 }; },
    GetForegroundWindow: () => ({ Val: 200 }),
    SetForegroundWindow: (h) => ({ Val: 1 }),
    ShowWindow: (h, c) => ({ Val: 1 }),
    IsWindowVisible: (h) => ({ Val: WINDOWS[Number(h)] ? WINDOWS[Number(h)].visible : 0 }),
    IsIconic: (h) => ({ Val: WINDOWS[Number(h)] ? WINDOWS[Number(h)].iconic : 0 }),
    GetWindowTextW: (h, v, max) => { wideWrite(v, WINDOWS[Number(h)].title, max); return { Val: 1 }; },
    GetClassNameW: (h, v, max) => { wideWrite(v, WINDOWS[Number(h)].cls, max); return { Val: 1 }; },
    GetWindowRect: (h, v) => { const r = WINDOWS[Number(h)].rect, b = v.toBuffer(); r.forEach((n, i) => b.writeInt32LE(n, i * 4)); return { Val: 1 }; },
    GetWindowThreadProcessId: (h, v) => { v.toBuffer().writeUInt32LE(WINDOWS[Number(h)].pid, 0); return { Val: 1 }; }
};

Module._load = function (req, parent, isMain) {
    if (req === '_GenericMarshal') return GM;
    if (req === 'user-sessions') return { isRoot: () => true, getProcessOwnerName: () => ({ tsid: 0 }) };
    if (req === 'MeshAgent') return { _tsid: null };
    return origLoad.apply(this, arguments);
};

const uia = require('/home/user/MeshCentral/agents/modules_meshcore/win-uiautomation.js');

// ---- assertions ---------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
    if (!cond) failures++;
}

console.log('\n1. sibling-walk enumeration and filtering');
let r = uia.enumerateWindows({});
check('method reported as walk', r.method === 'walk', 'got ' + r.method);
check('3 titled+visible windows kept', r.count === 3, 'got ' + r.count);
check('untitled window filtered out', !r.windows.some(w => w.title === ''));
check('invisible window filtered out', !r.windows.some(w => w.title === 'Invisible Thing'));

console.log('\n2. UTF-16 decoding and struct unpacking');
const uni = r.windows.find(w => w.pid === 4246);
check('non-ASCII title decoded', uni.title === 'Ünïcødé Wîndow 中文', JSON.stringify(uni.title));
check('class name decoded', uni.className === 'Chrome_WidgetWin_1');
check('negative RECT coords signed', uni.rect.left === -1920 && uni.rect.right === 0, JSON.stringify(uni.rect));
const calc = r.windows.find(w => w.title === 'Calculator');
check('minimized flag read', calc.minimized === true);
check('pid read', calc.pid === 4243);

console.log('\n3. filters off');
r = uia.enumerateWindows({ visibleOnly: false, titledOnly: false });
check('all 5 windows returned', r.count === 5, 'got ' + r.count);

console.log('\n4. find / activate / foreground');
check('find is case-insensitive substring', uia.findWindow('notepad').length === 1);
check('find miss returns empty', uia.findWindow('nonexistent').length === 0);
const act = uia.activateWindow(200);
check('activate reports foreground', act.result === true && act.foreground === 200, JSON.stringify(act));
check('foreground window described', uia.getForegroundWindow().title === 'Calculator');

console.log('\n5. selfTest report');
const st = uia.selfTest();
check('walk ran', st.walk.ok === true);
check('walk counted all windows', st.walk.count === 5, 'got ' + st.walk.count);
check('sample populated', st.sample.length === 3, 'got ' + st.sample.length);
check('no callback field reported', st.callback === undefined);

console.log('\n6. cycle guard in walk');
const savedGetWindow = impl.GetWindow;
impl.GetWindow = () => ({ Val: ORDER[0] }); // always points back to the first window
r = uia.enumerateWindows({ method: 'walk' });
check('terminates on cycle', r.count >= 0 && r.windows.length < 10, 'got ' + r.windows.length);
impl.GetWindow = savedGetWindow;

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
