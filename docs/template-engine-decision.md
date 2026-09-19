# Template engine decision

## Decision

Hypergraft returns to Askama and Morphlex. The owned compiler and reconciler did not meet the requirement for better combined performance.

The rollback starts from `e345f10`, “Use template blocks for the example app”. It preserves the Askama block templates and the Morphlex ownership callback.

The replacement remains archived on `archive/owned-template-investigation` at `3b6b507`. That commit includes the uncommitted optimisation work and measurement artefacts.

## Evidence

The investigation compared actual compiler output through each browser runtime. Four rounds alternated engine order on one machine.

After optimisation, the unchanged workloads still showed these costs:

| Measurement                                                | Askama and Morphlex | Owned system |
| ---------------------------------------------------------- | ------------------: | -----------: |
| ID row output, µs                                          |               21.68 |       140.21 |
| Unkeyed / generated row output, µs                         |               11.99 |       149.91 |
| Chromium unkeyed / generated preflight and application, ms |                2.30 |        17.20 |
| ID row HTML, bytes                                         |              43,780 |      131,781 |
| Unkeyed / generated row HTML, bytes                        |              30,890 |      230,671 |

Each row workload contains 1,000 rows. Browser intervals exclude network transport, layout and paint. Reorder results remain workload-dependent.

The optimisations left compiler output byte-identical. Compression reduced repeated metadata, but it did not remove the size regression. WebKit results remain unavailable on the measurement host.

The archive contains the full report at `docs/performance-investigation.md`. Its raw results reside in `benchmarks/results/pipeline-investigation-{before,after}.json.gz`.

## Retained fixes

The rollback retains these engine-independent changes:

- Focus restoration through retained nodes, with directional text selection.
- Final fragment inspection after host content callbacks.
- Rejection of empty incoming ID attributes under the existing ID syntax.
- Native form-property access in Hypergraft preflight and adapter code.
- Island lifecycle updates after `data-island` attribute changes.

The rollback excludes generated identity rules and compiler-specific tests. It also excludes the custom reconciler and its control-state implementation.

Form-property guards cover Hypergraft code, not Morphlex internals. Morphlex still reads some DOM properties directly. Controls named `childNodes` or `querySelectorAll` can interfere with its traversal.

The retired `NEXT.md` plan does not authorise further replacement work. A future proposal requires a new plan and performance criteria before implementation.

## Deployment

1. Deploy the restored Askama output with the Morphlex browser bundle.
2. Invalidate cached browser assets.
3. Reload open documents after the deployment.

The rollback changes no envelope operation or resource limit. The restored runtime does not interpret the retired generated-key format.
