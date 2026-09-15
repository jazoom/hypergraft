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
