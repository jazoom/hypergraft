import { cachedDocumentIds, incomingIds } from "./id-validation";
import { validateDocumentIds } from "../browser/document-ids";
import type { PreparedPatch } from "../browser/patches";
import { apply, MEDIA_TYPE, preflight } from "../browser/patches";
import templates from "../browser/fixtures/templates.json";

const warmup = 5;
const samples = 20;
const rows = (ids: number[], keyed: boolean) =>
    ids
        .map(
            (id) =>
                `<div${keyed ? ` id="row-${id}"` : ""}><span>Row ${id}</span></div>`,
        )
        .join("");
const sequence = (size: number, start = 0) =>
    Array.from({ length: size }, (_, i) => start + i);
const envelope = (html: string, append: boolean) =>
    `<graft-patch-set version="1"><graft-patch operation="${append ? "append" : "children"}" target="target"><template>${html}</template></graft-patch></graft-patch-set>`;
const response = new Response(null, {
    headers: { "Content-Type": MEDIA_TYPE },
});

let running = false;

export async function runBenchmarks() {
    if (running) throw new Error("A measurement run is already in progress");
    running = true;
    const button = document.getElementById("run") as HTMLButtonElement;
    button.disabled = true;
    try {
        return await measureBenchmarks();
    } finally {
        document.getElementById("workload")!.replaceChildren();
        button.disabled = false;
        running = false;
    }
}

async function measureBenchmarks() {
    const results = [];
    const host = document.getElementById("workload")!;
    const workloads = [
        ...[true, false].flatMap((keyed) =>
            ["unchanged", "insertion", "reorder"].map((operation) => ({
                name: `${keyed ? "id" : "unkeyed"}-${operation}`,
                keyed,
                operation,
            })),
        ),
        { name: "small-large-document", keyed: true, operation: "small" },
        { name: "append", keyed: true, operation: "append" },
        { name: "compiled-marker-reorder", keyed: true, operation: "compiled" },
    ];
    for (const workload of workloads) {
        const parsePreflightMs: number[] = [];
        const finalIdScanMs: number[] = [];
        const applyMs: number[] = [];
        const bytes: number[] = [];
        for (let trial = -warmup; trial < samples; trial++) {
            host.replaceChildren();
            if (workload.operation === "small") {
                const outside = document.createElement("section");
                outside.innerHTML = sequence(20000)
                    .map((id) => `<div id="outside-${id}">Outside</div>`)
                    .join("");
                host.append(outside);
            }
            const target = document.createElement("section");
            target.id = "target";
            target.innerHTML =
                workload.operation === "append"
                    ? ""
                    : rows(
                          sequence(workload.operation === "small" ? 1 : 1000),
                          workload.keyed,
                      );
            if (workload.operation === "compiled")
                target.innerHTML = templates.results;
            host.append(target);
            const count = workload.operation === "append" ? 10 : 1;
            for (let batch = 0; batch < count; batch++) {
                let ids = sequence(workload.operation === "small" ? 1 : 1000);
                if (workload.operation === "insertion") ids = [1000, ...ids];
                if (workload.operation === "reorder") ids.reverse();
                if (workload.operation === "append")
                    ids = sequence(100, batch * 100);
                const text = envelope(
                    workload.operation === "compiled"
                        ? templates.reordered
                        : rows(ids, workload.keyed),
                    workload.operation === "append",
                );
                performance.mark("graft-preflight-start");
                const start = performance.now();
                const prepared = preflight(response, text);
                const parsed = performance.now();
                performance.mark("graft-preflight-end");
                const scans = performance.getEntriesByName(
                    "graft-final-ids",
                    "measure",
                );
                performance.clearMeasures("graft-final-ids");
                if (scans.length !== 1)
                    throw new Error(
                        "The benchmark requires one final ID scan measurement per patch batch",
                    );
                if (prepared.kind !== "patches")
                    throw new Error("Expected a patch batch");
                performance.mark("graft-apply-start");
                const applying = performance.now();
                apply(prepared.batch);
                const applied = performance.now();
                performance.mark("graft-apply-end");
                if (trial >= 0) {
                    parsePreflightMs.push(parsed - start);
                    finalIdScanMs.push(scans[0].duration);
                    applyMs.push(applied - applying);
                    bytes.push(new TextEncoder().encode(text).length);
                }
                // Frame callbacks permit rendering but do not measure layout or paint.
                await new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve()),
                    ),
                );
            }
        }
        results.push({
            workload: workload.name,
            parsePreflightMs,
            finalIdScanMs,
            applyMs,
            envelopeBytes: bytes,
        });
    }
    return {
        engine: "owned sibling-local reconciler",
        instrumentation:
            "Benchmark-only timers surround the production final ID scan. Preflight includes timer overhead.",
        nativeMoves: typeof Element.prototype.moveBefore === "function",
        userAgent: navigator.userAgent,
        warmup,
        samples,
        results,
    };
}

Object.assign(window, { runBenchmarks });
document.getElementById("run")!.addEventListener("click", async () => {
    const output = document.getElementById("results")!;
    output.textContent = "The measurements are in progress.";
    try {
        output.textContent = JSON.stringify(await runBenchmarks(), null, 2);
    } catch (error) {
        output.textContent = `The measurements failed: ${String(error)}`;
        console.error(error);
    }
});

export async function runIdBenchmarks() {
    const markerTemplate = document.createElement("template");
    markerTemplate.innerHTML = templates.row;
    const markers = [
        ...markerTemplate.content.querySelectorAll("[data-graft-key]"),
    ].map((node) => node.getAttribute("data-graft-key")!);
    const host = document.getElementById("workload")!;
    const results = [];
    const operations = [
        "unchanged",
        "text",
        "marker",
        "free-append",
        "free-remove",
        "id-insert",
        "id-remove",
        "id-reorder",
        "replace",
        "host-sync",
        "host-async",
        "churn",
        "large-free",
        "large-ids",
    ];
    try {
        for (const density of [0, 0.1, 1])
            for (const operation of operations)
                for (const strategy of ["full", "cached"]) {
                    host.innerHTML = `<aside>${sequence(20000)
                        .map(
                            (id) =>
                                `<div${id < 20000 * density ? ` id="outside-${id}"` : ""}>Outside</div>`,
                        )
                        .join(
                            "",
                        )}</aside><section id="target"><b id="row-0">Row</b>${operation === "id-reorder" ? '<i id="row-1"></i>' : ""}</section>`;
                    const outside = host.firstElementChild!;
                    let target = host.lastElementChild as HTMLElement;
                    const template = document.createElement("template");
                    template.innerHTML =
                        operation === "free-append"
                            ? "<i></i>"
                            : '<b id="row-0">Row</b>';
                    const patches: PreparedPatch[] = [
                        {
                            target,
                            targetId: "target",
                            operation:
                                operation === "free-append"
                                    ? "append"
                                    : "children",
                            nodes: [...template.content.childNodes],
                        },
                    ];
                    const ids = incomingIds(patches);
                    const coldStart = performance.now();
                    const candidate =
                        strategy === "cached"
                            ? cachedDocumentIds(document)
                            : undefined;
                    try {
                        const validate = () =>
                            candidate
                                ? candidate.validate(patches, ids)
                                : validateDocumentIds(document, patches, ids);
                        validate();
                        const coldMs = performance.now() - coldStart;
                        const validatorMs: number[] = [];
                        const cycleMs: number[] = [];
                        for (let trial = -warmup; trial < samples; trial++) {
                            const start = performance.now();
                            switch (operation) {
                                case "text":
                                    target.firstChild!.textContent = `Row ${trial}`;
                                    break;
                                case "marker":
                                    target.firstElementChild!.setAttribute(
                                        "data-graft-key",
                                        markers[
                                            (trial + warmup) % markers.length
                                        ]!,
                                    );
                                    break;
                                case "free-append":
                                    target.append(document.createElement("i"));
                                    break;
                                case "free-remove":
                                    target.append(document.createElement("i"));
                                    target.lastChild!.remove();
                                    break;
                                case "id-insert":
                                    target.append(
                                        Object.assign(
                                            document.createElement("i"),
                                            { id: `added-${trial + warmup}` },
                                        ),
                                    );
                                    break;
                                case "id-remove": {
                                    const node = Object.assign(
                                        document.createElement("i"),
                                        { id: "removed" },
                                    );
                                    target.append(node);
                                    node.remove();
                                    break;
                                }
                                case "id-reorder":
                                    target.append(target.firstChild!);
                                    break;
                                case "replace": {
                                    const replacement = target.cloneNode(
                                        true,
                                    ) as HTMLElement;
                                    target.replaceWith(replacement);
                                    target = replacement;
                                    patches[0]!.target = replacement;
                                    break;
                                }
                                case "host-sync":
                                case "host-async":
                                    outside.firstElementChild!.id = `host-${trial + warmup}`;
                                    break;
                                case "churn":
                                    for (const [index, node] of [
                                        ...outside.children,
                                    ].entries())
                                        node.id = `churn-${trial + warmup}-${index}`;
                                    break;
                                case "large-free":
                                case "large-ids": {
                                    const subtree =
                                        document.createElement("div");
                                    subtree.innerHTML = sequence(1000)
                                        .map(
                                            (id) =>
                                                `<i${operation === "large-ids" ? ` id="large-${id}"` : ""}></i>`,
                                        )
                                        .join("");
                                    target.append(subtree);
                                    subtree.remove();
                                    break;
                                }
                            }
                            // A microtask checkpoint includes observer delivery inside the cycle interval.
                            if (
                                operation === "host-async" ||
                                (operation !== "host-sync" && trial % 2 === 0)
                            )
                                await Promise.resolve();
                            const before = performance.now();
                            validate();
                            const end = performance.now();
                            if (trial >= 0) {
                                validatorMs.push(end - before);
                                cycleMs.push(end - start);
                            }
                        }
                        results.push({
                            density,
                            operation,
                            strategy,
                            coldMs,
                            validatorMs,
                            cycleMs,
                            counts: candidate?.counts ?? {
                                fullScans: warmup + samples + 1,
                                cacheHits: 0,
                                invalidations: 0,
                                fallbacks: 0,
                            },
                        });
                    } finally {
                        candidate?.dispose();
                    }
                }
    } finally {
        host.replaceChildren();
    }
    return {
        userAgent: navigator.userAgent,
        warmup,
        samples,
        outsideNodes: 20000,
        largeSubtreeNodes: 1000,
        results,
        memory: "Unavailable: no portable reliable observer allocation measurement",
        boundary:
            "Validator-only and mutation cycles, not production preflight. Counts include warm-up. Cold start includes observer setup and actual-document validation.",
    };
}
Object.assign(window, { runIdBenchmarks });
