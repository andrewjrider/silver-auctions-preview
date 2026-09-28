'use strict';
// Silver Auctions parallel site: static page + Witnessmark evidence intake + server-side assay.
// Environment:
//   PORT                  port to listen on (Render sets this)
//   DATA_DIR              where verified records live (mount a Render disk here to keep them across deploys)
//   INTAKE_TOKEN          required to upload bundles; intake is closed when unset
//   TRUSTED_DEVICE_KEYS   comma-separated key fingerprints of registered inspection phones
//   ANTHROPIC_API_KEY     enables "Scan a car"; the page shows the example reading when unset
//   ASSAY_MODEL           model for the assay (default claude-sonnet-5)
//   STAFF_TOKEN           staff console password (consignments, rejected uploads); falls back to INTAKE_TOKEN
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyBundle } = require('./verify');
const { RecordStore } = require('./store');
const { runAssay, AssayError, Limiter } = require('./assay');
const { ConsignmentStore, ConsignmentError, validate: validateConsignment } = require('./consignments');

function createServer(env = process.env, deps = {}) {
  const publicDir = path.join(__dirname, '..', 'public');
  const store = new RecordStore(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const trustedKeys = new Set(String(env.TRUSTED_DEVICE_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const limiter = deps.limiter || new Limiter();
  const consignLimiter = deps.consignLimiter || new Limiter({ perClientPerHour: 5, sitePerDay: 500 });
  const consignments = new ConsignmentStore(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const indexHTML = fs.readFileSync(path.join(publicDir, 'index.html'));

  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, {
      'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(isBuf ? body : JSON.stringify(body));
  };

  const readBody = (req, max) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const tokenOK = (req) => {
    if (!env.INTAKE_TOKEN) return false;
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(env.INTAKE_TOKEN);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  const staffOK = (req) => {
    const want = env.STAFF_TOKEN || env.INTAKE_TOKEN;
    if (!want) return false;
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const w = Buffer.from(want);
    return given.length === w.length && crypto.timingSafeEqual(given, w);
  };

  const publicRecord = (r) => r; // reports hold no secrets; VIN is shown only if the inspector entered one

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return send(res, 200, indexHTML, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      }
      if (req.method === 'GET' && p === '/api/health') {
        return send(res, 200, { ok: true, assay: !!env.ANTHROPIC_API_KEY, intake: !!env.INTAKE_TOKEN, records: store.list().length });
      }
      if (req.method === 'GET' && p === '/api/records') {
        return send(res, 200, { records: store.list().map(publicRecord) }, { 'cache-control': 'no-cache' });
      }
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/api\/records\/([a-z0-9-]+)$/))) {
        const r = store.get(m[1]);
        return r ? send(res, 200, publicRecord(r)) : send(res, 404, { error: 'not_found' });
      }
      if (req.method === 'GET' && (m = p.match(/^\/records\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)$/))) {
        const fp = store.filePath(m[1], m[2]);
        if (!fp || !fs.existsSync(fp)) return send(res, 404, { error: 'not_found' });
        const type = m[2].endsWith('.zip') ? 'application/zip' : m[2].endsWith('.json') ? 'application/json'
          : /\.jpe?g$/i.test(m[2]) ? 'image/jpeg' : m[2].endsWith('.heic') ? 'image/heic' : 'application/octet-stream';
        const extra = m[2].endsWith('.zip') ? { 'content-disposition': `attachment; filename="witnessmark-${m[1]}.zip"` } : {};
        return send(res, 200, fs.readFileSync(fp), { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', ...extra });
      }
      if (req.method === 'POST' && (p === '/api/bundles' || p === '/api/bundles/verify')) {
        if (!env.INTAKE_TOKEN) return send(res, 503, { error: 'intake_closed', message: 'Evidence intake is not configured on this site.' });
        if (!tokenOK(req)) return send(res, 401, { error: 'unauthorized', message: 'Inspector token is missing or wrong.' });
        const zip = await readBody(req, 400 * 1024 * 1024);
        const { report, stored } = verifyBundle(zip, { trustedKeys });
        if (report.status !== 'verified') { store.logRejection(report); return send(res, 422, report); }
        if (p === '/api/bundles/verify') return send(res, 200, { ...report, published: false });
        if (!report.consent.recipients.includes('auctionHouse')) {
          return send(res, 422, { ...report, status: 'not_publishable', published: false,
            message: 'The owner did not agree to share this inspection with the auction house, so it cannot be published here.' });
        }
        return send(res, 201, { ...store.save(report, stored), published: true });
      }
      if (req.method === 'POST' && p === '/api/consignments') {
        const client = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (!consignLimiter.take(client)) return send(res, 429, { error: 'rate_limited', message: 'Too many requests from here. Try again in an hour or call the office.' });
        let body;
        try { body = JSON.parse((await readBody(req, 32 * 1024)).toString('utf8')); } catch { return send(res, 400, { error: 'invalid', message: 'That request could not be read.' }); }
        try {
          const rec = consignments.create(validateConsignment(body));
          return send(res, 201, { id: rec.id, wantsKit: rec.wantsKit });
        } catch (e) {
          if (e instanceof ConsignmentError) return send(res, 400, { error: 'invalid', message: e.message });
          throw e;
        }
      }
      if (p.startsWith('/api/staff/')) {
        if (!(env.STAFF_TOKEN || env.INTAKE_TOKEN)) return send(res, 503, { error: 'staff_closed', message: 'The staff console is not configured on this site.' });
        if (!staffOK(req)) return send(res, 401, { error: 'unauthorized', message: 'Staff password is missing or wrong.' });
        if (req.method === 'GET' && p === '/api/staff/consignments') return send(res, 200, { consignments: consignments.list() }, { 'cache-control': 'no-store' });
        if (req.method === 'GET' && p === '/api/staff/rejections') return send(res, 200, { rejections: store.listRejections() }, { 'cache-control': 'no-store' });
        if (req.method === 'PATCH' && (m = p.match(/^\/api\/staff\/consignments\/(C-\d{8}-[0-9A-F]{6})$/))) {
          let body;
          try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { return send(res, 400, { error: 'invalid' }); }
          try {
            const rec = consignments.update(m[1], body);
            return rec ? send(res, 200, rec) : send(res, 404, { error: 'not_found' });
          } catch (e) {
            if (e instanceof ConsignmentError) return send(res, 400, { error: 'invalid', message: e.message });
            throw e;
          }
        }
        return send(res, 404, { error: 'not_found' });
      }
      if (req.method === 'POST' && p === '/api/assay') {
        if (!env.ANTHROPIC_API_KEY) return send(res, 503, { code: 'not_configured' });
        const client = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        if (!limiter.take(client)) return send(res, 429, { code: 'rate_limited' });
        let body;
        try { body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8')); } catch { return send(res, 400, { code: 'image_rejected' }); }
        try {
          const result = await runAssay(body, { apiKey: env.ANTHROPIC_API_KEY, model: env.ASSAY_MODEL || 'claude-sonnet-5', fetchImpl: deps.fetch || fetch });
          return send(res, 200, result);
        } catch (e) {
          const code = e instanceof AssayError ? e.code : 'upstream_error';
          return send(res, code === 'rate_limited' ? 429 : code === 'image_rejected' ? 400 : 502, { code });
        }
      }
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      return send(res, e.status || 500, { error: e.status === 413 ? 'too_large' : 'server_error' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createServer().listen(port, () => console.log(`Silver Auctions preview listening on ${port}`));
}

module.exports = { createServer };
