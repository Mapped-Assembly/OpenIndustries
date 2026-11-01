/** Read an OpenIndustries setting, retaining ASTRA_* as a compatibility fallback.
 * Explicit OI_* values, including empty strings, always take precedence.
 * @param {string} suffix Setting name without its OI_ prefix.
 * @param {Record<string, string | undefined>} environment Environment to inspect.
 * @returns {string | undefined} The configured value, without mutating either name.
 */
export function oiEnv(suffix, environment = process.env) {
  return environment[`OI_${suffix}`] ?? environment[`ASTRA_${suffix}`];
}
