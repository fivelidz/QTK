// SidecarClient — long-lived JSON-RPC pipe to qtk-core.
//
// Design goals:
//   - One subprocess per opencode session, reused for thousands of calls.
//   - Per-request promises correlated by monotonically-increasing id.
//   - Auto-restart on crash up to maxRestarts, then permanently disable.
//   - Never blocks the agent loop — request timeout falls back to caller.
//   - Never throws — any error returns null and the caller falls back to TS.
//
// Why a hand-rolled client (no MCP, no JSON-RPC lib): the protocol is
// trivial (NDJSON in/out), the dep would be larger than the code, and we
// want exact control over timeouts and restarts.

import type { SidecarHello, SidecarOptions, SidecarResponse } from "./types.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 1500;
const DEFAULT_MAX_RESTARTS = 3;

interface PendingRequest {
  resolve: (out: { output: string; ratio: number } | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * State machine:
 *   "starting"    spawn issued, awaiting hello
 *   "ready"       hello received, accepting requests
 *   "crashed"     subprocess died, restart in flight (or pending)
 *   "disabled"    too many restarts, give up for the session
 *   "stopped"     stop() was called explicitly
 */
type State = "starting" | "ready" | "crashed" | "disabled" | "stopped";

export class SidecarClient {
  private readonly opts: Required<SidecarOptions>;

  private state: State = "starting";
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  /** Buffered partial line from the child's stdout. */
  private stdoutTail = "";

  /** Available compressor names reported by the sidecar's hello message. */
  private compressors: ReadonlySet<string> = new Set();

  /** Bookkeeping: number of restarts within this client lifetime. */
  private restartCount = 0;

  /** Resolved once the child reports `hello`. Re-created on each restart. */
  private readyPromise!: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;

  constructor(opts: SidecarOptions) {
    this.opts = {
      binaryPath: opts.binaryPath,
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      startupTimeoutMs: opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      maxRestarts: opts.maxRestarts ?? DEFAULT_MAX_RESTARTS,
    };
    this.armReadyPromise();
  }

  /**
   * Spawn the subprocess (idempotent — calling twice is a no-op).
   * Resolves when `hello` is received, or rejects on startup timeout / spawn failure.
   */
  async start(): Promise<void> {
    if (this.state === "ready" || this.state === "starting") {
      if (this.proc) return this.readyPromise;
    }
    if (this.state === "disabled" || this.state === "stopped") {
      throw new Error(`SidecarClient in terminal state: ${this.state}`);
    }
    this.spawn();
    return this.readyPromise;
  }

  /**
   * Send a compression request. Returns null if:
   *   - the sidecar is disabled / stopped
   *   - the compressor name isn't supported by the binary
   *   - the request times out (caller should fall back to TS)
   *   - the sidecar reports an error for this request
   *
   * Never throws — callers can treat null as "this didn't work, do
   * something else".
   */
  async compress(
    compressor: string,
    input: string,
  ): Promise<{ output: string; ratio: number } | null> {
    if (this.state === "disabled" || this.state === "stopped") return null;

    // Lazy start
    if (this.state === "starting" || this.state === "crashed") {
      try {
        await this.start();
      } catch {
        return null;
      }
    }

    if (this.state !== "ready") return null;
    if (!this.compressors.has(compressor)) return null;
    if (!this.proc?.stdin) return null;

    const id = this.nextId++;
    const reqLine = JSON.stringify({ id, compressor, input }) + "\n";

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve(null);
        }
      }, this.opts.requestTimeoutMs);

      this.pending.set(id, { resolve, timer });

      try {
        const writer = this.proc!.stdin as WritableStreamDefaultWriter<Uint8Array> | unknown;
        // Bun.spawn returns a Subprocess; stdin is either a FileSink or a
        // WritableStream depending on options. We always pass `stdin: "pipe"`
        // so it's a FileSink with `.write` and `.flush`.
        // Bun's FileSink: write returns bytes written; flush returns a Promise.
        // We treat it as duck-typed:
        const fileSink = writer as {
          write: (data: string | Uint8Array) => number;
          flush?: () => Promise<number>;
        };
        fileSink.write(reqLine);
        // We don't need to await flush — Bun flushes on next event tick anyway.
      } catch (e) {
        // Stdin closed under us — treat as crash
        clearTimeout(timer);
        this.pending.delete(id);
        this.onCrash();
        resolve(null);
      }
    });
  }

  /**
   * Stop the sidecar permanently. After this, all future `compress()`
   * calls return null.
   */
  async stop(): Promise<void> {
    this.state = "stopped";
    this.cancelAllPending("stopped");
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      try {
        await this.proc.exited;
      } catch {
        // ignore
      }
      this.proc = null;
    }
  }

  /** True if the sidecar is alive and accepting requests. */
  isReady(): boolean {
    return this.state === "ready";
  }

  /** Names of compressors the running sidecar can handle. */
  availableCompressors(): readonly string[] {
    return [...this.compressors];
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private armReadyPromise() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  private spawn() {
    this.state = "starting";
    this.armReadyPromise();
    this.stdoutTail = "";

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.opts.binaryPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      this.state = "disabled";
      this.readyReject(e as Error);
      return;
    }
    this.proc = proc;

    // Startup timeout
    const startupTimer = setTimeout(() => {
      if (this.state === "starting") {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        this.state = "disabled";
        this.readyReject(new Error("sidecar startup timeout"));
      }
    }, this.opts.startupTimeoutMs);

    // Pump stdout
    this.consumeStdout(proc, startupTimer);

    // Watch for unexpected exit
    proc.exited.then((code) => {
      if (this.state === "stopped" || this.state === "disabled") return;
      // Unexpected death
      this.onCrash(code ?? undefined);
    });
  }

  private async consumeStdout(
    proc: NonNullable<typeof this.proc>,
    startupTimer: ReturnType<typeof setTimeout>,
  ) {
    const stdout = proc.stdout;
    // We spawned with stdin/stdout: "pipe" so this is a ReadableStream,
    // but the TS type is `number | ReadableStream`. Narrow defensively.
    if (!stdout || typeof stdout === "number") {
      // No pipe — can't communicate; abort.
      try {
        proc.kill();
      } catch {
        // ignore
      }
      this.state = "disabled";
      this.readyReject(new Error("sidecar stdout not piped"));
      return;
    }
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.stdoutTail += text;
        let nl: number;
        while ((nl = this.stdoutTail.indexOf("\n")) !== -1) {
          const line = this.stdoutTail.slice(0, nl);
          this.stdoutTail = this.stdoutTail.slice(nl + 1);
          if (line.length === 0) continue;
          this.onLine(line, startupTimer);
        }
      }
    } catch {
      // reader.read() can fail on subprocess death; the exited handler
      // covers that path.
    }
  }

  private onLine(line: string, startupTimer: ReturnType<typeof setTimeout>) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Garbage line — ignore
      return;
    }

    // Bootstrap hello
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { kind?: string }).kind === "hello"
    ) {
      const h = parsed as SidecarHello;
      this.compressors = new Set(h.compressors ?? []);
      clearTimeout(startupTimer);
      this.state = "ready";
      this.readyResolve();
      return;
    }

    // Response
    const r = parsed as SidecarResponse;
    if (typeof r.id !== "number") return;
    const pending = this.pending.get(r.id);
    if (!pending) return; // late / cancelled
    clearTimeout(pending.timer);
    this.pending.delete(r.id);
    if (r.ok) {
      pending.resolve({ output: r.output, ratio: r.ratio });
    } else {
      pending.resolve(null);
    }
  }

  private onCrash(code?: number) {
    if (this.state === "stopped" || this.state === "disabled") return;
    this.cancelAllPending("crash");
    this.state = "crashed";
    this.proc = null;

    this.restartCount++;
    if (this.restartCount > this.opts.maxRestarts) {
      console.warn(
        `[qtk] sidecar crashed ${this.restartCount}× (exit=${code ?? "?"}); disabling for session`,
      );
      this.state = "disabled";
      this.readyReject(new Error("sidecar disabled after max restarts"));
      return;
    }
    console.warn(
      `[qtk] sidecar crashed (exit=${code ?? "?"}); restarting (${this.restartCount}/${this.opts.maxRestarts})`,
    );
    this.spawn();
  }

  private cancelAllPending(reason: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
    void reason; // logged via console in onCrash
  }
}
