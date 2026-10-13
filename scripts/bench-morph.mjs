import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium, firefox, webkit } from "playwright";
import { build } from "vite";

const [baseline, output] = process.argv.slice(2);
if (!baseline || !output)
    throw new Error(
        "Usage: node scripts/bench-morph.mjs BASELINE_DIRECTORY OUTPUT.json.gz",
    );
const roots = [path.resolve(baseline), process.cwd()];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixtures = execFileSync(
    "cargo",
    ["run", "--quiet", "--example", "morph-fixtures"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
const workloads = JSON.parse(fixtures);
const bundles = [];
const sources = [];
for (const root of roots) {
    const result = await build({
        root,
        configFile: false,
        logLevel: "error",
        build: {
            target: "es2022",
            write: false,
            minify: true,
            lib: {
                entry: path.join(root, "browser/patches.ts"),
                formats: ["es"],
            },
        },
    });
    const built = Array.isArray(result) ? result[0] : result;
    bundles.push(
        built.output.find((item) => item.type === "chunk" && item.isEntry).code,
    );
    sources.push(
        Object.fromEntries(
            await Promise.all(
                [
                    "browser/morph.ts",
                    "browser/patches.ts",
                    "browser/dom.ts",
                    "pnpm-lock.yaml",
                ].map(async (file) => [
                    file,
                    hash(await readFile(path.join(root, file))),
                ]),
            ),
        ),
    );
}
const server = createServer((request, response) => {
    const index = /^\/([01])\.js$/.exec(request.url)?.[1];
    response.setHeader("Content-Type", index ? "text/javascript" : "text/html");
    response.end(
        index
            ? bundles[Number(index)]
            : "<!doctype html><title>Child reconciliation benchmark</title>",
    );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const result = {
    metadata: {
        date: new Date().toISOString(),
        cpu: os.cpus()[0]?.model,
        platform: `${os.platform()} ${os.release()}`,
        baseline: execFileSync("git", ["-C", roots[0], "rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim(),
        fixtures: hash(fixtures),
        sources,
        bundles: bundles.map((code) => ({
            sha256: hash(code),
            bytes: Buffer.byteLength(code),
            gzipBytes: gzipSync(code).length,
        })),
        warmups: 5,
        samples: 25,
        rounds: 4,
        excludes: ["setup", "network", "layout", "paint"],
    },
    browsers: [],
};
try {
    for (const name of (
        process.env.HYPERGRAFT_BENCH_BROWSERS ?? "chromium,firefox,webkit"
    ).split(",")) {
        const engine = { chromium, firefox, webkit }[name];
        if (!engine) throw new Error(`Unknown browser: ${name}`);
        const browser = await engine.launch();
        try {
            const page = await browser.newPage();
            const errors = [];
            page.on("pageerror", (error) => errors.push(String(error)));
            page.on("requestfailed", (request) =>
                errors.push(
                    `${request.url()}: ${request.failure()?.errorText}`,
                ),
            );
            await page.goto(`http://127.0.0.1:${server.address().port}/`);
            const samples = await page.evaluate(
                async ({ workloads, warmups, samples, rounds }) => {
                    const modules = await Promise.all([
                        import("/0.js"),
                        import("/1.js"),
                    ]);
                    const records = [];
                    for (let round = 0; round < rounds; round++) {
                        for (const engine of round % 2 ? [1, 0] : [0, 1]) {
                            for (const workload of workloads) {
                                for (
                                    let trial = -warmups;
                                    trial < samples;
                                    trial++
                                ) {
                                    document.body.innerHTML = `<main id="bench-target">${workload.initial}</main>${workload.surrounding ?? ""}`;
                                    if (workload.dirty) {
                                        for (const input of document.querySelectorAll(
                                            "input,textarea",
                                        ))
                                            input.value = "Dirty";
                                    }
                                    const envelope = `<graft-patch-set version="1"><graft-patch operation="${workload.operation}" target="bench-target"><template>${workload.incoming}</template></graft-patch></graft-patch-set>`;
                                    await new Promise((resolve) =>
                                        requestAnimationFrame(resolve),
                                    );
                                    const start = performance.now();
                                    const prepared =
                                        modules[engine].preflightLive(envelope);
                                    const parsed = performance.now();
                                    let visited = 0;
                                    modules[engine].apply(
                                        prepared,
                                        workload.ownership
                                            ? () => {
                                                  visited++;
                                              }
                                            : undefined,
                                    );
                                    const end = performance.now();
                                    const expected =
                                        workload.operation === "append"
                                            ? workload.initial +
                                              workload.incoming
                                            : workload.incoming;
                                    if (
                                        document.getElementById("bench-target")
                                            .innerHTML !== expected
                                    )
                                        throw new Error(
                                            `Incorrect structure: ${engine}/${workload.name}`,
                                        );
                                    if (workload.dirty) {
                                        for (const input of document.querySelectorAll(
                                            "input,textarea",
                                        ))
                                            if (
                                                input.value !==
                                                input.defaultValue
                                            )
                                                throw new Error(
                                                    `Incorrect value: ${engine}/${workload.name}`,
                                                );
                                        if (!visited)
                                            throw new Error(
                                                "Ownership was not visited",
                                            );
                                    }
                                    if (trial >= 0)
                                        records.push({
                                            round,
                                            engine,
                                            workload: workload.name,
                                            preflight: parsed - start,
                                            application: end - parsed,
                                            combined: end - start,
                                        });
                                }
                            }
                        }
                    }
                    return records;
                },
                { workloads, ...result.metadata },
            );
            if (errors.length) throw new Error(errors.join("\n"));
            result.browsers.push({ name, version: browser.version(), samples });
            const median = (values) =>
                values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
            const rows = workloads.map(({ name: workload }) => {
                const times = [0, 1].map((engine) =>
                    samples.filter(
                        (sample) =>
                            sample.engine === engine &&
                            sample.workload === workload,
                    ),
                );
                const [baseline, owned] = times.map((values) =>
                    median(values.map((value) => value.combined)),
                );
                return {
                    workload,
                    baseline,
                    owned,
                    baselineApply: median(
                        times[0].map((value) => value.application),
                    ),
                    ownedApply: median(
                        times[1].map((value) => value.application),
                    ),
                    gate:
                        owned <= baseline + Math.max(0.5, baseline * 0.15)
                            ? "pass"
                            : "FAIL",
                };
            });
            console.log(`${name} ${browser.version()}`);
            console.table(rows);
            if (rows.some((row) => row.gate === "FAIL")) process.exitCode = 1;
        } finally {
            await browser.close();
        }
    }
    await writeFile(output, gzipSync(JSON.stringify(result)), { flag: "wx" });
    console.log(`Saved ${output}`);
} finally {
    await new Promise((resolve) => server.close(resolve));
}
