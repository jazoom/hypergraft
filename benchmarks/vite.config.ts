import { defineConfig } from "vite";

export default defineConfig({
    plugins: [
        {
            name: "measure-final-id-scan",
            enforce: "pre",
            transform(code, id) {
                if (!id.endsWith("/browser/patches.ts")) return;
                // Benchmark-only timers measure the actual loop without a production hook or a duplicate validator.
                const start = "    const survivingIds = new Set<string>();";
                const end =
                    '    return {\n        kind: "patches",\n        batch: {';
                if (
                    code.split(start).length !== 2 ||
                    code.split(end).length !== 2
                )
                    throw new Error(
                        "The final ID scan measurement boundaries changed",
                    );
                return {
                    code: code
                        .replace(
                            start,
                            `    const idScanStart = performance.now();\n${start}`,
                        )
                        .replace(
                            end,
                            `    performance.measure("graft-final-ids", { start: idScanStart, end: performance.now() });\n${end}`,
                        ),
                    map: null,
                };
            },
        },
    ],
    server: { host: "127.0.0.1", port: 4174, strictPort: true },
    build: {
        outDir: "dist/benchmarks",
        rollupOptions: { input: "benchmarks/browser.html" },
    },
});
