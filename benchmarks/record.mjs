import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { chromium, firefox, webkit } from "playwright";
import { createServer } from "vite";

const directory = "benchmarks/results";
await mkdir(directory, { recursive: true });
const reconciler = process.argv.includes("--reconciler");
const server = reconciler
    ? undefined
    : JSON.parse(
          execFileSync("cargo", ["bench", "--bench", "templates", "--quiet"], {
              encoding: "utf8",
          }),
      );
// HEAD does not identify uncommitted benchmark sources or production edits.
const sourcePaths = [
    "benches/templates.rs",
    "benchmarks/browser.ts",
    "benchmarks/browser.html",
    "benchmarks/record.mjs",
    "benchmarks/vite.config.ts",
    "benchmarks/templates/list.graft.html",
    "benchmarks/templates/fragment.graft.html",
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "pnpm-lock.yaml",
    "protocol-v1.json",
    ...execFileSync("git", ["ls-files", "src", "browser", "crates"], {
        encoding: "utf8",
    })
        .trim()
        .split("\n"),
];
const sourceSha256 = Object.fromEntries(
    await Promise.all(
        sourcePaths.map(async (path) => [
            path,
            createHash("sha256")
                .update(await readFile(path))
                .digest("hex"),
        ]),
    ),
);
const metadata = {
    recordedAt: new Date().toISOString(),
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
    }).trim(),
    workingTree: execFileSync("git", ["status", "--short"], {
        encoding: "utf8",
    }),
    sourceSha256,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
    node: process.version,
    playwright: JSON.parse(
        execFileSync("pnpm", ["exec", "playwright", "--version"], {
            encoding: "utf8",
        }).replace(/^Version (.*)\n$/, '"$1"'),
    ),
};
if (process.argv.includes("--server-only")) {
    await writeFile(
        `${directory}/owned-template.json`,
        JSON.stringify({ ...server, metadata }, null, 2) + "\n",
    );
    process.exit(0);
}
const vite = await createServer({ configFile: "benchmarks/vite.config.ts" });
const browsers = [];
try {
    // Strict port ownership prevents measurements from an unrelated server.
    await vite.listen();
    for (const [name, engine] of Object.entries({
        chromium,
        firefox,
        webkit,
    })) {
        let browser;
        try {
            browser = await engine.launch({ headless: true });
            const page = await browser.newPage({
                viewport: { width: 1280, height: 720 },
            });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
            });
            await page.goto("http://127.0.0.1:4174/benchmarks/browser.html");
            await page.waitForFunction(
                () => typeof window.runBenchmarks === "function",
            );
            // Latency samples exclude trace overhead. A second run supplies trace evidence.
            const measurements = await page.evaluate(() =>
                window.runBenchmarks(),
            );
            const fallback = reconciler
                ? await page.evaluate(async () => {
                      const prototypes = [
                          Element.prototype,
                          DocumentFragment.prototype,
                      ];
                      const descriptors = prototypes.map((prototype) =>
                          Object.getOwnPropertyDescriptor(
                              prototype,
                              "moveBefore",
                          ),
                      );
                      try {
                          for (const prototype of prototypes)
                              Object.defineProperty(prototype, "moveBefore", {
                                  configurable: true,
                                  value: undefined,
                              });
                          return await window.runBenchmarks();
                      } finally {
                          prototypes.forEach((prototype, index) => {
                              const descriptor = descriptors[index];
                              if (descriptor)
                                  Object.defineProperty(
                                      prototype,
                                      "moveBefore",
                                      descriptor,
                                  );
                              else delete prototype.moveBefore;
                          });
                      }
                  })
                : undefined;
            let trace = {
                available: false,
                reason: "This recorder supports Chromium CDP trace categories only.",
            };
            if (name === "chromium") {
                const session = await page.context().newCDPSession(page);
                const events = [];
                session.on("Tracing.dataCollected", ({ value }) =>
                    events.push(...value),
                );
                await session.send("Tracing.start", {
                    categories: "devtools.timeline,blink.user_timing",
                    transferMode: "ReportEvents",
                });
                await page.evaluate(() => window.runBenchmarks());
                const finished = new Promise((resolve) =>
                    session.once("Tracing.tracingComplete", resolve),
                );
                await session.send("Tracing.end");
                await finished;
                const path = `${directory}/chromium-${reconciler ? "owned" : "current"}.trace.json.gz`;
                await writeFile(
                    path,
                    gzipSync(JSON.stringify({ traceEvents: events })),
                );
                const intervals = [];
                let start;
                for (const event of events) {
                    if (event.name === "graft-apply-start") start = event.ts;
                    if (
                        event.name === "graft-apply-end" &&
                        start !== undefined
                    ) {
                        intervals.push([start, event.ts]);
                        start = undefined;
                    }
                }
                const categories = {};
                for (const category of [
                    "Layout",
                    "Paint",
                    "UpdateLayoutTree",
                ]) {
                    const spans = events.filter(
                        (event) => event.name === category && event.ph === "X",
                    );
                    const outside = spans.filter(
                        (event) =>
                            !intervals.some(
                                ([a, b]) =>
                                    event.ts < b && event.ts + event.dur > a,
                            ),
                    );
                    categories[category] = {
                        events: spans.length,
                        outsideApplyEvents: outside.length,
                        outsideApplyUs: outside.reduce(
                            (sum, event) => sum + event.dur,
                            0,
                        ),
                    };
                }
                trace = {
                    available: true,
                    path,
                    applyIntervals: intervals.length,
                    categories,
                    scope: "Separate traced run, including setup and warm-up. Event totals are not exclusive CPU time or per-patch latency.",
                };
            }
            if (errors.length) throw new Error(errors.join("\n"));
            browsers.push({
                name,
                version: browser.version(),
                measurements,
                fallback,
                trace,
                errors,
            });
        } catch (error) {
            if (browser) throw error;
            browsers.push({ name, unavailable: String(error) });
        } finally {
            await browser?.close();
        }
    }
} finally {
    await vite.close();
}
await writeFile(
    `${directory}/${reconciler ? "owned-reconciler" : "current-pipeline"}.json`,
    JSON.stringify({ metadata, server, browsers }, null, 2) + "\n",
);
