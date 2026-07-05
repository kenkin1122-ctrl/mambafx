/**
 * utils/color.js
 */

/**
 * Convert a #rrggbb hex color to an rgba() string at the given alpha.
 * @param {string} hex
 * @param {number} a 0..1
 */
export function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
