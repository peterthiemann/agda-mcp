import type { AgdaProtocolAdapter } from "../adapter.js";
import { agda280Adapter, createAgdaAdapter } from "./agda-2.8.0.js";

// Only constraints syntax and top-level show rendering are adapted here; this
// does not certify general 2.9.0 compatibility. Other versions retain the baseline.
const agda290Adapter = createAgdaAdapter("2.9.0", "Cmd_constraints AsIs", true);

export function selectAgdaAdapter(version: string): AgdaProtocolAdapter {
  // Official release binaries may append their source commit to --numeric-version.
  return /^2\.9\.0(?:-[0-9a-f]{7,40})?$/.test(version) ? agda290Adapter : agda280Adapter;
}
