# Template and patch performance

## Scope

The baseline uses Askama 0.16.0 and Morphlex 1.4.0 through the unchanged production APIs. It contains no generated reconciliation markers.

`benchmarks/results/askama-morphlex-baseline.json` contains raw samples and machine metadata. `benchmarks/results/chromium-baseline.trace.json.gz` contains the separate Chromium trace.

The source revision is `e5c014f19c29e5fe2edfde567c1b9cc8eb9aa96e`. The benchmark files accompany that revision as uncommitted additions. Production source and `protocol-v1.json` remain unchanged.

The metadata includes the working tree status and SHA-256 hashes of benchmark sources, production sources and dependency files. These hashes identify uncommitted inputs that the revision alone cannot identify.

## Workload definitions

Every row uses the exact compact HTML below. Unkeyed workloads omit only the `id` attribute. There is no whitespace between rows.

```html
<div id="row-0"><span>Row 0</span></div>
```

| Workload                       | Initial state                                  | Incoming state                                            |
| ------------------------------ | ---------------------------------------------- | --------------------------------------------------------- |
| ID-keyed unchanged             | Rows 0–999                                     | Rows 0–999                                                |
| ID-keyed insertion             | Rows 0–999                                     | Row 1000, then rows 0–999                                 |
| ID-keyed reorder               | Rows 0–999                                     | Rows 999–0                                                |
| Unkeyed unchanged              | Rows 0–999 without IDs                         | Same HTML                                                 |
| Unkeyed insertion              | Rows 0–999 without IDs                         | Row 1000, then rows 0–999 without IDs                     |
| Unkeyed reorder                | Rows 0–999 without IDs                         | Rows 999–0 without IDs                                    |
| Small target in large document | One keyed row, 20,000 external ID-bearing divs | Same keyed row                                            |
| Successive append              | Empty target                                   | Ten batches of 100 keyed rows, with disjoint ranges 0–999 |

Each patch targets a retained `section` with ID `target`. The external divs contain the text `Outside`. The browser retains prior append output within each trial.

The server measures only the small target output, not the external document. Server append results retain separate batch numbers. Browser append arrays use trial-major, batch-minor order.

These definitions remain the shared comparison workloads for the compiler and reconciler replacements. Both engines recognise public IDs. The unkeyed comparison must retain identical hand-authored HTML.

The owned reconciler adds a separate compiler-marker workload from `browser/fixtures/templates.json`. Different identity semantics cannot establish an engine speed improvement.

## Measurement boundaries

The server executable uses release optimisation through `cargo bench`, with 20 warm-up iterations and 100 samples per workload. It records nanoseconds with `Instant`.

`Template::render` measures template output and allocation. `PatchSet` construction occurs outside the encoding interval and renders the template again.

`PatchSet::encode_live` measures production envelope encoding from the prepared batch. It includes validation and consumption of the batch. It excludes transport and HTTP response construction.

HTML and envelope byte counts use UTF-8 string lengths. The baseline contains zero generated identity bytes. Public ID overhead remains part of the keyed output.

The browser uses five warm-up trials and 20 measured trials per workload. Append produces 200 measured patch samples after 50 warm-up patches.

The browser resets the target before each trial. The `preflight` interval includes detached HTML parsing and all production validation against the current live document.

The `apply` interval includes production reconciliation and focus restoration. Neither interval includes workload construction or the subsequent frame wait. `performance.now()` supplies milliseconds.

Two animation-frame callbacks separate applications. These callbacks permit browser rendering but do not measure layout or paint.

The latency run excludes trace overhead. A second Chromium run records `devtools.timeline` and `blink.user_timing` through CDP. Application marks identify reconciliation intervals.

Trace totals cover the whole traced run, including setup and warm-up. The recorder reports `Layout`, `Paint` and `UpdateLayoutTree` events outside application intervals.

These totals are event durations, not exclusive CPU time or per-patch latency. The compressed trace retains timestamps for further inspection.

The final document-wide ID scan remains inside preflight. The current benchmark also records its exact loop duration through benchmark-only timers.

`benchmarks/vite.config.ts` inserts those timers around the production loop. It fails if the source boundaries change. No production hook or duplicate validator exists.

`finalIdScanMs` includes the document query and collision checks. It excludes parsing and key validation. Preflight samples include timer overhead, unlike the historical baseline.

## Reproduction

1. Install the tool versions from `mise.toml`.
2. Run `mise exec -- pnpm install --frozen-lockfile`.
3. Run `mise exec -- pnpm exec playwright install`.
4. Stop other workloads on the measurement machine.
5. Run `mise exec -- pnpm bench:record`.

The recorder starts and stops its Vite server on port 4174. An occupied port fails the command instead of a connection to another server. The recorder writes `current-pipeline.json` and `chromium-current.trace.json.gz`. A rerun preserves the historical baseline artefacts.

The recorder reports unavailable browser installations. Application errors fail the command rather than become successful measurements.

### Server only

```sh
mise exec -- cargo bench --bench templates --quiet > /tmp/templates.json
```

`benches/templates.rs` is a `harness = false` executable. Standard output contains one JSON value. Build diagnostics use standard error.

The owned compiler reads `benchmarks/templates/*.graft.html` relative to the root crate. No template-engine configuration file remains.

To save server samples with source hashes and machine metadata, run:

```sh
mise exec -- node benchmarks/record.mjs --server-only
```

This command writes `benchmarks/results/owned-template.json` without a browser run.

### Interactive browser page

1. Run `mise exec -- pnpm bench:browser`.
2. Open `http://127.0.0.1:4174/benchmarks/browser.html`.
3. Select **Run measurements**.

The page displays JSON after all workloads finish. It rejects concurrent runs and restores its controls after success or failure.

The automated recorder uses the same exported function with a 1280 × 720 viewport.

### Trace inspection

1. Run `gzip -dc benchmarks/results/chromium-baseline.trace.json.gz > /tmp/hypergraft-trace.json`.
2. Open `/tmp/hypergraft-trace.json` in the Chrome DevTools performance panel.
3. Locate the `graft-apply-start` and `graft-apply-end` marks.
4. Inspect subsequent layout and paint events outside those intervals.

## Recorded baseline

The machine uses an AMD RYZEN AI MAX+ 395 processor with 32 logical CPUs and Linux `7.2.3-1-cachyos`. CPU frequency and scheduler load were not fixed.

The toolchain uses Rust 1.96.0, Node 22.23.2 and Playwright 1.62.1. Browser runs use headless Chromium 151.0.7922.34 and Firefox 153.0.

### Server medians

| Workload          | Template output, µs | Envelope encoding, µs | HTML bytes |
| ----------------- | ------------------: | --------------------: | ---------: |
| ID unchanged      |               20.00 |                  1.60 |     43,780 |
| ID insertion      |               20.08 |                  2.12 |     43,826 |
| ID reorder        |               20.36 |                  2.14 |     43,780 |
| Unkeyed unchanged |               11.57 |                  0.36 |     30,890 |
| Unkeyed insertion |               11.68 |                  0.36 |     30,922 |
| Unkeyed reorder   |               11.69 |                  0.37 |     30,890 |
| Small target      |                0.04 |                  0.09 |         40 |

### Browser medians

| Workload                       | Chromium preflight, ms | Chromium apply, ms | Firefox preflight, ms | Firefox apply, ms |
| ------------------------------ | ---------------------: | -----------------: | --------------------: | ----------------: |
| ID unchanged                   |                   2.30 |               3.40 |                  2.00 |             10.00 |
| ID insertion                   |                   2.60 |               3.65 |                  2.00 |             15.00 |
| ID reorder                     |                   2.60 |              10.10 |                  2.00 |             27.00 |
| Unkeyed unchanged              |                   1.55 |               1.00 |                  2.00 |             42.50 |
| Unkeyed insertion              |                   1.40 |               1.00 |                  2.00 |             34.50 |
| Unkeyed reorder                |                   1.50 |              17.30 |                  2.00 |             14.50 |
| Small target in large document |                   7.30 |               0.10 |                  6.00 |              0.00 |
| Append, pooled batches         |                   0.50 |               0.10 |                  1.00 |              0.00 |

The Chromium trace contains 425 application intervals. All 426 layout events occur outside those intervals and total 1,165.167 ms.

All 595 paint events occur outside those intervals and total 155.849 ms. Style updates total 461.877 ms outside application intervals.

### Limitations

WebKit cannot launch because this machine lacks required system libraries. The result file records the launch diagnostic. No WebKit performance claim follows from this baseline.

The recorder does not expose Firefox or WebKit layout and paint categories. Those trace measurements remain unavailable.

Timer quantisation produces zero-valued Firefox samples. Zero does not mean zero work. Raw distributions remain available for later comparisons.

These sequential, single-machine measurements include runtime warm-up effects and scheduler noise. They establish a reproducible workload baseline, not universal latency guarantees.

No reliable memory, GPU or physical-display paint measurement accompanies this baseline. Headless trace events do not establish user-visible frame completion.

## Owned compiler server measurements

`benchmarks/results/owned-template.json` records release samples, source hashes and machine metadata. The run uses 20 warm-up iterations and 100 samples per workload.

The workload data matches the baseline. ID rows retain public IDs, while their child spans acquire generated markers. Formerly unkeyed rows now acquire generated identity.

Append batches retain the same row data but replace authored row IDs with generated markers. Explicit batch scopes now reach those root markers.

Each row establishes a parent boundary, so its child marker excludes the batch scope. This compiler workload differs from the browser's ID-keyed append comparison.

| Workload             | Output, µs | Encoding, µs | HTML bytes | Added bytes |
| -------------------- | ---------: | -----------: | ---------: | ----------: |
| id-unchanged         |     273.26 |        11.98 |    131,781 |      88,001 |
| id-insertion         |     270.32 |        10.83 |    131,915 |      88,089 |
| id-reorder           |     269.26 |        10.95 |    131,781 |      88,001 |
| generated-unchanged  |     515.28 |        19.36 |    230,671 |     199,781 |
| generated-insertion  |     518.81 |        15.57 |    230,905 |     199,983 |
| generated-reorder    |     514.71 |        15.24 |    230,671 |     199,781 |
| small-large-document |       0.32 |         0.11 |        129 |          89 |
| append-0             |      58.84 |         0.54 |     24,771 |      20,591 |
| append-9             |      58.56 |         0.34 |     25,101 |      20,701 |

Added bytes comprise generated metadata and one trailing source newline. Append differences also subtract the removed public IDs. The compiler performs semantic key validation that the Askama baseline excludes.

These server results show higher output cost and larger payloads, not an engine speed improvement. The browser benchmark still uses identical hand-authored comparison HTML.

This server run measures no browser parsing, reconciliation, layout or paint. The earlier trace remains historical evidence only. Scheduler noise and uncontrolled CPU frequency limit comparisons.

## Owned reconciler measurements

`benchmarks/results/owned-reconciler.json` contains raw native and forced-fallback Chromium and Firefox samples. The artefact includes source hashes, machine metadata and the source revision.

The shared ID-keyed and unkeyed workloads retain their original HTML. The separate compiled-marker workload reconciles `templates.results` with `templates.reordered` from the compiler fixture.

The run uses headless Chromium 151.0.7922.34 and Firefox 153.0 on the same processor as the baseline. Both engines support native moves.

The following table contains Chromium medians.

| Workload                       | Native preflight, ms | Native apply, ms | Fallback preflight, ms | Fallback apply, ms |
| ------------------------------ | -------------------: | ---------------: | ---------------------: | -----------------: |
| ID unchanged                   |                 5.60 |             4.50 |                   5.00 |               4.05 |
| ID insertion                   |                 5.10 |             4.30 |                   5.00 |               4.05 |
| ID reorder                     |                 5.05 |             4.70 |                   5.15 |               4.50 |
| Unkeyed unchanged              |                 4.00 |             3.20 |                   4.05 |               3.20 |
| Unkeyed insertion              |                 3.95 |             3.30 |                   4.10 |               3.30 |
| Unkeyed reorder                |                 3.90 |             3.30 |                   4.20 |               3.30 |
| Small target in large document |                 7.00 |             0.00 |                   7.00 |               0.00 |
| Append                         |                 1.40 |             0.10 |                   1.40 |               0.10 |
| Compiled-marker reorder        |                 0.10 |             0.10 |                   0.10 |               0.05 |

ID reorder application falls from the historical 10.10 ms median to 4.70 ms. Unchanged unkeyed application rises from 1.00 ms to 3.20 ms.

These results show workload-dependent costs, not a general speed improvement. The owned runtime includes key validation that the baseline excludes.

Sequential runs and uncontrolled CPU frequency limit comparisons. Zero samples indicate timer resolution, not free operations. The compiler-marker workload contains only two rows.

### Final ID scan cost

| Workload                       | Chromium native scan, ms | Chromium fallback scan, ms |
| ------------------------------ | -----------------------: | -------------------------: |
| ID unchanged                   |                     0.15 |                       0.10 |
| ID insertion                   |                     0.20 |                       0.10 |
| ID reorder                     |                     0.10 |                       0.10 |
| Unkeyed unchanged              |                     0.00 |                       0.00 |
| Unkeyed insertion              |                     0.00 |                       0.00 |
| Unkeyed reorder                |                     0.00 |                       0.00 |
| Small target in large document |                     6.80 |                       6.70 |
| Append                         |                     0.10 |                       0.10 |
| Compiled-marker reorder        |                     0.00 |                       0.00 |

The small-target native scan consumes 6.80 ms of the 7.00 ms median Chromium preflight interval. Firefox records a 6.00 ms scan and 6.50 ms preflight median.

These samples measure the existing full scan, not a cached-validity candidate. The runtime retains its full validation rules.

### Layout and paint

`benchmarks/results/chromium-owned.trace.json.gz` contains a separate native Chromium trace with 450 application intervals. All 451 layout events occur outside application and total 1,152.412 ms.

All 645 paint events occur outside application and total 160.036 ms. Style updates outside application total 453.116 ms.

These totals include setup and warm-up. They are not exclusive CPU time or per-patch latency. No fallback, Firefox or WebKit trace accompanies this run.

Chromium and Firefox pass the focused browser contracts. WebKit cannot start because required host libraries are absent. No WebKit performance or correctness claim follows.

### Native and fallback reproduction

Run the recorder for native and forced-fallback samples.

```sh
mise exec -- pnpm bench:record --reconciler
```

This command replaces `owned-reconciler.json` and `chromium-owned.trace.json.gz`. It leaves historical baselines and server results unchanged.

The recorder disables `moveBefore` on element and fragment prototypes for each fallback run. It restores their descriptors in `finally`.

This override exists only in the measurement session. The production runtime exposes no fallback configuration.

## Full scans versus cached document validity

The production runtime still uses `validateDocumentIds` in `browser/document-ids.ts`. The extraction preserves final-document rejection and the existing scope of IDs.

The candidate exists only in `benchmarks/id-validation.ts`. It stores one validity flag, not an ID index. Native `getElementById` supplies lookups on the clean path.

The observer covers the whole document. ID attributes and ID-bearing subtree changes invalidate the flag. Text, private markers and ID-free subtree changes retain it.

Both observer delivery and synchronous drainage use the same invalidation function. Each candidate call drains records before a fast path. Application success never resets the flag.

An unknown cache requires successful validation of the actual document. If that fails, the production validator evaluates the complete hypothetical result. A patch can therefore repair invalid replaced contents.

The document query excludes native template contents and shadow trees. The candidate preserves that scope. Incoming IDs still include native template contents, as production content inspection requires.

The recorded comparison used the former policy that ignored empty incoming IDs. Current production and benchmark validation both reject empty ID attributes. The archived timings predate this correction.

The opt-in suite in `benchmarks/id-validation.browser.test.ts` compares the candidate with production validation. The default browser contract suite excludes these benchmark tests.

### Reproduction for the ID comparison

Run the recorder:

```sh
mise exec -- node benchmarks/record.mjs --ids
```

Run the differential contracts:

```sh
mise exec -- pnpm test:benchmarks
HYPERGRAFT_BROWSER=firefox mise exec -- pnpm test:benchmarks
HYPERGRAFT_BROWSER=webkit mise exec -- pnpm test:benchmarks
```

### Measurement boundaries and workloads

`benchmarks/results/document-id-validation.json` contains raw samples, source hashes and machine metadata. The machine uses an AMD RYZEN AI MAX+ 395 processor.

Each trial uses 20,000 external elements and one small prepared patch. ID densities are zero, 10% and 100%. Large subtree operations use 1,000 elements.

Each density/operation/strategy tuple forms one trial. Each trial contains five warm-up cycles and 20 measured cycles. The observer disconnects before the next trial.

The full-scan trials contain no candidate observer. Both strategies receive equivalent prepared nodes and incoming ID sets. Incoming collection and HTML parsing occur outside these intervals.

`coldMs` includes observer setup and the initial full validation. It contains one observation per trial, not a per-workload cold-start distribution.

`validatorMs` measures only the validator call. `cycleMs` starts before mutation and includes observer record creation, subtree inspection, delivery and synchronous drainage.

Alternate cycles include a microtask checkpoint. `host-sync` always precedes observer delivery. `host-async` always follows delivery. Both strategies include the same checkpoint overhead.

The cycles cover these operations:

- Unchanged snapshots, text changes and private marker changes.
- ID-free append and removal.
- ID-bearing insertion, removal, reorder and whole-target replacement.
- Host ID changes before and after observer delivery.
- Sustained ID churn across all external elements.
- Large ID-free and ID-bearing subtree insertion and removal.

The reorder operation moves two ID-bearing children within the small target at every external ID density.

Counts include cold validation and warm-up cycles. `cacheHits` counts clean-path entries. `invalidations` counts record batches with relevant mutations, not individual mutations.

The existing `runBenchmarks` function still measures production preflight separately. These validator-only samples do not represent equivalent full-pipeline performance. They exclude reconciliation, layout and paint.

### Results and adoption recommendation

The result file records Chromium 151.0.7922.34 and Firefox 153.0. WebKit cannot start because required host libraries are absent. WebKit measurements remain unavailable.

The following values are median cycle milliseconds at 100% external ID density. Zero denotes the timer resolution, not zero work.

| Operation                      | Chromium full | Chromium cached | Firefox full | Firefox cached |
| ------------------------------ | ------------: | --------------: | -----------: | -------------: |
| Unchanged                      |          3.90 |            0.00 |         4.00 |           0.00 |
| Host ID change before delivery |          3.90 |            3.50 |         4.00 |           4.00 |
| Sustained ID churn             |         21.75 |           24.95 |        18.00 |          25.50 |
| Large ID-free subtree          |          4.40 |            0.10 |         4.50 |           0.00 |
| Large ID-bearing subtree       |          5.10 |            3.80 |         5.00 |           5.00 |

At full density, median cold observations across operations were 5.30/4.75 ms for Chromium full/cached and 9.00/9.00 ms for Firefox. Trial order and allocation noise limit cold comparisons.

An unchanged cached trial required one full scan and recorded 25 cache hits. Sustained churn required 26 full scans and 25 invalidations. The measured valid-document workloads required no fallback.

Differential tests cover repair fallback, invalid surviving IDs and collisions. They also cover host callbacks, custom-element effects and partial application failure. Chromium and Firefox pass these contracts.

The warm path removes most scan cost in stable documents. The dirty path retains scan cost and adds observer overhead. Firefox sustained churn regressed at every initial ID density.

Chromium churn at 10% initial density increased from 21.40 to 23.30 ms. Its full-density result also regressed. Repeated, order-balanced trials remain necessary.

Observer overhead forms part of the cycle totals. Separate observer CPU attribution and reliable observer allocation measurements are unavailable. The recorder makes no memory benefit claim.

The recommendation is to retain full scans in production. The evidence supports further evaluation for stable, ID-dense documents, not unconditional adoption.

A later adoption decision requires WebKit conformance and broader repeated cold trials. It also requires a lifecycle design for observer ownership and representative host mutation rates.
