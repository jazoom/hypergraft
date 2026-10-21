# Security

Hypergraft expects trusted HTML from the host. The browser runtime parses that HTML through a private Trusted Types policy named `hypergraft`. The policy is a passthrough. It does not sanitise markup. It does not make untrusted HTML safe.

Imports do not create the policy. The first required parse creates it. Later parses in that module instance reuse the created policy.

## Content security policy

This header is a working baseline for `http://127.0.0.1:3000`. The host serves scripts and styles from the same origin.

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ws://127.0.0.1:3000; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types hypergraft
```

The explicit WebSocket source avoids browser differences in the interpretation of `'self'`. `LiveEndpoint::csp_connect_src` supplies that source for the host endpoint.

Image and style sources belong to the host. A host can add a script nonce when a document needs one inline script.

Do not add `allow-duplicates` to `trusted-types`.
Do not install a global passthrough policy.

## Lazy island readiness

Optional lazy islands load host-selected code through standard dynamic imports under the existing script policy. They require no inline script, `unsafe-inline`, `unsafe-eval` or new Trusted Types policy. Do not derive import paths from untrusted markup. Keep imported module evaluation free of application side effects: a load can complete after its root or runtime has gone.

Lazy loading does not block links, forms or Hypergraft commands. Controls remain usable while loading and after failure unless the host explicitly guards them. A lazy listener cannot enforce consent, restore required settings before submission, or guard a command that arrives before mount. Keep those owners eager. If controls must wait, render their disabled state on the server, cover external controls and alternate submit paths, and provide an independent recovery path. Bind any explicit retry control eagerly. A successful `retryIsland(root)` return only means that a retry was scheduled; it is not readiness or consent. Never enable a command merely because an import completed. Server validation and authorisation remain authoritative.

Read [Optional lazy islands](browser-runtime.md#optional-lazy-islands) for lifecycle, failure and readiness contracts. Island exceptions use `startHypergraft({ onIslandError })` or the reporter passed to `observeIslands`, with arguments `(name, phase, error, root)`. These callbacks receive the original exception and affected DOM element, not secret-safe transport diagnostics. Hosts must not expose sensitive exception details or DOM contents to users or logs. Use the root reference to identify the failed feature and show a generic message; a report is not evidence of readiness or permission to submit. Callbacks must not throw. Without a custom callback, the existing console reporter remains in use.

## Trusted Types

`TRUSTED_TYPES_POLICY_NAME` is `hypergraft`. The policy lets `DOMParser` read server HTML when the document requires Trusted Types for scripts. The policy is not an HTML sanitiser.

If CSP denies the `hypergraft` policy, policy creation fails. The failure uses the ordinary protocol error path. Safe requests fall back. Unsafe requests become uncertain. No response patch applies.

## Single runtime copy

The supported integration contains one bundled Hypergraft runtime copy. Two separately evaluated copies share the policy name. The first copy can create the policy. The second copy can import without policy creation. The first parse in the second copy fails as a protocol error when CSP rejects a duplicate name.

A second copy is not a supported integration.
