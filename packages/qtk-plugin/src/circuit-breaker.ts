// Per-compressor circuit breaker. If a compressor throws 3+ times in a
// session, it's disabled for the rest of the session. We never crash the
// agent loop because of a buggy regex.

const FAILURE_THRESHOLD = 3;

export class CircuitBreaker {
  private failures = new Map<string, number>();
  private disabled = new Set<string>();

  recordFailure(compressor: string): boolean {
    const n = (this.failures.get(compressor) ?? 0) + 1;
    this.failures.set(compressor, n);
    if (n >= FAILURE_THRESHOLD) {
      const wasDisabled = this.disabled.has(compressor);
      this.disabled.add(compressor);
      return !wasDisabled; // true if this call newly disabled it
    }
    return false;
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  reset(): void {
    this.failures.clear();
    this.disabled.clear();
  }

  stats(): { disabled: readonly string[]; failures: Record<string, number> } {
    return {
      disabled: [...this.disabled],
      failures: Object.fromEntries(this.failures),
    };
  }
}
