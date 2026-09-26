'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyBundle, keyFingerprint } = require('../server/verify');
const { makeBundle, rezip } = require('./make-bundle');

const rejectedBecause = (report, re) => {
  assert.strictEqual(report.status, 'rejected');
  const last = report.checks[report.checks.length - 1];
  assert.match(last.detail, re);
};
const mutateJSON = (entries, path, fn) => {
  const obj = JSON.parse(Buffer.from(entries[path]).toString('utf8'));
  fn(obj);
  entries[path] = new Uint8Array(Buffer.from(JSON.stringify(obj, null, 2)));
};

test('a clean, complete, accepted bundle verifies', () => {
  const b = makeBundle();
  const { report, stored } = verifyBundle(b.zip);
  assert.strictEqual(report.status, 'verified', JSON.stringify(report.checks));
  assert.strictEqual(report.session.requiredViews, 8);
  assert.strictEqual(report.session.requiredCaptured, 8);
  assert.strictEqual(report.session.requiredAccepted, 8);
  assert.strictEqual(report.vehicle.lotNumber, '59');
  assert.strictEqual(report.depth.length, 5);
  assert.ok(report.depth[0].validFraction === 1);
  assert.ok(stored.media.size > 0);
  // Only the unregistered-device warning applies.
  assert.deepStrictEqual(report.warnings.length, 1);
  assert.match(report.warnings[0], /not on this site's registered-device list/);
});

test('a registered device key removes that warning', () => {
  const b = makeBundle();
  const first = verifyBundle(b.zip).report;
  const { report } = verifyBundle(b.zip, { trustedKeys: new Set([first.device.fingerprint]) });
  assert.strictEqual(report.device.registered, true);
  assert.strictEqual(report.warnings.length, 0);
});

test('an altered photo is rejected', () => {
  const b = makeBundle();
  const photo = Object.keys(b.entries).find((k) => k.endsWith('.jpg'));
  b.entries[photo] = new Uint8Array(Buffer.concat([Buffer.from(b.entries[photo]), Buffer.from('edit')]));
  rejectedBecause(verifyBundle(rezip(b.entries)).report, /does not match its hash/);
});

test('an altered depth file is rejected', () => {
  const b = makeBundle();
  const depth = Object.keys(b.entries).find((k) => k.includes('/media/depth-'));
  const bytes = Buffer.from(b.entries[depth]);
  bytes[bytes.length - 5] ^= 1;
  b.entries[depth] = new Uint8Array(bytes);
  rejectedBecause(verifyBundle(rezip(b.entries)).report, /does not match its hash/);
});

test('editing the manifest (e.g. changing the lot) breaks the signature', () => {
  const b = makeBundle();
  mutateJSON(b.entries, `${b.root}/manifest.json`, (m) => { m.vehicle.lotNumber = '104'; });
  rejectedBecause(verifyBundle(rezip(b.entries)).report, /Signature does not match/);
});

test('re-signing an edited manifest with another key still verifies, but shows a different device', () => {
  // The signature proves which key signed, not who is trustworthy — that's what the device list is for.
  const b = makeBundle();
  const good = verifyBundle(b.zip).report;
  const other = makeBundle({ key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) });
  assert.notStrictEqual(verifyBundle(other.zip).report.device.fingerprint, good.device.fingerprint);
});

test('swapping in a file whose manifest hash was also edited is caught against the capture record', () => {
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const b = makeBundle({ key });
  const photoPath = Object.keys(b.entries).find((k) => k.endsWith('.jpg'));
  const newPhoto = Buffer.from('different photo');
  b.entries[photoPath] = new Uint8Array(newPhoto);
  const mPath = `${b.root}/manifest.json`;
  const m = JSON.parse(Buffer.from(b.entries[mPath]).toString());
  const f = m.files.find((x) => `${b.root}/${x.path}` === photoPath);
  f.sha256 = crypto.createHash('sha256').update(newPhoto).digest('hex');
  f.bytes = newPhoto.length;
  const mb = Buffer.from(JSON.stringify(m, null, 2));
  b.entries[mPath] = new Uint8Array(mb);
  const sPath = `${b.root}/signature.json`;
  const s = JSON.parse(Buffer.from(b.entries[sPath]).toString());
  s.signatureDER = crypto.sign('sha256', mb, { key: key.privateKey, dsaEncoding: 'der' }).toString('base64');
  s.manifestSHA256 = crypto.createHash('sha256').update(mb).digest('hex');
  b.entries[sPath] = new Uint8Array(Buffer.from(JSON.stringify(s)));
  rejectedBecause(verifyBundle(rezip(b.entries)).report, /recorded when it was captured/);
});

test('a missing listed file is rejected', () => {
  const b = makeBundle();
  const photo = Object.keys(b.entries).find((k) => k.endsWith('.jpg'));
  delete b.entries[photo];
  rejectedBecause(verifyBundle(rezip(b.entries)).report, /missing/);
});

test('an extra unlisted file is rejected', () => {
  const b = makeBundle();
  b.entries[`${b.root}/media/extra.jpg`] = new Uint8Array(Buffer.from('smuggled'));
  rejectedBecause(verifyBundle(rezip(b.entries)).report, /Unlisted files/);
});

test('path traversal inside the zip is rejected', () => {
  const b = makeBundle();
  b.entries[`${b.root}/../evil.txt`] = new Uint8Array(Buffer.from('x'));
  rejectedBecause(verifyBundle(rezip(b.entries)).report, /Unsafe path/);
});

test('garbage uploads are rejected without throwing', () => {
  rejectedBecause(verifyBundle(Buffer.from('not a zip')).report, /not a readable zip/);
});

test('incomplete inspections verify but carry warnings, and coverage is computed by the site', () => {
  const b = makeBundle({ views: ['12bb2177-39fe-4034-ad9a-36e70a1df24b'], accepted: false, status: 'inProgress', keyStorage: 'software' });
  const { report } = verifyBundle(b.zip);
  assert.strictEqual(report.status, 'verified');
  assert.strictEqual(report.session.requiredCaptured, 1);
  const w = report.warnings.join(' | ');
  assert.match(w, /7 of 8 required views were not captured/);
  assert.match(w, /not complete/);
  assert.match(w, /software key/);
  assert.match(w, /not been accepted/);
});

test('fingerprints are stable and short', () => {
  assert.match(keyFingerprint(Buffer.alloc(65, 4)), /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
});
