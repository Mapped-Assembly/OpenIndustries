/** Read OI_* first, falling back to ASTRA_* only when the new name is absent. */
export function oiEnv(suffix: string, environment?: Record<string, string | undefined>): string | undefined;
