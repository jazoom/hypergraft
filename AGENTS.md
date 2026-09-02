# AGENTS.md

## Project overview

Hypergraft is a bounded HTML-over-HTTP and WebSocket protocol with a JavaScript-required browser runtime. Version 1 of the Rust crate targets Axum and Askama.

## Notes to agent

- You may run `mise` commands. At the end of your work you MUST run `mise run clean`. If there are errors or warnings you MUST fix them, then run `mise run clean` again.
- Do not broaden protocol version 1 without an explicit plan. Treat `protocol-v1.json` as the canonical protocol fixture before you change request, response, live socket or browser behaviour.
- HTTP still serves initial documents, canonical GET pages and real link and form markup. JavaScript is required for live projections and command patches. Command routes extract `PatchGraft`. A native POST without patch metadata receives a no-store 400 before domain work. The server stays authoritative.
- Hosts register projection factories and one connection guard. Do not add a host socket loop, protocol codec, subscription map or reconnect policy.
- The version 1 Rust host is Axum and Askama. Do not add a second host adapter unless a plan asks for it.
- Use Australian English spelling and grammar for all text, code comments, documentation and user-facing output. Do not use title case for the text of titles, buttons or headings. Only capitalise the first letter of the first word.
- Comment a file, module, function or block only when a later reader could break a why, an invariant, a security contract, a protocol bound or a non-obvious constraint.

## Tests

Tests are liability. Add a test only when it pins an invariant the compiler cannot catch.

Write:

- Protocol: request classification, envelope bounds, live socket bounds and the browser state machine.
- Cross-language lock-step with `protocol-v1.json`.
- Island registry behaviour that this crate owns.

Do not write:

- Host product tests.
- Tests that restate a trivial map or match.
- An end-to-end browser suite unless explicitly asked.
