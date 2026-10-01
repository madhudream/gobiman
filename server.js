#!/usr/bin/env node
// Gobiman — local server. Zero dependencies (Node 18+).
//
//   node gobiman/server.js                 scans gobiman/collections/<workspace>/*.json
//   node gobiman/server.js /some/folder    scans that folder instead
//
// Each sub-folder of the collections folder is a "workspace": drop any number of
// *.postman_collection.json and *.postman_environment.json files into it. Files placed
// directly in the collections folder form a workspace of their own.
// The server serves the web app and proxies API calls so the browser isn't blocked by
// CORS. Variables (incl. tokens) and responses live in memory only — nothing is written
// to disk. A .env file next to this script (KEY=VALUE per line) is loaded automatically;
// env vars named GOBIMAN_VAR_<name> pre-fill Postman variables of that name; GOBIMAN_VAR_ALIASES
// maps a variable to any other env var name (e.g. "apiToken=MY_API_TOKEN,other=OTHER_TOKEN").
//
// GOBIMAN_HOSTED=1 runs the same server for the public internet (e.g. on Cloud Run): it listens on
// every interface, keeps a separate in-memory session per browser (cookie), refuses to call private
// or link-local addresses, caps response size and time, and rate-limits each client. Nothing is
// ever stored: a session's variables and responses are dropped after SESSION_TTL of silence.
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const HOSTED = /^(1|true|yes)$/i.test(process.env.GOBIMAN_HOSTED || '');
// An optional "apps" launcher from the site that hosts Gobiman: a script to add to every page, and the
// custom element it defines (placed in the top bar, where <span id="launcher"> is). Any site can set
// its own; the open-source pages carry no site's branding by themselves.
const LAUNCHER_URL = process.env.GOBIMAN_LAUNCHER_URL || '';
const LAUNCHER_ELEMENT = /^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(process.env.GOBIMAN_LAUNCHER_ELEMENT || '') ? process.env.GOBIMAN_LAUNCHER_ELEMENT : '';
let launcherOrigin = ''; try { launcherOrigin = LAUNCHER_URL ? new URL(LAUNCHER_URL).origin : ''; } catch (e) {}
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, 'collections'));
const PORT = Number(process.env.GOBIMAN_PORT || process.env.PORT) || 4600;
const HOST = HOSTED ? '0.0.0.0' : '127.0.0.1';
const TIMEOUT_MS = HOSTED ? 30000 : 120000;
const MAX_BODY = HOSTED ? 8 * 1024 * 1024 : Infinity;        // one response
const MAX_SESSION_BYTES = HOSTED ? 32 * 1024 * 1024 : Infinity; // all stored responses of one session
const SESSION_TTL = (HOSTED ? 2 : 24) * 3600 * 1000;
const MAX_SESSIONS = 2000;
const RUNS_PER_MINUTE = 90;

// Load a .env file (if present) next to this script, without overriding real env vars
// or any external dependency (simple KEY=VALUE parser, '#' comments, optional quotes).
function loadDotEnv(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    text.split(/\r?\n/).forEach((line) => {
        const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!m || line.trim().startsWith('#')) return;
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    });
}
loadDotEnv(path.join(__dirname, '.env'));

// Variables pre-filled from the environment (local use: a token in .env). Never used when hosted.
const envVars = {};
if (!HOSTED) {
    Object.keys(process.env).forEach((k) => { if (k.startsWith('GOBIMAN_VAR_') && k !== 'GOBIMAN_VAR_ALIASES') envVars[k.slice(12)] = process.env[k]; });
    // Aliases, so a token already in .env under its own name can fill a collection variable with no
    // GOBIMAN_VAR_ prefix: GOBIMAN_VAR_ALIASES="apiToken=MY_API_TOKEN,other=OTHER_TOKEN".
    (process.env.GOBIMAN_VAR_ALIASES || '').split(',').forEach((pair) => {
        const [varName, envName] = pair.split('=').map((x) => x && x.trim());
        if (varName && envName && envVars[varName] === undefined && process.env[envName]) envVars[varName] = process.env[envName];
    });
}

// One in-memory session per browser: its variables (tokens included), responses and binary bodies.
// Locally that is one session for one person; hosted, every visitor gets their own and never sees
// another's. Sessions die after SESSION_TTL without a request.
const sessions = new Map();
const COOKIE = 'gobiman_sid';
function newSession() {
    return { vars: { ...envVars }, results: {}, bodies: {}, bytes: 0, seen: Date.now() };
}
function sessionOf(req, res) {
    const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
    let sid = cookie ? cookie.slice(COOKIE.length + 1) : '';
    let s = /^[a-f0-9]{32}$/.test(sid) ? sessions.get(sid) : null;
    if (!s) {
        if (sessions.size >= MAX_SESSIONS) {
            const oldest = [...sessions.entries()].sort((a, b) => a[1].seen - b[1].seen)[0];
            if (oldest) sessions.delete(oldest[0]);
        }
        sid = crypto.randomBytes(16).toString('hex');
        s = newSession();
        sessions.set(sid, s);
        res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax${HOSTED ? '; Secure' : ''}`);
    }
    s.seen = Date.now();
    return s;
}
setInterval(() => { const cut = Date.now() - SESSION_TTL; for (const [k, v] of sessions) if (v.seen < cut) sessions.delete(k); }, 60000).unref();

// Hosted: a small per-client budget of runs, so the proxy cannot be used as somebody's load generator.
const budget = new Map();
function overBudget(req) {
    if (!HOSTED) return false;
    const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '?').trim();
    const now = Date.now();
    const arr = (budget.get(ip) || []).filter((t) => now - t < 60000);
    arr.push(now); budget.set(ip, arr);
    if (budget.size > 10000) budget.clear();
    return arr.length > RUNS_PER_MINUTE;
}

// Hosted: the proxy only talks to the public internet. Loopback, private, link-local and the cloud
// metadata service are refused, and each redirect hop is checked again.
function privateIPv4(ip) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateAddress(ip) {
    if (net.isIPv4(ip)) return privateIPv4(ip);
    const low = ip.toLowerCase();
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateIPv4(mapped[1]);
    return low === '::' || low === '::1' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low);
}
async function assertPublic(url) {
    if (!HOSTED) return;
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs can be called');
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || host === 'metadata') throw new Error(`${host} is not reachable from the hosted tool`);
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`${host} could not be resolved`);
    if (addrs.some((a) => privateAddress(a.address))) throw new Error(`${host} is a private address; the hosted tool only calls the public internet (clone Gobiman to call yours)`);
}

function readJsonFiles(dir, suffix) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
    return names
        .filter((d) => d.isFile() && d.name.endsWith(suffix))
        .map((d) => d.name)
        .sort()
        .map((file) => {
            try { return { file, data: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }; }
            catch (e) { return { file, error: e.message }; }
        });
}
function workspace(name, dir) {
    const all = readJsonFiles(dir, '.json');
    const collections = all.filter((f) => f.data && Array.isArray(f.data.item));
    const environments = all.filter((f) => f.data && Array.isArray(f.data.values) && !Array.isArray(f.data.item));
    const broken = all.filter((f) => f.error).map((f) => f.file);
    return { name, dir, collections, environments, broken };
}
function scanWorkspaces() {
    fs.mkdirSync(ROOT, { recursive: true });
    const out = [];
    const rootWs = workspace(path.basename(ROOT), ROOT);
    if (rootWs.collections.length) out.push(rootWs);
    fs.readdirSync(ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b))
        .forEach((name) => { const ws = workspace(name, path.join(ROOT, name)); if (ws.collections.length || ws.environments.length) out.push(ws); });
    return out;
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
    res.end(buf);
}
function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}
const SECURITY = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' ${launcherOrigin}; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'self'; form-action 'self'`.replace('  ', ' '),
};
// a page from disk, with the host site's launcher added when one is configured
function page(file) {
    let html = fs.readFileSync(path.join(__dirname, file), 'utf8');
    if (LAUNCHER_URL) {
        if (LAUNCHER_ELEMENT) html = html.replace('<span id="launcher"></span>', `<${LAUNCHER_ELEMENT}></${LAUNCHER_ELEMENT}>`);
        html = html.replace('</body>', `<script src="${LAUNCHER_URL.replace(/"/g, '&quot;')}" defer></script>\n</body>`);
    }
    return html;
}
const isText = (ct) => !ct || /json|text|xml|javascript|html|urlencoded|csv|yaml/i.test(ct);

async function runRequest(session, { key, method, url, headers, body }) {
    const started = Date.now();
    const base = { at: started, request: { method, url } };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const init = { method, headers: headers || {}, signal: ctrl.signal, redirect: 'manual' };
        if (body != null && !['GET', 'HEAD'].includes(method)) init.body = body;
        let target = url, resp;
        for (let hop = 0; ; hop++) {
            await assertPublic(target);
            resp = await fetch(target, init);
            const loc = resp.headers.get('location');
            if (![301, 302, 303, 307, 308].includes(resp.status) || !loc) break;
            if (hop >= 5) throw new Error('too many redirects');
            target = new URL(loc, target).toString();
            if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === 'POST')) { init.method = 'GET'; delete init.body; }
        }
        const len = Number(resp.headers.get('content-length') || 0);
        if (len > MAX_BODY) throw new Error(`response is ${(len / 1048576).toFixed(1)} MB; the hosted tool keeps ${MAX_BODY / 1048576} MB at most`);
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > MAX_BODY) throw new Error(`response is ${(buf.length / 1048576).toFixed(1)} MB; the hosted tool keeps ${MAX_BODY / 1048576} MB at most`);
        const contentType = resp.headers.get('content-type') || '';
        const result = { ...base, status: resp.status, statusText: resp.statusText, headers: [...resp.headers.entries()], timeMs: Date.now() - started, size: buf.length, contentType };
        if (isText(contentType)) { result.text = buf.toString('utf8'); delete session.bodies[key]; }
        else { result.binary = true; session.bodies[key] = { buf, contentType }; }
        return result;
    } catch (e) {
        const cause = e.cause && e.cause.message ? ` (${e.cause.code || e.cause.message})` : '';
        const msg = e.name === 'AbortError' ? `Timed out after ${TIMEOUT_MS / 1000}s` : e.message + cause;
        return { ...base, error: msg, timeMs: Date.now() - started };
    } finally {
        clearTimeout(timer);
    }
}
function sessionBytes(session) {
    let n = 0;
    for (const r of Object.values(session.results)) n += (r.text ? r.text.length : 0) + 200;
    for (const b of Object.values(session.bodies)) n += b.buf.length;
    return n;
}

const server = http.createServer(async (req, res) => {
    // Locally, only this machine's own page may use the proxy (blocks cross-site requests and DNS
    // rebinding). Hosted, any host is fine but a request with an Origin must come from this very site.
    const host = (req.headers.host || '').split(':')[0];
    if (!HOSTED && !['localhost', '127.0.0.1'].includes(host)) return send(res, 403, { error: 'forbidden host' });
    const origin = req.headers.origin;
    if (origin) {
        let ok = false;
        try { ok = new URL(origin).host === req.headers.host; } catch (e) {}
        if (!ok) return send(res, 403, { error: 'forbidden origin' });
    }
    const u = new URL(req.url, `http://${req.headers.host}`);
    try {
        // Hosted, the front page is about.html (what it is, try it, clone it) and the tool lives at /app.
        // Locally the tool is the front page, as always; /app works there too.
        if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/app' || u.pathname === '/app/')) {
            const about = HOSTED && (u.pathname === '/' || u.pathname === '/index.html');
            return send(res, 200, page(about ? 'about.html' : 'index.html'), 'text/html; charset=utf-8', HOSTED ? SECURITY : {});
        }
        if (req.method === 'GET' && /^\/docs\/[a-z0-9-]+\.jpg$/.test(u.pathname)) {
            let img; try { img = fs.readFileSync(path.join(__dirname, 'docs', path.basename(u.pathname))); } catch (e) { return send(res, 404, { error: 'not found' }); }
            return send(res, 200, img, 'image/jpeg', { 'Cache-Control': 'public, max-age=86400' });
        }
        if (req.method === 'GET' && u.pathname === '/health') return send(res, 200, { ok: true, hosted: HOSTED, sessions: sessions.size });
        if (!u.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
        const session = sessionOf(req, res);
        if (req.method === 'GET' && u.pathname === '/api/bootstrap') {
            return send(res, 200, { hosted: HOSTED, root: HOSTED ? null : ROOT, workspaces: scanWorkspaces(), vars: session.vars, results: session.results });
        }
        if (req.method === 'POST' && u.pathname === '/api/vars') {
            session.vars = (await readJson(req)).vars || {};
            return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && u.pathname === '/api/run') {
            if (overBudget(req)) return send(res, 429, { error: `more than ${RUNS_PER_MINUTE} requests a minute; slow down, or clone Gobiman and run it locally` });
            const body = await readJson(req);
            if (!body.key || !/^https?:\/\//i.test(body.url || '')) return send(res, 400, { error: 'key and an http(s) url are required' });
            if (sessionBytes(session) > MAX_SESSION_BYTES) return send(res, 200, { at: Date.now(), request: { method: body.method, url: body.url }, error: 'this session holds too many responses; clear them (⋯ menu) and run again', timeMs: 0 });
            const result = await runRequest(session, body);
            session.results[body.key] = result;
            return send(res, 200, result);
        }
        if (req.method === 'GET' && u.pathname === '/api/body') {
            const b = session.bodies[u.searchParams.get('key')];
            if (!b) return send(res, 404, { error: 'no body stored' });
            return send(res, 200, b.buf, b.contentType || 'application/octet-stream', { 'Content-Disposition': 'inline' });
        }
        if (req.method === 'POST' && u.pathname === '/api/clear') {
            session.results = {}; session.bodies = {};
            return send(res, 200, { ok: true });
        }
        send(res, 404, { error: 'not found' });
    } catch (e) {
        send(res, 500, { error: e.message });
    }
});

server.listen(PORT, HOST, () => {
    const ws = scanWorkspaces();
    console.log(HOSTED ? `Gobiman (hosted mode) on port ${PORT}` : `Gobiman  →  http://localhost:${PORT}`);
    console.log(`Workspaces in ${ROOT}: ${ws.length ? ws.map((w) => `${w.name} (${w.collections.length} collection${w.collections.length === 1 ? '' : 's'})`).join(', ') : 'none yet — copy Postman files into a sub-folder there'}`);
});
