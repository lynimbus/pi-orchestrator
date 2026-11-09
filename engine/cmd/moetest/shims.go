package main

const pathShim = `
function assertPath(p) {
  if (typeof p !== "string") throw new TypeError("Path must be a string. Received " + String(p));
}
function normalize(p) {
  assertPath(p);
  if (p === "") return ".";
  const isAbs = p.charCodeAt(0) === 47;
  const parts = p.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
      continue;
    }
    out.push(part);
  }
  let res = out.join("/");
  if (isAbs) res = "/" + res;
  if (res === "") res = isAbs ? "/" : ".";
  if ((p.endsWith("/") || p.endsWith("/.") || p.endsWith("/..")) && res !== "/" && !res.endsWith("/")) res += "/";
  return res;
}
function resolve(...args) {
  let resolved = "";
  for (let i = args.length - 1; i >= -1; i--) {
    let part = i >= 0 ? args[i] : "/";
    assertPath(part);
    if (part === "") { if (i < 0) break; continue; }
    resolved = part + (resolved ? "/" + resolved : "");
    if (part.startsWith("/")) break;
  }
  return normalize(resolved);
}
function join(...args) {
  if (args.length === 0) return ".";
  const joined = [];
  for (const a of args) { assertPath(a); if (a.length > 0) joined.push(a); }
  if (joined.length === 0) return ".";
  return normalize(joined.join("/"));
}
function dirname(p) {
  assertPath(p);
  if (p.length === 0) return ".";
  let end = p.length;
  while (end > 1 && p.charCodeAt(end - 1) === 47) end--;
  let start = end - 1;
  while (start >= 0 && p.charCodeAt(start) !== 47) start--;
  if (start < 0) return ".";
  if (start === 0) return "/";
  let d = p.slice(0, start);
  while (d.length > 1 && d.charCodeAt(d.length - 1) === 47) d = d.slice(0, -1);
  return d === "" ? "/" : d;
}
function basename(p, ext) {
  assertPath(p);
  if (p === "") return "";
  let end = p.length;
  while (end > 0 && p.charCodeAt(end - 1) === 47) end--;
  if (end === 0) return "/";
  let start = end;
  while (start > 0 && p.charCodeAt(start - 1) !== 47) start--;
  let base = p.slice(start, end);
  if (ext && base.length > ext.length && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
  return base;
}
function extname(p) {
  assertPath(p);
  let end = p.length;
  while (end > 0 && p.charCodeAt(end - 1) === 47) end--;
  let baseStart = 0;
  for (let i = end - 1; i >= 0; i--) { if (p.charCodeAt(i) === 47) { baseStart = i + 1; break; } }
  const base = p.slice(baseStart, end);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot);
}
function isAbsolute(p) {
  assertPath(p);
  return p.length > 0 && p.charCodeAt(0) === 47;
}
function relative(from, to) {
  assertPath(from); assertPath(to);
  const f = resolve(from), t = resolve(to);
  if (f === t) return "";
  const fParts = f.split("/"), tParts = t.split("/");
  let i = 0;
  while (i < fParts.length && i < tParts.length && fParts[i] === tParts[i]) i++;
  const rel = [];
  for (let j = i; j < fParts.length; j++) rel.push("..");
  for (let j = i; j < tParts.length; j++) rel.push(tParts[j]);
  const res = rel.join("/");
  return res === "" ? "." : res;
}
function parse(p) {
  assertPath(p);
  const root = isAbsolute(p) ? "/" : "";
  const base = basename(p);
  const ext = extname(p);
  const name = base.slice(0, base.length - ext.length);
  return { root, dir: dirname(p), base, ext, name };
}
function format(o) {
  if (o == null || typeof o !== "object") throw new TypeError("path.format requires an object");
  const dir = o.dir || o.root || "";
  const base = o.base || (o.name || "") + (o.ext || "");
  if (dir) return dir === "/" ? "/" + base : join(dir, base);
  return base;
}
export { normalize, resolve, join, dirname, basename, extname, isAbsolute, relative, parse, format };
export const sep = "/", delimiter = ":";
export const posix = { normalize, resolve, join, dirname, basename, extname, isAbsolute, relative, parse, format, sep: "/", delimiter: ":" };
`

const osShim = `
export function homedir() { return __goHomedir(); }
export function tmpdir() { return __goTmpdir(); }
export const EOL = "\n";
export const platform = "linux";
export function hostname() { return "probe-host"; }
export function cpus() { return []; }
export function totalmem() { return 0; }
export function freemem() { return 0; }
export function arch() { return "x64"; }
export function release() { return "probe"; }
`

const cryptoShim = `
export function createHash(alg) {
  if (alg !== "sha256") throw new Error("probe crypto shim: only sha256 is implemented, got " + alg);
  const id = __goSha256Begin();
  return {
    update(data) {
      if (data == null) throw new TypeError("data argument is mandatory");
      if (typeof data === "string") __goSha256UpdateStr(id, data);
      else if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) __goSha256UpdateB64(id, data.toString("base64"));
      else if (data instanceof Uint8Array) __goSha256UpdateB64(id, Buffer.from(data).toString("base64"));
      else throw new TypeError("probe crypto shim: unsupported update data type " + typeof data);
      return this;
    },
    digest(enc) {
      const hexStr = __goSha256End(id);
      if (enc === "hex" || enc === undefined) return hexStr;
      if (enc === "base64") return Buffer.from(hexStr, "hex").toString("base64");
      throw new Error("probe crypto shim: unsupported digest encoding " + enc);
    },
  };
}
export function randomBytes(n) {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes);
}
`

const assertShim = `
class AssertionError extends Error {
  constructor(opts) {
    const o = opts || {};
    super(typeof o.message === "string" ? o.message : "");
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.actual = o.actual;
    this.expected = o.expected;
    this.operator = o.operator;
    this.generatedMessage = !o.message;
  }
}
function fmt(v) {
  const t = typeof v;
  if (t === "string") return "'" + v + "'";
  if (v === null) return "null";
  if (t === "object" || t === "function") {
    if (Array.isArray(v)) return "[" + v.map(fmt).join(", ") + "]";
    try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
  }
  return String(v);
}
function mkErr(op, actual, expected, msg) {
  const m = msg !== undefined && msg !== null
    ? String(msg)
    : op + " " + fmt(actual) + " " + (op.includes("!=") || op.includes("not") ? "!=" : "==") + " " + fmt(expected);
  return new AssertionError({ message: m, actual, expected, operator: op });
}
function isDeepStrictEqual(a, b) {
  if (Object.is(a, b)) return true;
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) return false;
  if (ta !== "object" && ta !== "function") return false;
  if (a === null || b === null) return false;
  const pa = Object.getPrototypeOf(a), pb = Object.getPrototypeOf(b);
  if (pa !== pb) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    if (Object.prototype.toString.call(a) !== Object.prototype.toString.call(b)) return false;
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
  if (pa === Date.prototype) return a.getTime() === b.getTime();
  if (pa === RegExp.prototype) return a.source === b.source && a.flags === b.flags && a.lastIndex === b.lastIndex;
  if (a instanceof Error) {
    if (!(b instanceof Error)) return false;
    if (a.name !== b.name || a.message !== b.message) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!isDeepStrictEqual(a[k], b[k])) return false;
    }
    return true;
  }
  if (pa === Map.prototype) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    const bb = [];
    for (const e of b) bb.push(e);
    outer: for (const e of a) {
      for (const e2 of bb) { if (isDeepStrictEqual(e[0], e2[0]) && isDeepStrictEqual(e[1], e2[1])) continue outer; }
      return false;
    }
    return true;
  }
  if (pa === Set.prototype) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    const bb = [];
    for (const v of b) bb.push(v);
    outer2: for (const v of a) {
      for (const v2 of bb) { if (isDeepStrictEqual(v, v2)) continue outer2; }
      return false;
    }
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!isDeepStrictEqual(a[i], b[i])) return false;
    return true;
  }
  if (pa === Number.prototype || pa === String.prototype || pa === Boolean.prototype) {
    return a.valueOf() === b.valueOf();
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!isDeepStrictEqual(a[k], b[k])) return false;
  }
  return true;
}
function ok(v, msg) { if (!v) throw mkErr("ok", v, true, msg); }
function equal(a, b, msg) { if (!Object.is(a, b)) throw mkErr("strictEqual", a, b, msg); }
function notEqual(a, b, msg) { if (Object.is(a, b)) throw mkErr("notStrictEqual", a, b, msg); }
function strictEqual(a, b, msg) { if (!Object.is(a, b)) throw mkErr("strictEqual", a, b, msg); }
function notStrictEqual(a, b, msg) { if (Object.is(a, b)) throw mkErr("notStrictEqual", a, b, msg); }
function deepEqual(a, b, msg) { if (!isDeepStrictEqual(a, b)) throw mkErr("deepStrictEqual", a, b, msg); }
function notDeepEqual(a, b, msg) { if (isDeepStrictEqual(a, b)) throw mkErr("notDeepStrictEqual", a, b, msg); }
function deepStrictEqual(a, b, msg) { if (!isDeepStrictEqual(a, b)) throw mkErr("deepStrictEqual", a, b, msg); }
function notDeepStrictEqual(a, b, msg) { if (isDeepStrictEqual(a, b)) throw mkErr("notDeepStrictEqual", a, b, msg); }
function match(s, re, msg) {
  if (typeof s !== "string") throw mkErr("match", s, re, msg);
  if (!re.test(s)) throw mkErr("match", s, re, msg);
}
function doesNotMatch(s, re, msg) {
  if (typeof s !== "string") throw mkErr("doesNotMatch", s, re, msg);
  if (re.test(s)) throw mkErr("doesNotMatch", s, re, msg);
}
function fail(msg) {
  if (msg instanceof Error) throw msg;
  throw new AssertionError({ message: msg === undefined ? "Failed" : String(msg), operator: "fail" });
}
function throws(fn, expected, msg) {
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  if (!threw) throw new AssertionError({ message: msg || "Missing expected exception", operator: "throws" });
  if (expected === undefined || expected === null) return err;
  if (typeof expected === "function") {
    if (err instanceof expected) return err;
    if (expected(err) === true) return err;
    throw new AssertionError({ message: (msg || "Unexpected exception") + " got " + fmt(err), operator: "throws" });
  }
  if (expected instanceof RegExp) {
    if (expected.test(String(err && err.message))) return err;
    throw new AssertionError({ message: (msg || "Unexpected exception message") + " got " + fmt(err && err.message), operator: "throws" });
  }
  if (typeof expected === "object") {
    for (const k of Object.keys(expected)) {
      if (!isDeepStrictEqual(err && err[k], expected[k])) {
        throw new AssertionError({ message: (msg || "Unexpected exception") + " at field " + k, operator: "throws" });
      }
    }
    return err;
  }
  return err;
}
function doesNotThrow(fn, msg) {
  try { fn(); } catch (e) {
    throw new AssertionError({ message: (msg || "Got unwanted exception") + " " + fmt(e), operator: "doesNotThrow" });
  }
}
function ifError(v) { if (v !== null && v !== undefined) { const e = new AssertionError({ message: "ifError got " + fmt(v), operator: "ifError" }); throw v instanceof Error ? v : e; } }
export { AssertionError, ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual, match, doesNotMatch, fail, throws, doesNotThrow, ifError };
export default { AssertionError, ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual, match, doesNotMatch, fail, throws, doesNotThrow, ifError };
`

const bootScriptSrc = `
function __stringifyArg(x) {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack || ((x.name || "Error") + ": " + (x.message || ""));
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}
globalThis.console = {
  log: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
  error: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
  warn: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
  info: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
  debug: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
};
process.exit = (code) => { process.exitCode = code === undefined ? 0 : (code | 0); };
` + abortShim

const bootSrc = `
import * as urlmod from "node:url";
globalThis.URL = urlmod.URL;
globalThis.fileURLToPath = urlmod.fileURLToPath;
globalThis.pathToFileURL = urlmod.pathToFileURL;
function __stringifyArg(x) {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack || ((x.name || "Error") + ": " + (x.message || ""));
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}
globalThis.console = {
  log: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
  error: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
  warn: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
  info: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
  debug: (...a) => __goLog(a.map(__stringifyArg).join(" ")),
};
process.exit = (code) => { process.exitCode = code === undefined ? 0 : (code | 0); };
`

const urlShim = `
function resolveAgainst(base, ref) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return ref;
  const bm = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/.exec(base);
  if (!bm) throw new TypeError("Invalid base URL: " + base);
  const origin = bm[1];
  const bpath = bm[2];
  const dir = bpath.slice(0, bpath.lastIndexOf("/") + 1);
  let combined;
  if (ref.startsWith("/")) combined = ref;
  else combined = dir + ref;
  const parts = combined.split("/");
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (out.length > 0) out.pop(); continue; }
    out.push(p);
  }
  return origin + "/" + out.join("/");
}
class URL {
  constructor(input, base) {
    const href = base !== undefined ? resolveAgainst(String(base), String(input)) : String(input);
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^#?]*)([?#].*)?$/.exec(href);
    if (!m) throw new TypeError("Invalid URL: " + href);
    this._protocol = m[1] + ":";
    this._host = m[2];
    this._pathname = m[3] || "/";
    this._suffix = m[4] || "";
  }
  get href() { return this._protocol + "//" + this._host + this._pathname + this._suffix; }
  get protocol() { return this._protocol; }
  get host() { return this._host; }
  get hostname() { return this._host.split(":")[0]; }
  get origin() { return this._protocol + "//" + this._host; }
  get pathname() { return this._pathname; }
  get search() { return this._suffix.startsWith("?") ? this._suffix.split("#")[0] : ""; }
  get hash() { return this._suffix.includes("#") ? "#" + this._suffix.split("#")[1] : ""; }
  toString() { return this.href; }
}
function fileURLToPath(url) {
  const href = typeof url === "string" ? url : url.href;
  if (!href.startsWith("file://")) throw new TypeError("Only file: URLs are supported by the shim");
  let p = href.slice("file://".length).split("?")[0].split("#")[0];
  if (!p.startsWith("/")) {
    const slash = p.indexOf("/");
    const host = slash === -1 ? p : p.slice(0, slash);
    if (host !== "" && host !== "localhost") throw new TypeError("File URL host must be 'localhost' or empty");
    p = slash === -1 ? "/" : p.slice(slash);
  }
  return decodeURIComponent(p);
}
function pathToFileURL(p) {
  const abs = p.startsWith("/") ? p : "/" + p;
  return new URL("file://" + abs.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/"));
}
export { URL, fileURLToPath, pathToFileURL, resolveAgainst };
`

const abortShim = `
class AbortSignalShim {
  constructor() { this._aborted = false; this._reason = undefined; this._listeners = []; }
  get aborted() { return this._aborted; }
  get reason() { return this._reason; }
  get onabort() { return this._onabort; }
  set onabort(fn) { this._onabort = fn; }
  addEventListener(type, cb) { if (type === "abort") this._listeners.push(cb); }
  removeEventListener(type, cb) { if (type === "abort") this._listeners = this._listeners.filter((f) => f !== cb); }
  dispatchEvent(ev) { if (ev && ev.type === "abort") this._fire(); return true; }
  _fire() {
    if (this._aborted) return;
    this._aborted = true;
    if (this._reason === undefined) {
      const e = new Error("signal is aborted without reason");
      e.name = "AbortError";
      this._reason = e;
    }
    for (const cb of [...this._listeners]) cb({ type: "abort", target: this });
    if (typeof this._onabort === "function") this._onabort({ type: "abort", target: this });
  }
  throwIfAborted() { if (this._aborted) throw this._reason; }
  static timeout(ms) {
    const s = new AbortSignalShim();
    setTimeout(() => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      s._reason = e;
      s._fire();
    }, ms);
    return s;
  }
  static abort(reason) {
    const s = new AbortSignalShim();
    s._reason = reason;
    s._fire();
    return s;
  }
}
class AbortControllerShim {
  constructor() { this._signal = new AbortSignalShim(); }
  get signal() { return this._signal; }
  abort(reason) { if (reason !== undefined) this._signal._reason = reason; this._signal._fire(); }
}
globalThis.AbortSignal = AbortSignalShim;
globalThis.AbortController = AbortControllerShim;
`

const childProcShim = `
const procs = new Map();
function emit(id, event, payload) {
  const rec = procs.get(id);
  if (!rec) return;
  if (event === "stdout:data" || event === "stderr:data") {
    const buf = Buffer.from(payload, "base64");
    for (const cb of rec.streams[event] || []) cb(buf);
  } else if (event === "close") {
    let code = null, sig = null;
    if (payload.startsWith("sig:")) {
      sig = payload.slice(4);
      if (rec.obj) rec.obj.signalCode = sig;
    } else {
      code = Number(payload);
    }
    for (const cb of rec.handlers.close || []) cb(code, sig);
  } else if (event === "error") {
    const err = new Error(payload);
    err.code = "SPAWN_ERROR";
    for (const cb of rec.handlers.error || []) cb(err);
  }
}
function makeStream(rec, key) {
  const s = {
    on(ev, cb) { if (ev === "data") { (rec.streams[key] = rec.streams[key] || []).push(cb); } return s; },
    setEncoding() { return s; },
    destroy() { return s; },
  };
  return s;
}
export function spawn(cmd, args, opts) {
  const o = opts || {};
  const closePromise = __goSpawn(String(cmd), JSON.stringify(args || []), o.cwd ? String(o.cwd) : "", JSON.stringify(o.env || {}), emit);
  const id = __goLastSpawnId();
  const rec = { handlers: {}, streams: {} };
  rec.closePromise = closePromise;
  const proc = {
    pid: 0,
    killed: false,
    exitCode: null,
    signalCode: null,
    stdin: { end() {}, write() {} },
    stdout: makeStream(rec, "stdout:data"),
    stderr: makeStream(rec, "stderr:data"),
    on(ev, cb) { (rec.handlers[ev] = rec.handlers[ev] || []).push(cb); return proc; },
    once(ev, cb) { (rec.handlers[ev] = rec.handlers[ev] || []).push(cb); return proc; },
    kill(sig) { proc.killed = true; return __goKill(id, String(sig || "SIGTERM")); },
  };
  rec.obj = proc;
  procs.set(id, rec);
  return proc;
}
export function spawnSync(cmd, args, opts) {
  const o = opts || {};
  const res = __goSpawnSync(String(cmd), JSON.stringify(args || []), o.cwd ? String(o.cwd) : "", JSON.stringify(o.env || {}));
  const parsed = JSON.parse(res);
  return {
    status: parsed.status,
    stdout: Buffer.from(parsed.stdout, "base64"),
    stderr: Buffer.from(parsed.stderr, "base64"),
    error: parsed.error ? Object.assign(new Error(parsed.error), { code: parsed.errorCode }) : undefined,
  };
}
export { emit as __emit };
`

const fsWrapperSrc = `
import * as realfs from "node:fs";
export { accessSync, existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, appendFileSync, copyFileSync, constants } from "node:fs";
export const Stats = realfs.Stats;
export const Dirent = realfs.Dirent;
export const Buffer = realfs.Buffer;
function bigify(st) {
  const out = Object.create(Object.getPrototypeOf(st));
  const src = { ...st };
  for (const k of Object.keys(src)) out[k] = src[k];
  out.dev = BigInt(st.dev); out.ino = BigInt(st.ino); out.mode = BigInt(st.mode); out.nlink = BigInt(st.nlink || 0);
  out.uid = BigInt(st.uid || 0); out.gid = BigInt(st.gid || 0); out.rdev = BigInt(st.rdev || 0);
  out.blksize = BigInt(st.blksize || 0); out.blocks = BigInt(st.blocks || 0); out.size = BigInt(st.size);
  out.atimeMs = BigInt(Math.round(st.atimeMs)); out.mtimeMs = BigInt(Math.round(st.mtimeMs));
  out.ctimeMs = BigInt(Math.round(st.ctimeMs)); out.birthtimeMs = BigInt(Math.round(st.birthtimeMs || 0));
  out.atimeNs = BigInt(Math.round(st.atimeMs * 1e6)); out.mtimeNs = BigInt(Math.round(st.mtimeMs * 1e6));
  out.ctimeNs = BigInt(Math.round(st.ctimeMs * 1e6)); out.birthtimeNs = BigInt(Math.round((st.birthtimeMs || 0) * 1e6));
  out.isFile = () => st.isFile();
  out.isDirectory = () => st.isDirectory();
  out.isSymbolicLink = () => st.isSymbolicLink();
  out.isBlockDevice = () => st.isBlockDevice();
  out.isCharacterDevice = () => st.isCharacterDevice();
  out.isFIFO = () => st.isFIFO();
  out.isSocket = () => st.isSocket();
  return out;
}
export function lstatSync(p, opts) {
  if (opts && opts.bigint) return bigify(realfs.lstatSync(p));
  return realfs.lstatSync(p, opts);
}
export function statSync(p, opts) {
  if (opts && opts.bigint) return bigify(realfs.statSync(p));
  return realfs.statSync(p, opts);
}
export function chmodSync(p, mode) { __goChmod(String(p), Number(mode)); }
export function utimesSync(p, atime, mtime) { __goUtimes(String(p), atime, mtime); }
export function symlinkSync(target, path, type) { __goSymlink(String(target), String(path)); }
export function mkdtempSync(prefix) { return __goMkdtemp(String(prefix)); }
function dbg(name, fn) {
  return (...args) => {
    try { return fn(...args); }
    catch (e) { console.log("FSERR in", name, ":", String(e)); console.log("STACK:", e && e.stack ? e.stack.split("\n").slice(0, 6).join(" | ") : "none"); throw e; }
  };
}
export const readFileSync = realfs.readFileSync;
export const writeFileSync = realfs.writeFileSync;
export const promises = Object.assign({}, realfs.promises, {
  mkdtemp: async (prefix) => __goMkdtemp(String(prefix)),
  chmod: async (p, m) => __goChmod(String(p), Number(m)),
  symlink: async (t, p) => __goSymlink(String(t), String(p)),
  utimes: async (p, a, m) => __goUtimes(String(p), a, m),
});
`
