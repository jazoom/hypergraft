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

## Trusted Types

`TRUSTED_TYPES_POLICY_NAME` is `hypergraft`. The policy lets `DOMParser` read server HTML when the document requires Trusted Types for scripts. The policy is not an HTML sanitiser.

If CSP denies the `hypergraft` policy, policy creation fails. The failure uses the ordinary protocol error path. Safe requests fall back. Unsafe requests become uncertain. No response patch applies.

## Single runtime copy

The supported integration contains one bundled Hypergraft runtime copy. Two separately evaluated copies share the policy name. The first copy can create the policy. The second copy can import without policy creation. The first parse in the second copy fails as a protocol error when CSP rejects a duplicate name.

A second copy is not a supported integration.
