# Experimental verification scripts

This directory contains reproducible protocol and failure-injection probes. It
is deliberately kept outside the production runtime. A spike may document or
verify a contract, but production code must depend on the stable modules under
`src/connector`, `src/codex`, `src/agents`, `src/reliability`, and
`src/transport` instead of importing a spike.

## Naming and lifecycle

- `handshake`, `protocol-contract`, and `remote-control-contract` verify wire
  compatibility.
- `approval-*`, `decision-race`, and `writer-release` verify consequence and
  concurrency boundaries.
- `crash-window`, `listener-restart`, and `token-lifecycle` are failure and
  recovery probes.
- `gemini-e2e`, `zcode-app-server`, and `remote-tui` are provider-specific
  experiments.

Keep each script runnable through the existing `npm run spike:*` command. When
a result becomes a supported behavior, add a focused test under `test/` or the
relevant workspace and update the decision record; do not grow the spike into
another runtime implementation.
