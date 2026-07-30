/**
 * research/src/core/sha256.js
 *
 * Purpose:
 *   Portable SHA-256 utility using the Web Crypto API (globalThis.crypto.subtle),
 *   available natively in Node.js 18+ (confirmed available: Node 20.20.0) and all
 *   modern browsers on secure contexts. Used by Phase 11 modules to compute
 *   content-addressed identifiers (fingerprints, config hashes, freeze IDs) from
 *   canonical JSON representations of data structures.
 *
 * Scientific rationale for content addressing:
 *   Cryptographic hashes make identity tamper-evident: two records with the same
 *   SHA-256 hash are provably identical (with overwhelming probability), and any
 *   change to any field produces a different hash. This property underpins
 *   ReproducibilityGate's ability to certify that publication-time conditions are
 *   identical to discovery-time conditions, months or years later.
 *
 * Dependencies: globalThis.crypto.subtle (no imports — Web Crypto is a platform global).
 * Public API: canonicalJson, sha256, sha256Canonical.
 * Complexity: canonicalJson O(n log n) in total key count; sha256 O(n) in byte length.
 * Threading: async — delegates to the platform's native crypto primitive.
 */

/**
 * Deterministic JSON serialization: recursively sorts object keys so that
 * identical object structures produce the same string regardless of insertion order.
 *
 * O(n log n) where n is the total number of key-value pairs across all nesting levels.
 *
 * @param {*} value - Any JSON-serializable value.
 * @returns {string} Canonical JSON string.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/**
 * Computes SHA-256 of the given string, returns a 64-character lowercase hex digest.
 * Requires globalThis.crypto.subtle (Node.js 18+ / modern browsers on HTTPS).
 *
 * O(n) in the input byte length.
 *
 * @param {string} text - UTF-8 text to hash.
 * @returns {Promise<string>} 64-character lowercase hex string.
 */
export async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convenience: compute SHA-256 of the canonical JSON of any value.
 * Combines canonicalJson + sha256 in one call.
 *
 * O(n log n) + O(m) where n is the key count and m is the resulting JSON byte length.
 *
 * @param {*} value - Any JSON-serializable value.
 * @returns {Promise<string>} 64-character lowercase hex string.
 */
export async function sha256Canonical(value) {
  return sha256(canonicalJson(value));
}
