'use strict';
// Verified bundles on disk: DATA_DIR/records/<record id>/{bundle.zip, manifest.json, signature.json, report.json, media/*}
// Rejected uploads keep only their report, in DATA_DIR/rejected/, for audit.
const fs = require('node:fs');
const path = require('node:path');

class RecordStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'records');
    this.rejectedDir = path.join(dataDir, 'rejected');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.rejectedDir, { recursive: true });
    this.records = new Map();
    for (const id of fs.readdirSync(this.dir)) {
      try { this.records.set(id, JSON.parse(fs.readFileSync(path.join(this.dir, id, 'report.json'), 'utf8'))); } catch { /* skip partial */ }
    }
  }

  save(report, stored) {
    const final = path.join(this.dir, report.id);
    if (this.records.has(report.id)) return this.records.get(report.id); // identical manifest already on file
    const tmp = path.join(this.dir, `.incoming-${report.id}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(path.join(tmp, 'media'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bundle.zip'), stored.zip);
    fs.writeFileSync(path.join(tmp, 'manifest.json'), stored.manifestBytes);
    fs.writeFileSync(path.join(tmp, 'signature.json'), stored.signatureBytes);
    for (const [p, data] of stored.media) fs.writeFileSync(path.join(tmp, p), data);
    const saved = { ...report, receivedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(tmp, 'report.json'), JSON.stringify(saved, null, 2));
    fs.renameSync(tmp, final); // record appears all at once or not at all
    this.records.set(report.id, saved);
    return saved;
  }

  logRejection(report) {
    const name = `${Date.now()}-${report.bundleSHA256.slice(0, 12)}.json`;
    fs.writeFileSync(path.join(this.rejectedDir, name), JSON.stringify(report, null, 2));
  }

  list() {
    return [...this.records.values()].sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
  }

  get(id) { return this.records.get(id) || null; }

  /** Absolute path of a stored file, only if the record exists and the name is one it holds. */
  filePath(id, name) {
    const rec = this.records.get(id);
    if (!rec) return null;
    if (name === 'bundle.zip') return path.join(this.dir, id, 'bundle.zip');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
    const known = rec.views.some((v) => v.photo === name) || rec.depth.some((d) => d.file === name);
    return known ? path.join(this.dir, id, 'media', name) : null;
  }
}

module.exports = { RecordStore };
