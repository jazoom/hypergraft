import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const exampleRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    root: exampleRoot,
    publicDir: false,
    resolve: {
        alias: {
            "hypergraft/browser": fileURLToPath(
                new URL("../../browser/index.ts", import.meta.url),
            ),
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        assetsInlineLimit: 0,
        cssCodeSplit: false,
        sourcemap: false,
        rolldownOptions: {
            input: fileURLToPath(new URL("browser/main.ts", import.meta.url)),
            output: {
                format: "es",
                entryFileNames: "main.js",
                assetFileNames: "style.css",
            },
        },
    },
});
