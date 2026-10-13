# Child reconciler

## Plan and scope

Replace only Morphlex's browser child reconciliation. Keep Askama, ordinary HTML, public IDs, the two patch operations and `protocol-v1.json` unchanged. Do not revive the archived template compiler or generated identity markers.

The replacement is private to the patch adapter. Hypergraft continues to own preflight, focus restoration, pending state and island lifetimes. There is no public morphing API, HTML parser, document replacement mode, client-change preservation option or general hook system.

## Matching contract

- A `children` patch keeps its target and its attributes. An `append` patch adds nodes without matching existing children.
- Matching is sibling-local. Moving between parents or patch targets does not promise retained identity.
- Elements must have the same namespace and local name. HTML inputs must also have the same native input type.
- An ID matches only the same ID. Adding, removing or changing an ID replaces that element.
- Without an ID, the first non-empty `name`, `href` or `src` attribute is a matching hint, in that order. Only an equal hint on a compatible sibling matches.
- Prefer compatible equal nodes at the common or crossed ends of each sibling list. This handles unchanged edges, insertions and rotations without an all-pairs search. Remaining compatible siblings, including repeated hints, match in order. Text and comment nodes have separate queues. Whitespace is ordinary text.
- Important control, island and list identities need explicit IDs. Equality is only a reuse optimisation, not an identity guarantee for unkeyed rows. This deliberately replaces Morphlex's undocumented all-pairs equality search and tag-only fallback across different hints.
- Reorders use a longest increasing subsequence to avoid unnecessary moves. Use native state-preserving moves where available and valid, otherwise use ordinary insertion. No matching state survives an application.

## Authoritative state

Attributes, including namespaced attributes and removals, follow the prepared source. Template contents are reconciled as a separate child tree. Native form members bypass named controls; other elements retain their application overrides and exceptions.

Prepare detached source containers, then capture incoming form-control properties before mutating live targets or taking source subtrees apart. Restore control values, checked state, indeterminate state and selection after the whole batch. File inputs are cleared, never assigned a non-empty value. Radio groups and selects need final restoration after structural changes. An unchanged subtree must still restore dirty controls.

Every retained descendant element reports its source to pending-state ownership when that callback is present, including equal subtrees. Patch targets themselves have no newly authored attributes and are not reported. Existing focus and island handling remains outside the reconciler.

## Correctness checks

Add focused browser contracts for attribute removal, namespaces, templates, form-property shadowing, control properties, sibling identity and both move paths. Retain the existing focus, pending, island, preflight and CSP contracts. Seeded generated cases check final structure, authoritative properties and retained keyed identity rather than treating Morphlex as a correctness oracle.

Run the unit suite and the focused browser suite in Chromium, Firefox and WebKit. Record any unavailable engine rather than claim it passed.

## Performance gate

Compare the released Morphlex adapter at `1903088` with the replacement using identical Askama output. Include 1,000-row keyed and unkeyed unchanged snapshots, insertion, deletion and reorder, dirty controls, a small target in a large document, and append. Measure application separately and preflight plus application together. Alternate engine order, warm up and retain raw samples and browser versions.

The switch requires no material regression in the median combined interval for any workload: allow at most the larger of 15% of the baseline or 0.5 ms. Inspect application medians and tail samples as well; the combined gate must not conceal a new growth problem. Report differences in unkeyed identity semantics. No claim about network, layout, paint or server render speed follows from these measurements.

## Implementation results

The replacement is implemented in `browser/morph.ts`; Morphlex is removed from the package and lockfile. The reconciler uses no persistent cache or generated marker. Sibling matching and ordering use linear storage, with an O(n log n) ordering pass rather than an all-pairs search. Equal edges and unchanged subtrees avoid unnecessary work without skipping control restoration or ownership callbacks.

All 410 unit tests and 62 Rust tests pass. All 84 focused browser contracts pass in Chromium and Firefox, including 15 new cases and a deterministic 120-step generated patch sequence. The existing focus, pending ownership, island, preflight and CSP contracts remain enabled. The reference application builds and `mise run clean` passes.

A separate browser check exercised user-edited inputs, an unchecked authoritative checkbox, attribute removal, a control named `childNodes` and a retained template. It retained the intended elements and restored the source state without console errors, page errors or failed requests.

WebKit cannot launch on this host: its Playwright build needs `libicudata.so.74` and other unavailable shared libraries. There is no local WebKit correctness or performance result. The existing CI WebKit job remains required before release.

### Measurements

`scripts/bench-morph.mjs` runs the comparison and records source and bundle hashes, the generated fixture hash, browser versions and raw samples. Raw result files are not committed. `examples/morph-fixtures.rs` renders the shared Askama fixtures. Neither compiler output nor envelope size differs between engines.

Four rounds alternate baseline/replacement order. Each workload has five warm-ups and 25 measured samples per engine per round. The table reports pooled median preflight plus application time in milliseconds. Rows contain 1,000 articles; the dirty-control case contains 200 inputs and 200 textareas and enables ownership callbacks. Insertion adds 100 rows, deletion removes every fifth row, shuffle groups even rows before odd rows, and replacement changes all row identifiers. Append adds 100 rows to an existing 1,000.

| Workload            | Chromium baseline | Chromium replacement | Firefox baseline | Firefox replacement |
| ------------------- | ----------------: | -------------------: | ---------------: | ------------------: |
| Keyed unchanged     |               5.7 |                  3.1 |               15 |                   3 |
| Keyed insertion     |               7.3 |                  4.2 |               20 |                   4 |
| Keyed deletion      |               6.7 |                  4.1 |               22 |                   5 |
| Keyed reverse       |              13.9 |                  4.4 |               31 |                   5 |
| Keyed rotation      |               5.7 |                  3.7 |               44 |                   3 |
| Keyed shuffle       |               8.0 |                  4.9 |               22 |                   6 |
| Keyed replacement   |              20.1 |                  5.4 |               32 |                   6 |
| Unkeyed unchanged   |               2.9 |                  2.6 |               16 |                   2 |
| Unkeyed insertion   |               6.7 |                  3.5 |                9 |                   3 |
| Unkeyed deletion    |               5.8 |                  5.7 |               13 |                   5 |
| Unkeyed reverse     |              19.0 |                  3.7 |               18 |                   4 |
| Unkeyed rotation    |               3.0 |                  3.1 |               22 |                   3 |
| Unkeyed shuffle     |               7.6 |                  6.8 |               10 |                   6 |
| Unkeyed replacement |              40.6 |                  6.9 |               41 |                   6 |
| Dirty controls      |               5.6 |                  3.9 |                6 |                   3 |
| Small target        |               0.6 |                  0.6 |                1 |                   1 |
| Append              |               0.8 |                  0.9 |                1 |                   1 |

All 17 workloads pass the stated median gate in both engines. Application medians and combined 95th percentiles were also inspected. Chromium's combined 95th percentile falls on every workload except append and unkeyed rotation. Append rises from 1.3 to 1.4 ms; unkeyed rotation stays at 3.5 ms. Firefox combined 95th percentiles do not increase. These are sample percentiles, not latency guarantees.

The measured minified patch-entry bundle falls from 18,947 to 16,038 bytes, or from 5,784 to 5,388 bytes gzipped. This is the patch entry, not the full browser runtime. Removing the dependency is mainly a correctness and maintenance improvement, not a major size reduction.

The host uses an AMD RYZEN AI MAX+ 395 processor, Chromium 151.0.7922.34 and Firefox 153.0 on Linux. CPU frequency and scheduler load are uncontrolled. Firefox timers have millisecond granularity and its baseline samples vary substantially. Results exclude setup, network, layout and paint. Unkeyed retention rules differ, so the table is not proof of identical DOM mutation counts or identical island lifetimes for unkeyed content.

### Reproduction

```sh
git worktree add --detach /tmp/hypergraft-morph-baseline 1903088
mise exec -- pnpm --dir /tmp/hypergraft-morph-baseline install --frozen-lockfile
HYPERGRAFT_BENCH_BROWSERS=chromium,firefox mise exec -- node scripts/bench-morph.mjs /tmp/hypergraft-morph-baseline /tmp/child-reconciler.json.gz
git worktree remove /tmp/hypergraft-morph-baseline
```

Use an output path that does not exist. The runner preserves existing results and exits unsuccessfully if a median misses the gate. Omit `HYPERGRAFT_BENCH_BROWSERS` to include WebKit on a host with its dependencies installed. Stop other workloads before measuring. Browser installation follows [Compatibility](compatibility.md#browser-installation).

## Deployment

Deploy the browser bundle, invalidate cached assets and reload open documents. Keep the existing Askama templates and protocol fixture. Give controls and islands stable IDs wherever their retained identity matters; review changed unkeyed hints against the matching contract above.
