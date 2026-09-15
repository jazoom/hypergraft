# Template and patch performance

The [template engine decision](template-engine-decision.md) records the return to Askama and Morphlex. These archived baseline measurements predate the retained correctness fixes.

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

These definitions identify the archived comparison workloads. New measurements use the same inputs. Unkeyed comparisons retain identical hand-authored HTML.

Compiler-generated marker workloads form a separate future category. Different identity semantics cannot establish an engine speed improvement.

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

The final document-wide ID scan remains inside preflight. The small-target workload exposes its surrounding-document cost but does not isolate that scan from other validation.

## Reproduction

1. Install the tool versions from `mise.toml`.
2. Run `mise exec -- pnpm install --frozen-lockfile`.
3. Run `mise exec -- pnpm exec playwright install`.
4. Stop other workloads on the measurement machine.
5. Run `mise exec -- pnpm bench:record`.

The recorder starts and stops its Vite server on port 4174. An occupied port fails the command instead of a connection to another server. The recorder writes the baseline JSON and compressed Chromium trace. A rerun replaces those artefacts.

The recorder reports unavailable browser installations. Application errors fail the command rather than become successful measurements.

### Server only

```sh
mise exec -- cargo bench --bench templates --quiet > /tmp/templates.json
```

`benches/templates.rs` is a `harness = false` executable. Standard output contains one JSON value. Build diagnostics use standard error.

`askama.toml` adds only the synthetic benchmark template directory. The reference application resolves its own templates from its crate.

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
