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
// to disk. Env vars named GOBIMAN_VAR_<name> pre-fill Postman variables.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, 'collections'));
const PORT = Number(process.env.GOBIMAN_PORT || process.env.PORT) || 4600;
const HOST = '127.0.0.1';
const TIMEOUT_MS = 120000;

const state = { vars: {}, results: {}, bodies: {} };
Object.keys(process.env).forEach((k) => { if (k.startsWith('GOBIMAN_VAR_')) state.vars[k.slice(12)] = process.env[k]; });

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
const isText = (ct) => !ct || /json|text|xml|javascript|html|urlencoded|csv|yaml/i.test(ct);

async function runRequest({ key, method, url, headers, body }) {
    const started = Date.now();
    const base = { at: started, request: { method, url } };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const init = { method, headers: headers || {}, signal: ctrl.signal, redirect: 'follow' };
        if (body != null && !['GET', 'HEAD'].includes(method)) init.body = body;
        const resp = await fetch(url, init);
        const buf = Buffer.from(await resp.arrayBuffer());
        const contentType = resp.headers.get('content-type') || '';
        const result = { ...base, status: resp.status, statusText: resp.statusText, headers: [...resp.headers.entries()], timeMs: Date.now() - started, size: buf.length, contentType };
        if (isText(contentType)) { result.text = buf.toString('utf8'); delete state.bodies[key]; }
        else { result.binary = true; state.bodies[key] = { buf, contentType }; }
        return result;
    } catch (e) {
        const cause = e.cause && e.cause.message ? ` (${e.cause.code || e.cause.message})` : '';
        const msg = e.name === 'AbortError' ? `Timed out after ${TIMEOUT_MS / 1000}s` : e.message + cause;
        return { ...base, error: msg, timeMs: Date.now() - started };
    } finally {
        clearTimeout(timer);
    }
}

const server = http.createServer(async (req, res) => {
    // Only this machine's own page may use the proxy (blocks cross-site requests and DNS rebinding).
    const host = (req.headers.host || '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return send(res, 403, { error: 'forbidden host' });
    const origin = req.headers.origin;
    if (origin) {
        let ok = false;
        try { ok = new URL(origin).host === req.headers.host; } catch (e) {}
        if (!ok) return send(res, 403, { error: 'forbidden origin' });
    }
    const u = new URL(req.url, `http://${req.headers.host}`);
    try {
        if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
            return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
        }
        if (req.method === 'GET' && u.pathname === '/api/bootstrap') {
            return send(res, 200, { root: ROOT, workspaces: scanWorkspaces(), vars: state.vars, results: state.results });
        }
        if (req.method === 'POST' && u.pathname === '/api/vars') {
            state.vars = (await readJson(req)).vars || {};
            return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && u.pathname === '/api/run') {
            const body = await readJson(req);
            if (!body.key || !/^https?:\/\//i.test(body.url || '')) return send(res, 400, { error: 'key and an http(s) url are required' });
            const result = await runRequest(body);
            state.results[body.key] = result;
            return send(res, 200, result);
        }
        if (req.method === 'GET' && u.pathname === '/api/body') {
            const b = state.bodies[u.searchParams.get('key')];
            if (!b) return send(res, 404, { error: 'no body stored' });
            return send(res, 200, b.buf, b.contentType || 'application/octet-stream', { 'Content-Disposition': 'inline' });
        }
        if (req.method === 'POST' && u.pathname === '/api/clear') {
            state.results = {}; state.bodies = {};
            return send(res, 200, { ok: true });
        }
        send(res, 404, { error: 'not found' });
    } catch (e) {
        send(res, 500, { error: e.message });
    }
});

server.listen(PORT, HOST, () => {
    const ws = scanWorkspaces();
    console.log(`Gobiman  →  http://localhost:${PORT}`);
    console.log(`Workspaces in ${ROOT}: ${ws.length ? ws.map((w) => `${w.name} (${w.collections.length} collection${w.collections.length === 1 ? '' : 's'})`).join(', ') : 'none yet — copy Postman files into a sub-folder there'}`);
});
