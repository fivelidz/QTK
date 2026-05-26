# Security Policy

The full threat model and design discussion lives in
[`docs/SECURITY.md`](docs/SECURITY.md). This file is the short version
that GitHub looks for in the repo root.

## Supported versions

QTK is at `0.x` and follows SemVer's "0.x is unstable" convention. We
only patch security issues on the latest `0.x` release. If you're
running an older `0.x`, please upgrade.

## Reporting a vulnerability

Please do **not** open a public GitHub issue.

Use the private security advisory channel:

  https://github.com/fivelidz/QTK/security/advisories/new

Or email the maintainer at the address on the [@fivelidz](https://github.com/fivelidz)
GitHub profile.

We commit to acknowledging within 7 days, providing an initial
assessment within 14 days, and disclosing fixed vulnerabilities in
`CHANGELOG.md` with credit to the reporter (if desired) once a fix has
shipped.

Coordinated disclosure: default 90-day deadline from acknowledgement.

## Out of scope

- Issues in opencode itself → https://github.com/sst/opencode/security
- Issues in RTK (which QTK's DSL design is downstream of) →
  https://github.com/rtk-ai/rtk/security
- Issues in dependencies (Bun, Rust, quick-xml, serde, regex) → those
  upstreams
- "Malicious opencode plugin can do bad things" — inherent to opencode's
  trust model, not specific to QTK

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full discussion and
the design decisions that came out of auditing RTK.
