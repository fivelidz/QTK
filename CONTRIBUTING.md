# Contributing to QTK

> One-person project right now. This doc captures the conventions so future
> contributors (or future me) can pick up the rhythm.

---

## Project shape

- Bun workspace (`packages/qtk-plugin`, etc.)
- Strict TypeScript (`tsconfig.json` has `strict: true`)
- No external runtime deps in `qtk-plugin` (other than `@opencode-ai/plugin`
  types as a peer dep)
- Tests with `bun test`
- Style guide: same as opencode's `STYLE_GUIDE.md`
  - Prefer single-word variable names
  - Avoid `let`, `else`, `try/catch` where reasonable
  - Avoid `any`
  - Use Bun APIs (`Bun.file`, `Bun.write`) over Node equivalents

---

## Adding a new compressor

### Phase 1 (TS-only)

1. Create `packages/qtk-plugin/src/compressors/<name>.ts`
2. Implement the `Compressor` interface from `types.ts`
3. Register it in `packages/qtk-plugin/src/registry.ts`
4. Add fixtures to `packages/qtk-plugin/test/fixtures/<name>/`:
   - `input.txt` — raw output captured from a real invocation
   - `expected.txt` — the compressed form you expect
5. Add a test case in `packages/qtk-plugin/test/<name>.test.ts`:

   ```ts
   import { describe, expect, test } from "bun:test";
   import { compress } from "../src/compressors/<name>.ts";

   test("compresses standard output", () => {
     const input = await Bun.file("test/fixtures/<name>/input.txt").text();
     const expected = await Bun.file(
       "test/fixtures/<name>/expected.txt",
     ).text();
     expect(compress(input, ctx)).toBe(expected);
   });
   ```

### Phase 2 (TOML DSL)

For commands that don't need imperative logic, just drop a TOML file in
`packages/qtk-filters/examples/` and add a test case that loads it and
runs it against a fixture.

---

## Capturing fixtures

To capture a realistic raw output for a fixture:

```bash
# Run the command and save its full output verbatim
my-command 2>&1 > test/fixtures/my-command/input.txt
# Then hand-craft expected.txt for what you'd want it to look like
```

For commands that produce different output on different machines (e.g.
`docker ps` includes container IDs), scrub the variable parts:

```bash
sed -E 's/[a-f0-9]{12,}/<container-id>/g' raw.txt > test/fixtures/.../input.txt
```

---

## What makes a good compressor

1. **Pure function.** No I/O, no `Date.now()`, no `Math.random()`. Same
   input must always produce same output. This is what makes tests
   deterministic.

2. **Cheap.** Single-pass over the input string ideally. No nested loops
   over thousands of lines. Single pre-compiled regex object reused
   across calls.

3. **Bounded.** Output size must be a function of `min(input_size,
max_output)`. Never produce more output than you got in.

4. **Failure-tolerant.** Empty input → empty output (or input unchanged).
   Binary input → input unchanged. Adversarial input (10MB of `aaa`)
   → bounded latency, no crash.

5. **Domain-aware.** A `git status` compressor knows what `?? ` means
   versus `M`. A test runner compressor knows that failures are
   important, passes are noise. The cleverness lives here.

---

## Pull request checklist

- [ ] New compressor has fixtures + tests
- [ ] `bun test` passes
- [ ] `bun run typecheck` passes (no `any`, all strict)
- [ ] Benchmark added to `scripts/benchmark.ts` if compressor handles a new
      command type
- [ ] Compression ratio on the fixture is ≥ 50%
- [ ] p99 latency on adversarial input is ≤ 20 ms
- [ ] If the compressor accesses anything outside the input string
      (config, FS), reviewer must explicitly bless it
- [ ] Docs updated if the change affects public API

---

## Code review focus areas

1. **Catastrophic backtracking** — every new regex should be inspected for
   nested quantifiers (`(a+)+`, `(a|a)+`, etc.). Tools: regex101.com
   has a debugger; rust-fuzz has corpora.

2. **Output size monotonicity** — output bytes should be ≤ input bytes.
   If your compressor can ever produce a larger output, add an explicit
   guard:

   ```ts
   if (out.length > input.length) return input;
   ```

3. **Privacy** — does the compressor accidentally include or expose
   information not in the original output? E.g. resolving relative paths
   to absolute, including timestamps, etc. Keep it minimal.

4. **TOML DSL filters** — when reviewing a filter, mentally trace the
   regex match against several variations of the example input. Filters
   that fail to match silently drop everything, which is a worse failure
   mode than no compression.

---

## Releasing

Maintainer-only:

```bash
# 1. Bump version in package.json
# 2. Update CHANGELOG.md (TODO — add this in Phase 1 wrap-up)
# 3. Tag
git tag v0.x.y
git push --tags

# 4. Publish (eventually, when stable enough)
cd packages/qtk-plugin
npm publish --access public
```
