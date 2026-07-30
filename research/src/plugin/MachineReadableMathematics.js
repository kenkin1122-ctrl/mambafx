/**
 * research/src/plugin/MachineReadableMathematics.js
 *
 * Purpose:
 *   Utilities for constructing and validating three-form mathematical
 *   definitions used throughout Phase 11. Each definition carries:
 *     humanReadable       — prose description for scientists and reviewers
 *     symbolicExpression  — LaTeX formula for typesetting in publications
 *     executableFormula   — pure JS function for unit testing and verification
 *   Plus domain metadata: units, domain, range.
 *
 * Scientific rationale:
 *   "Machine-readable math" bridges the historically large gap between
 *   publication-quality formulas and their executable implementations.
 *   Having all three forms co-located enables automated cross-checking:
 *   a test can generate a fixture, run executableFormula, and compare
 *   against a hand-computed expected value derived from the LaTeX formula,
 *   catching implementation drift early. It also enables auto-generated
 *   documentation that is guaranteed to match the code.
 *
 * Dependencies: none.
 * Public API: createMathDefinition, validateMathDefinition,
 *   MachineReadableMathematicsError.
 * Complexity: O(1) for all operations.
 */

export class MachineReadableMathematicsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MachineReadableMathematicsError';
  }
}

/**
 * Validates a MathDefinition plain object without throwing.
 * Returns { valid: boolean, errors: string[] }.
 *
 * O(1).
 *
 * @param {object} def
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMathDefinition(def) {
  if (!def || typeof def !== 'object') {
    return { valid: false, errors: ['mathDefinition: expected a non-null object'] };
  }
  const errors = [];

  if (!def.humanReadable || typeof def.humanReadable !== 'string')
    errors.push('humanReadable: required non-empty string (prose description)');
  if (!def.symbolicExpression || typeof def.symbolicExpression !== 'string')
    errors.push('symbolicExpression: required non-empty string (LaTeX formula)');
  if (typeof def.executableFormula !== 'function')
    errors.push('executableFormula: required callable function (pure JS implementation)');
  if (!def.units || typeof def.units !== 'string')
    errors.push('units: required non-empty string (e.g. "price", "dimensionless", "ticks/s")');
  if (!def.domain || typeof def.domain !== 'string')
    errors.push('domain: required non-empty string describing valid input space');
  if (!def.range || typeof def.range !== 'string')
    errors.push('range: required non-empty string describing valid output space');

  return { valid: errors.length === 0, errors };
}

/**
 * Constructs and freezes a MathDefinition object.
 * Throws MachineReadableMathematicsError for any invalid field.
 *
 * O(1).
 *
 * @param {{
 *   humanReadable: string,
 *   symbolicExpression: string,
 *   executableFormula: Function,
 *   units: string,
 *   domain: string,
 *   range: string
 * }} def
 * @returns {Readonly<object>}
 */
export function createMathDefinition(def) {
  const { valid, errors } = validateMathDefinition(def);
  if (!valid) {
    throw new MachineReadableMathematicsError(
      `createMathDefinition: invalid definition — ${errors.join('; ')}`
    );
  }
  return Object.freeze({
    humanReadable:      def.humanReadable,
    symbolicExpression: def.symbolicExpression,
    executableFormula:  def.executableFormula,
    units:              def.units,
    domain:             def.domain,
    range:              def.range,
  });
}
