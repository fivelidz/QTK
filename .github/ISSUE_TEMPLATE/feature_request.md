---
name: Feature request / new compressor
about: Suggest a new compressor or a runtime improvement
labels: enhancement
---

## The output you'd like compressed

<!--
What command produces output that QTK currently doesn't handle (or handles
poorly)? Paste a representative sample of the raw output (REDACT secrets!).
-->

```
[paste raw output here]
```

Bytes: <how many>  ·  Tokens (est, chars/4): <how many>

## What you'd want the compressed form to look like

<!--
Show what the model should see instead. Don't overthink it — even
a rough sketch helps.
-->

```
[paste your suggested compressed form here]
```

## Why this matters

<!--
How often does this command run in your typical session? Roughly how many
tokens does it eat across a day's work? If you've measured with
`qtk gain --all`, paste the relevant row.
-->

## Existing options

- [ ] Is there an RTK filter for this? RTK has 100+ filters; consider checking
      https://github.com/rtk-ai/rtk before opening here.
- [ ] Could this be a TOML DSL filter in `.opencode/qtk/filters/`? If you've
      already tried that and it didn't work, paste your attempt.
- [ ] Does it need the Rust sidecar (heavy parsing — XML, structured YAML,
      tree-walking JSON) or can a TS compressor handle it?

## Anything else?
