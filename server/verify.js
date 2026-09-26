'use strict';
// Independent checker for Witnessmark session bundles (format: docs/SESSION-BUNDLE.md).
// Nothing in a bundle is trusted until it is re-derived here from the bytes received.
const crypto = require('node:crypto');
const { unzipSync } = require('fflate');

const LIMITS = {
  zipBytes: 400 * 1024 * 1024,
  unpackedBytes: 600 * 1024 * 1024,
  entries: 2000,
};

// Witnessmark's baseline collector-vehicle protocol (Witnessmark/Models/CaptureProtocols.swift).
// Kept here so coverage is computed by this site, not taken from the app's own score.
const BASELINE_PROTOCOL = {
  id: '5a95f8d2-6b85-45b5-90cc-cfce9453c101',
  views: [
    ['d2493707-e9b8-45b2-ba25-28ac422783dd', 'VIN / Identity Plate', true],
    ['12bb2177-39fe-4034-ad9a-36e70a1df24b', 'Front 3/4 Exterior', true],
    ['0b1f8798-f460-4e76-b9dc-5cb7a7e3d37f', 'Rear 3/4 Exterior', true],
    ['a63ea71c-5e14-4198-a35a-59988c8d10f1', 'Driver Side Profile', true],
    ['42652607-84a3-41fc-88e6-4e6ac5952150', 'Passenger Side Profile', true],
    ['9f7c3179-61fc-44b3-9d25-1022c8d3c3f7', 'Interior Overview', true],
    ['50e7cfbb-b4ea-45d3-9ca7-1852619544da', 'Odometer / Gauges', true],
    ['15d60a32-b7a8-4419-a9cc-fb2e45ebb0ab', 'Engine Bay', true],
    ['83c5d971-2de0-432a-a0b6-4bc4cf77d1d6', 'Underside / Chassis Sample', false],
    ['8717a5c5-cb00-4d53-8d97-6ed384520969', 'Supporting Documents', false],
  ],
};

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const lc = (v) => String(v || '').toLowerCase();
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
const safeName = (n) => typeof n === 'string' && n.length > 0 && n !== '.' && n !== '..' && !/[\/\\]/.test(n);

class Rejection extends Error {}

/** Public-key fingerprint shown to people and used for the trusted-device list. */
function keyFingerprint(x963) {
  return sha256hex(x963).slice(0, 16).match(/.{4}/g).join('-');
}

function publicKeyFromX963(x963) {
  if (x963.length !== 65 || x963[0] !== 0x04) throw new Rejection('Signing key is not an uncompressed P-256 public key.');
  const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(x963.subarray(1, 33)), y: b64url(x963.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** Reads the zip with size limits applied before any entry is inflated. */
function unpack(zip) {
  if (zip.length > LIMITS.zipBytes) throw new Rejection('Bundle is larger than this site accepts.');
  let total = 0;
  let count = 0;
  let files;
  try {
    files = unzipSync(new Uint8Array(zip), {
      filter(entry) {
        if (entry.name.endsWith('/') || entry.name.startsWith('__MACOSX/') || entry.name.endsWith('.DS_Store')) return false;
        count += 1;
        total += entry.originalSize;
        if (count > LIMITS.entries) throw new Rejection('Bundle has too many files.');
        if (total > LIMITS.unpackedBytes) throw new Rejection('Bundle unpacks to more than this site accepts.');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof Rejection) throw e;
    throw new Rejection('The upload is not a readable zip file.');
  }
  const roots = new Set();
  const byPath = new Map();
  for (const [name, data] of Object.entries(files)) {
    const parts = name.split('/');
    if (name.startsWith('/') || parts.some((p) => p === '..' || p === '' || p === '.')) {
      throw new Rejection(`Unsafe path inside bundle: ${name}`);
    }
    roots.add(parts[0]);
    byPath.set(parts.slice(1).join('/'), Buffer.from(data));
  }
  if (roots.size !== 1) throw new Rejection('Bundle must contain exactly one session folder.');
  return { root: [...roots][0], byPath };
}

/** Minimal re-implementation of tools/depth_inspect.py's checks for a v1 depth sidecar. */
function inspectDepth(buf) {
  const f = JSON.parse(buf.toString('utf8'));
  if (f.schemaVersion !== 1) throw new Error('unsupported depth schema');
  const { width: w, height: h } = f;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w > 8192 || h > 8192 || w * h > 16777216) {
    throw new Error('invalid depth grid');
  }
  const k = f.intrinsics || {};
  if (![k.fx, k.fy, k.cx, k.cy].every(Number.isFinite) || k.fx <= 0 || k.fy <= 0) throw new Error('invalid calibration');
  const raw = Buffer.from(String(f.depthFloat32LE || ''), 'base64');
  if (raw.length !== w * h * 4) throw new Error('depth buffer does not match grid');
  const conf = f.confidenceUInt8 == null ? null : Buffer.from(String(f.confidenceUInt8), 'base64');
  if (conf && conf.length !== w * h) throw new Error('confidence buffer does not match grid');
  let valid = 0; let high = 0; let min = Infinity; let max = -Infinity;
  for (let i = 0; i < w * h; i++) {
    const z = raw.readFloatLE(i * 4);
    if (Number.isFinite(z) && z > 0) {
      valid++;
      if (z < min) min = z;
      if (z > max) max = z;
      if (conf && conf[i] === 2) high++;
    }
    if (conf && conf[i] > 2) throw new Error('confidence value out of range');
  }
  return {
    sensor: f.sensor ? `${f.sensor.manufacturer || ''} ${f.sensor.model || ''}`.trim() : 'unknown',
    technology: f.sensor && f.sensor.technology,
    grid: `${w}x${h}`,
    validFraction: valid / (w * h),
    highConfidenceFraction: conf ? high / (w * h) : null,
    minimumMeters: valid ? min : null,
    maximumMeters: valid ? max : null,
  };
}

/**
 * Verifies a bundle. Never throws: returns { report, stored } where `stored` holds the
 * exact bytes to persist when (and only when) report.status === 'verified'.
 */
function verifyBundle(zip, { trustedKeys = new Set(), now = new Date() } = {}) {
  const checks = [];
  const warnings = [];
  const pass = (name, detail) => checks.push({ name, ok: true, detail });
  const report = {
    status: 'rejected', checkedAt: now.toISOString(), bundleSHA256: sha256hex(zip), bundleBytes: zip.length,
    checks, warnings,
  };
  try {
    const { root, byPath } = unpack(zip);
    pass('Readable bundle', `${byPath.size} files in ${root}`);

    const manifestBytes = byPath.get('manifest.json');
    const signatureBytes = byPath.get('signature.json');
    if (!manifestBytes) throw new Rejection('manifest.json is missing.');
    if (!signatureBytes) throw new Rejection('signature.json is missing.');
    let manifest; let signature;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Rejection('manifest.json is not valid JSON.'); }
    try { signature = JSON.parse(signatureBytes.toString('utf8')); } catch { throw new Rejection('signature.json is not valid JSON.'); }
    if (manifest.format !== 'witnessmark.session-bundle') throw new Rejection('Not a Witnessmark session bundle.');
    if (manifest.formatVersion !== 1) throw new Rejection(`Unsupported bundle version ${manifest.formatVersion}.`);
    const session = manifest.session || {};
    const vehicle = manifest.vehicle || {};
    if (root !== `witnessmark-session-${lc(session.id)}`) throw new Rejection('Folder name does not match the session inside it.');
    if (lc(vehicle.id) !== lc(session.vehicleID)) throw new Rejection('Vehicle record does not match the session.');
    pass('Manifest', `format v1, session ${lc(session.id).slice(0, 8)}`);

    // 1. Signature over the exact manifest bytes.
    if (signature.algorithm !== 'ecdsa-p256-sha256') throw new Rejection(`Unsupported signature algorithm ${signature.algorithm}.`);
    const x963 = Buffer.from(String(signature.publicKeyX963 || ''), 'base64');
    const key = publicKeyFromX963(x963);
    const sigOk = crypto.verify('sha256', manifestBytes, { key, dsaEncoding: 'der' },
      Buffer.from(String(signature.signatureDER || ''), 'base64'));
    if (!sigOk) throw new Rejection('Signature does not match the manifest — it was changed after signing, or signed by a different key.');
    if (lc(signature.manifestSHA256) !== sha256hex(manifestBytes)) throw new Rejection('Signature file names a different manifest hash.');
    const fingerprint = keyFingerprint(x963);
    const registered = trustedKeys.has(fingerprint);
    pass('Device signature', `valid ECDSA P-256 · key ${fingerprint} · ${signature.keyStorage === 'secureEnclave' ? 'Secure Enclave' : 'software key'}`);
    if (signature.keyStorage !== 'secureEnclave') warnings.push('Signed with a software key, not Secure Enclave hardware (for example a simulator build).');
    if (!registered) warnings.push(`Device key ${fingerprint} is not on this site's registered-device list.`);

    // 2. Every listed file present, byte-for-byte what the manifest and capture records say.
    const listed = Array.isArray(manifest.files) ? manifest.files : [];
    if (!listed.length) throw new Rejection('Manifest lists no evidence files.');
    const recorded = new Map();
    const evidenceByID = new Map();
    for (const ev of session.evidenceObjects || []) {
      evidenceByID.set(lc(ev.id), ev);
      if (ev.rgbEvidence) recorded.set(`rgb:${ev.rgbEvidence.fileName}`, { ev, hash: lc(ev.integrity && ev.integrity.sha256) });
      if (ev.depthEvidence && ev.depthEvidence.fileName) recorded.set(`depth:${ev.depthEvidence.fileName}`, { ev, hash: lc(ev.depthEvidence.sha256) });
    }
    const seen = new Set();
    let bytes = 0;
    const depth = [];
    for (const f of listed) {
      const name = String(f.path || '').replace(/^media\//, '');
      if (!String(f.path).startsWith('media/') || !safeName(name)) throw new Rejection(`Unsafe file entry ${f.path}.`);
      if (seen.has(f.path)) throw new Rejection(`${f.path} is listed twice.`);
      seen.add(f.path);
      const data = byPath.get(f.path);
      if (!data) throw new Rejection(`${f.path} is listed but missing.`);
      const actual = sha256hex(data);
      if (!isHash(f.sha256) || actual !== lc(f.sha256)) throw new Rejection(`${f.path} does not match its hash — the file was altered.`);
      if (data.length !== f.bytes) throw new Rejection(`${f.path} has the wrong size.`);
      const rec = recorded.get(`${f.role}:${name}`);
      if (!rec || lc(rec.ev.id) !== lc(f.evidenceID) || rec.hash !== actual) {
        throw new Rejection(`${f.path} does not match the hash recorded when it was captured.`);
      }
      if (f.role === 'depth') {
        try { depth.push({ evidenceID: lc(f.evidenceID), file: name, ...inspectDepth(data) }); } catch (e) {
          throw new Rejection(`${f.path} is not a valid depth record (${e.message}).`);
        }
      }
      bytes += data.length;
    }
    for (const key2 of recorded.keys()) {
      const [role, name] = key2.split(/:(.*)/s);
      if (!seen.has(`media/${name}`)) throw new Rejection(`Capture record references ${name} (${role}) but the bundle does not include it.`);
    }
    const extras = [...byPath.keys()].filter((p) => p.startsWith('media/') && !seen.has(p));
    if (extras.length) throw new Rejection(`Unlisted files in bundle: ${extras.slice(0, 3).join(', ')}.`);
    pass('Evidence files', `${listed.length} files, ${(bytes / 1048576).toFixed(1)} MB — every hash matches the capture record`);
    if (depth.length) pass('Depth records', `${depth.length} LiDAR depth files parsed and in range`);

    // 3. Coverage and review, computed here rather than taken from the app.
    const latest = new Map();
    for (const ev of session.evidenceObjects || []) {
      const cur = latest.get(lc(ev.requirementID));
      if (!cur || String(ev.capturedAt) > String(cur.capturedAt)) latest.set(lc(ev.requirementID), ev);
    }
    const knownProtocol = lc(session.protocolID) === BASELINE_PROTOCOL.id;
    const views = knownProtocol ? BASELINE_PROTOCOL.views.map(([id, title, required]) => {
      const ev = latest.get(id);
      const review = ev && ev.humanValidation ? ev.humanValidation : null;
      return {
        requirementID: id, title, required, captured: !!ev,
        evidenceID: ev ? lc(ev.id) : null,
        capturedAt: ev ? ev.capturedAt : null,
        photo: ev && ev.rgbEvidence ? ev.rgbEvidence.fileName : null,
        hasDepth: !!(ev && ev.depthEvidence && ev.depthEvidence.fileName),
        review: review ? { status: review.status, by: review.validatorName, note: review.note, at: review.validatedAt } : null,
      };
    }) : [];
    const required = views.filter((v) => v.required);
    const requiredCaptured = required.filter((v) => v.captured).length;
    const requiredAccepted = required.filter((v) => v.review && v.review.status === 'accepted').length;
    if (!knownProtocol) warnings.push('Unknown capture protocol — view coverage could not be computed.');
    else if (requiredCaptured < required.length) warnings.push(`${required.length - requiredCaptured} of ${required.length} required views were not captured.`);
    if (session.status !== 'complete') warnings.push(`Inspection status on the phone is "${session.status}", not complete.`);
    if (knownProtocol && requiredAccepted < requiredCaptured) warnings.push(`${requiredCaptured - requiredAccepted} captured required views have not been accepted by a reviewer.`);

    report.status = 'verified';
    report.id = `${lc(session.id).slice(0, 8)}-${sha256hex(manifestBytes).slice(0, 12)}`;
    report.manifestSHA256 = sha256hex(manifestBytes);
    report.exportedAt = manifest.exportedAt;
    report.appVersion = manifest.appVersion;
    report.device = { fingerprint, keyStorage: signature.keyStorage, registered };
    report.vehicle = {
      year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim,
      vin: vehicle.vin, lotNumber: String(vehicle.lotNumber || '').trim(),
    };
    report.session = {
      id: lc(session.id), status: session.status, startedAt: session.startedAt, completedAt: session.completedAt,
      captures: (session.evidenceObjects || []).length,
      requiredViews: required.length, requiredCaptured, requiredAccepted,
    };
    report.views = views;
    report.depth = depth;
    return { report, stored: { root, manifestBytes, signatureBytes, zip, media: new Map([...byPath].filter(([p]) => p.startsWith('media/'))) } };
  } catch (e) {
    checks.push({ name: 'Rejected', ok: false, detail: e instanceof Rejection ? e.message : `Unexpected error: ${e.message}` });
    return { report, stored: null };
  }
}

module.exports = { verifyBundle, keyFingerprint, inspectDepth, BASELINE_PROTOCOL, LIMITS };
