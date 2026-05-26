// Sidecar protocol types — mirror the Rust side. Keep these in sync with
// packages/qtk-core/src/protocol.rs.

export interface SidecarRequest {
  id: number;
  compressor: string;
  input: string;
}

export interface SidecarOk {
  id: number;
  ok: true;
  output: string;
  ratio: number;
}

export interface SidecarErr {
  id: number;
  ok: false;
  error: string;
}

export type SidecarResponse = SidecarOk | SidecarErr;

export interface SidecarHello {
  kind: "hello";
  version: string;
  compressors: string[];
}

export interface SidecarOptions {
  /** Absolute path to the qtk-core binary. */
  readonly binaryPath: string;
  /** Per-request timeout in ms. Default: 1000ms. */
  readonly requestTimeoutMs?: number;
  /** How long to wait for the bootstrap `hello` line. Default: 1500ms. */
  readonly startupTimeoutMs?: number;
  /** Max consecutive restarts before we permanently disable. Default: 3. */
  readonly maxRestarts?: number;
}
