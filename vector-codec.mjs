// vector-codec.mjs — storage codec for memories.content_vector
//
// Storage format is Float32, one 4-byte lane per dimension, in the host's
// native byte order (Float32Array; not an explicitly serialised endianness).
// Every supported target — x64, arm64 — is little-endian, and sqlite-vec's
// own index makes the identical assumption, so a DB file carried to a
// big-endian host would mis-decode both columns alike. Held as a BLOB in
// the existing TEXT-affinity column. SQLite never coerces
// BLOB values on the way in, so `typeof(content_vector)` reliably reports
// 'blob' for encoded rows and 'text' for legacy JSON rows — that is what the
// migration keys on, and it needs no schema change.
//
// Why Float32 instead of the JSON array this column used to hold: measured on
// a 10,920-row library (2026-09-03), the JSON form averaged 21,723 bytes per
// 1024-dim vector against 4,096 for Float32 — 226 MB against 43 MB. It is
// lossless, not approximate: every one of 2,048,000 sampled stored values
// satisfied Math.fround(x) === x. The embedding API already returns float32;
// JSON was spending 5x the bytes to spell the same 32-bit values out in
// decimal. sqlite-vec's KNN index is Float32 as well, so recall has always
// run at this precision.
//
// decodeVector accepts both formats so no reader needs to know which era a
// row is from, and the migration can be interrupted anywhere and resumed.

/**
 * @param {number[]|Float32Array|null|undefined} vec
 * @returns {Buffer|null} little-endian Float32 bytes, or null for empty input
 */
export function encodeVector(vec) {
  if (!vec || typeof vec.length !== 'number' || vec.length === 0) return null
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec)
  // Symmetric with decodeVector: a NaN, an Infinity, or a double beyond
  // float32 range (which Float32Array.from silently turns into ±Infinity)
  // must not be written. Stored, it would count as "covered" for every
  // `!= ''` check while decoding to null forever — a vector no sweep repairs.
  if (!f32.every(Number.isFinite)) return null
  // Copy out of any shared ArrayBuffer so the stored bytes cannot alias a
  // caller's typed array that is later mutated.
  return Buffer.from(f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength))
}

/**
 * @param {Buffer|Uint8Array|string|null|undefined} stored
 * @returns {number[]|null} plain array of finite numbers, or null if unusable
 */
export function decodeVector(stored) {
  if (stored == null) return null
  if (stored instanceof Uint8Array) {           // Buffer is a Uint8Array subclass
    if (stored.byteLength === 0 || stored.byteLength % 4 !== 0) return null
    // A Buffer handed back by the driver may sit at an unaligned offset inside
    // a slab; Float32Array views require 4-byte alignment, so copy first.
    const aligned = new Uint8Array(stored.byteLength)
    aligned.set(stored)
    const out = Array.from(new Float32Array(aligned.buffer))
    return out.every(Number.isFinite) ? out : null
  }
  if (typeof stored === 'string') {
    const s = stored.trim()
    if (!s.startsWith('[')) return null
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'number' && Number.isFinite(x)) ? v : null
    } catch { return null }
  }
  return null
}

/**
 * Classify a stored value without decoding it. Used for reporting and tests.
 * @returns {'blob'|'json'|'empty'|'unknown'}
 */
export function vectorStorageKind(stored) {
  if (stored == null || stored === '') return 'empty'
  if (stored instanceof Uint8Array) return 'blob'
  if (typeof stored === 'string') return 'json'
  return 'unknown'
}
