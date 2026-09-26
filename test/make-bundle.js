'use strict';
// Reference producer for Witnessmark session bundles, mirroring the app's exporter
// (Witnessmark/Persistence/SessionExporter.swift): same folder layout, same JSON shapes
// (Swift encodes UUIDs uppercase and dates as ISO-8601), same signature construction.
// Used by the tests and by `npm run demo-bundle` to make a sample upload.
const crypto = require('node:crypto');
const { zipSync } = require('fflate');
const { BASELINE_PROTOCOL } = require('../server/verify');

const U = () => crypto.randomUUID().toUpperCase();
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function depthSidecar(distance = 2.0, w = 64, h = 48) {
  const depth = Buffer.alloc(w * h * 4);
  const conf = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) { depth.writeFloatLE(distance + (i % 7) * 0.001, i * 4); conf[i] = i % 10 === 0 ? 1 : 2; }
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    sensor: { providerID: 'apple.arkit.scenedepth', manufacturer: 'Apple', model: 'iPhone LiDAR', technology: 'lidar', connection: 'built-in', sdkVersion: 'ARKit' },
    width: w, height: h, rgbWidth: 1920, rgbHeight: 1440, timestampSeconds: 12.5,
    intrinsics: { fx: 48.3, fy: 48.3, cx: 31.5, cy: 23.5 },
    depthFloat32LE: depth.toString('base64'), confidenceUInt8: conf.toString('base64'),
  }));
}

/** A tiny valid JPEG-ish payload; real bundles carry camera JPEGs. */
function fakePhoto(label) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`witnessmark test photo ${label} ${crypto.randomUUID()}`), Buffer.from([0xff, 0xd9])]);
}

function makeBundle({
  views = BASELINE_PROTOCOL.views.filter((v) => v[2]).map((v) => v[0]),
  accepted = true, lotNumber = '59', status = 'complete', key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
  keyStorage = 'secureEnclave', vehicle: vehicleOverrides = {}, photoFor = null,
} = {}) {
  const orgID = U(); const vehicleID = U(); const sessionID = U();
  const media = {};
  const evidenceObjects = views.map((reqID, i) => {
    const id = U();
    const photoName = `evidence-${U()}.jpg`;
    const title0 = (BASELINE_PROTOCOL.views.find((v) => v[0] === reqID) || [0, 'View'])[1];
    const photo = photoFor ? photoFor(i, title0) : fakePhoto(i);
    media[photoName] = photo;
    const title = (BASELINE_PROTOCOL.views.find((v) => v[0] === reqID) || [0, 'View'])[1];
    let depthEvidence = { isAvailable: false, source: 'notAvailable', confidenceSummary: 'No depth' };
    if (i < 5) {
      const name = `depth-${id}.json`;
      const d = depthSidecar(2 + i * 0.5);
      media[name] = d;
      depthEvidence = { fileName: name, isAvailable: true, source: 'lidar', confidenceSummary: 'LiDAR', sha256: sha(d),
        sensor: { providerID: 'apple.arkit.scenedepth', manufacturer: 'Apple', model: 'iPhone LiDAR', technology: 'lidar', connection: 'built-in', sdkVersion: 'ARKit' },
        width: 64, height: 48 };
    }
    return {
      id, sessionID, vehicleID, requirementID: reqID.toUpperCase(), title, category: 'exterior',
      capturedAt: new Date(Date.UTC(2026, 8, 25, 17, i, 0)).toISOString().replace('.000', ''),
      rgbEvidence: { fileName: photoName, width: 1920, height: 1440, colorSpace: 'sRGB', qualityScore: 0.9 },
      depthEvidence,
      sensorEvidence: { deviceModel: 'iPhone', osVersion: '26.0', cameraPosition: 'back', arTrackingState: 'normal', captureInstruction: '' },
      automatedFindings: [],
      humanValidation: accepted ? { id: U(), evidenceObjectID: id, validatorName: 'Andrew Rider', status: 'accepted', note: '', validatedAt: '2026-09-25T18:00:00Z' } : undefined,
      integrity: { sha256: sha(photo), appVersion: '0.1.0', captureDeviceIdentifier: 'test', originalFileName: photoName },
    };
  });
  const files = [];
  for (const ev of evidenceObjects) {
    files.push({ path: `media/${ev.rgbEvidence.fileName}`, role: 'rgb', evidenceID: ev.id, sha256: ev.integrity.sha256, bytes: media[ev.rgbEvidence.fileName].length });
    if (ev.depthEvidence.fileName) files.push({ path: `media/${ev.depthEvidence.fileName}`, role: 'depth', evidenceID: ev.id, sha256: ev.depthEvidence.sha256, bytes: media[ev.depthEvidence.fileName].length });
  }
  const manifest = {
    format: 'witnessmark.session-bundle', formatVersion: 1, exportedAt: '2026-09-25T18:30:00Z', appVersion: '0.1.0',
    organization: { id: orgID, name: 'Witnessmark Field Capture', type: 'internalTesting', createdAt: '2026-09-20T00:00:00Z' },
    vehicle: { id: vehicleID, organizationID: orgID, year: '1963', make: 'Maserati', model: '3500 GTi', trim: '', vin: '', lotNumber, notes: '', createdAt: '2026-09-25T16:00:00Z', ...vehicleOverrides },
    session: { id: sessionID, organizationID: orgID, vehicleID, protocolID: BASELINE_PROTOCOL.id.toUpperCase(), status,
      startedAt: '2026-09-25T17:00:00Z', completedAt: status === 'complete' ? '2026-09-25T18:20:00Z' : undefined,
      evidenceObjects, automatedFindings: [], humanValidations: [] },
    files,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const jwk = key.publicKey.export({ format: 'jwk' });
  const x963 = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const signature = {
    algorithm: 'ecdsa-p256-sha256', publicKeyX963: x963.toString('base64'),
    signatureDER: crypto.sign('sha256', manifestBytes, { key: key.privateKey, dsaEncoding: 'der' }).toString('base64'),
    manifestSHA256: sha(manifestBytes), keyStorage,
  };
  const root = `witnessmark-session-${sessionID.toLowerCase()}`;
  const entries = { [`${root}/manifest.json`]: new Uint8Array(manifestBytes), [`${root}/signature.json`]: new Uint8Array(Buffer.from(JSON.stringify(signature))) };
  for (const [name, data] of Object.entries(media)) entries[`${root}/media/${name}`] = new Uint8Array(data);
  return { zip: Buffer.from(zipSync(entries)), entries, root, manifest, key, sessionID };
}

/** Re-zips entries after a caller has altered them (for tamper tests). */
function rezip(entries) { return Buffer.from(zipSync(entries)); }

module.exports = { makeBundle, rezip, depthSidecar };

if (require.main === module) {
  const out = process.argv[2] || 'demo-bundle.zip';
  const { zip } = makeBundle();
  require('node:fs').writeFileSync(out, zip);
  console.log(`Wrote ${out} (${zip.length} bytes) — a SAMPLE bundle with placeholder photos, not a real inspection.`);
}
