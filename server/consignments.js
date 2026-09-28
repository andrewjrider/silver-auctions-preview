'use strict';
// Consignment requests from the public Consign page, and the staff view of them.
// One JSON file per request under DATA_DIR/consignments; written atomically.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATUSES = ['new', 'contacted', 'kit_sent', 'scanned', 'consigned', 'declined'];
const RESERVES = ['no_reserve', 'reserve'];

class ConsignmentError extends Error {}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Validates a public submission. Throws ConsignmentError with a message fit to show the visitor. */
function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {
    name: clean(b.name, 120),
    email: clean(b.email, 200).toLowerCase(),
    phone: clean(b.phone, 40),
    location: clean(b.location, 120),
    vehicle: clean(b.vehicle, 160),
    vin: clean(b.vin, 20).toUpperCase(),
    reserve: RESERVES.includes(b.reserve) ? b.reserve : 'no_reserve',
    wantsKit: b.wantsKit === true,
    notes: clean(b.notes, 1000),
    consent: b.consent === true,
  };
  if (!out.name) throw new ConsignmentError('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new ConsignmentError('Please enter a valid email address.');
  if (!out.vehicle) throw new ConsignmentError('Please tell us the year, make and model.');
  if (!out.location) throw new ConsignmentError('Please tell us where the car is.');
  if (out.vin && !/^[A-HJ-NPR-Z0-9]{5,17}$/.test(out.vin)) throw new ConsignmentError('That VIN has characters a VIN cannot contain (no I, O or Q).');
  if (!out.consent) throw new ConsignmentError('Please agree to be contacted about this consignment.');
  return out;
}

class ConsignmentStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'consignments');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create(fields, now = new Date()) {
    const id = `C-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const rec = { id, ...fields, status: 'new', createdAt: now.toISOString(), history: [{ at: now.toISOString(), status: 'new', by: 'web form' }] };
    this.write(rec);
    return rec;
  }

  write(rec) {
    const final = path.join(this.dir, `${rec.id}.json`);
    const tmp = `${final}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, final);
  }

  get(id) {
    if (!/^C-\d{8}-[0-9A-F]{6}$/.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')); } catch { return null; }
  }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  update(id, { status, lotNumber, note, by }, now = new Date()) {
    const rec = this.get(id);
    if (!rec) return null;
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw new ConsignmentError(`Unknown status ${status}.`);
      rec.status = status;
    }
    if (lotNumber !== undefined) rec.lotNumber = clean(lotNumber, 12);
    const entry = { at: now.toISOString(), status: rec.status, by: clean(by, 60) || 'staff' };
    if (note) entry.note = clean(note, 500);
    if (lotNumber !== undefined) entry.lotNumber = rec.lotNumber;
    rec.history.push(entry);
    this.write(rec);
    return rec;
  }
}

module.exports = { ConsignmentStore, ConsignmentError, validate, STATUSES };
