'use strict';
// Server side of "Scan a car": the prompt lives here, not in the browser, so the public page
// cannot turn this site's API key into a general-purpose model endpoint.

function buildPrompt(known) {
  const k = String(known || '').slice(0, 120);
  return 'You are the assayer for a classic-car auction house. You grade cars the way an assay office grades ore: precisely, conservatively, only from what is visible, and you say plainly when you cannot tell.\n\n'
    + 'Read the attached photograph.' + (k ? ` The owner says it is a ${k}. Use that for the valuation basis, but grade only from the photograph.` : ' The owner did not say what it is; identify it if you confidently can.') + '\n\n'
    + 'Reply with ONLY a JSON object, no prose, no code fence:\n{\n'
    + '  "isVehicle": boolean,\n'
    + '  "grade": "#1 Concours" | "#2 Excellent" | "#3 Good" | "#4 Fair" | "Modified - off the stock scale" | null,\n'
    + '  "gradeNote": "one short clause naming the biggest single reason for that grade",\n'
    + '  "confidence": number between 0 and 1 reflecting how much of the car this photograph actually shows,\n'
    + '  "flags": [ { "area": "short location", "note": "what you actually see", "severity": "minor"|"moderate"|"major" } ],\n'
    + '  "valuationBandUsd": [lowInteger, highInteger],\n'
    + '  "basis": "one short line naming what the valuation is anchored on",\n'
    + '  "nextBestPhoto": "the single photograph the owner should take next that would most change the number",\n'
    + '  "summary": "two sentences in the voice of a meticulous, plainspoken appraiser"\n}\n\n'
    + 'Rules: ground every flag in something actually visible — never invent damage. A clean panel is graded clean. '
    + 'If the car has been visibly modified from stock (aftermarket wheels, altered ride height, non-original drivetrain), say so and grade it as modified, because it comps against a different market. '
    + 'Widen the band when the photograph shows little or the model is thinly traded; a wide honest band beats a narrow false one. '
    + 'If the photograph shows no car, set isVehicle false, grade null, flags [], valuationBandUsd [0,0], and say what it shows in summary.';
}

class AssayError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function parseModelJSON(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new AssayError('invalid_json');
  try { return JSON.parse(t.slice(start, end + 1)); } catch { throw new AssayError('invalid_json'); }
}

async function runAssay({ imageBase64, mediaType, known }, { apiKey, model, fetchImpl = fetch }) {
  if (!apiKey) throw new AssayError('not_configured');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) throw new AssayError('image_rejected');
  if (!imageBase64 || imageBase64.length > 7_000_000) throw new AssayError('image_rejected');
  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 1500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: buildPrompt(known) },
        ] }],
      }),
    });
  } catch { throw new AssayError('upstream_error'); }
  if (res.status === 429 || res.status === 529) throw new AssayError('rate_limited');
  if (res.status === 400) throw new AssayError('image_rejected');
  if (!res.ok) throw new AssayError('upstream_error');
  const body = await res.json();
  if (body.stop_reason === 'refusal') throw new AssayError('refused');
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return parseModelJSON(text);
}

/** Small fixed-window limiter: per-client and site-wide, so a public page can't run up the bill. */
class Limiter {
  constructor({ perClientPerHour = 12, sitePerDay = 300 } = {}) {
    this.perClient = perClientPerHour; this.perDay = sitePerDay;
    this.clients = new Map(); this.day = { start: Date.now(), n: 0 };
  }
  take(client, now = Date.now()) {
    if (now - this.day.start > 86_400_000) this.day = { start: now, n: 0 };
    const c = this.clients.get(client);
    const cur = !c || now - c.start > 3_600_000 ? { start: now, n: 0 } : c;
    if (cur.n >= this.perClient || this.day.n >= this.perDay) return false;
    cur.n++; this.day.n++; this.clients.set(client, cur);
    return true;
  }
}

module.exports = { buildPrompt, runAssay, parseModelJSON, AssayError, Limiter };
