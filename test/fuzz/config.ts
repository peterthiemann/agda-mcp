function positiveIntegerEnvironment(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export const PROPERTY_RUNS = positiveIntegerEnvironment("AGDA_MCP_PROPERTY_RUNS", 1_000);
export const FUZZ_RUNS = positiveIntegerEnvironment("AGDA_MCP_FUZZ_RUNS", 5_000);
export const FUZZ_SEED = positiveIntegerEnvironment("AGDA_MCP_FUZZ_SEED", 0x28da2028);
