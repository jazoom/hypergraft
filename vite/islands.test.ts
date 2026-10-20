import {
    cp,
    mkdtemp,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, test, vi } from "vitest";

test("the packaged Vite plugin refreshes discovered islands without touching source", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypergraft-island-watch-"));
    let watcher: Awaited<ReturnType<typeof build>> | undefined;
    try {
        // Load the public entry from node_modules: Node cannot strip package TypeScript.
        const installed = join(root, "node_modules/hypergraft");
        await mkdir(installed, { recursive: true });
        await cp(
            new URL("../package.json", import.meta.url),
            join(installed, "package.json"),
        );
        await cp(
            new URL("../dist/vite", import.meta.url),
            join(installed, "dist/vite"),
            { recursive: true },
        );
        const configFile = join(root, "vite.config.mjs");
        await writeFile(
            configFile,
            `import { watchIslandModules } from "hypergraft/vite";
            export default { plugins: [watchIslandModules({ importer: "main.ts", roots: ["features"] })] };`,
        );
        await mkdir(join(root, "features"));
        const source = `globalThis.islands = import.meta.glob("./features/**/browser.ts", { eager: true });`;
        await writeFile(join(root, "main.ts"), source);
        watcher = await build({
            root,
            configFile,
            logLevel: "silent",
            build: {
                minify: false,
                watch: {},
                rolldownOptions: {
                    input: join(root, "main.ts"),
                    output: { entryFileNames: "main.js" },
                },
            },
        });
        if (Array.isArray(watcher) || !("close" in watcher))
            throw new Error("Expected a build watcher");
        const output = () => readFile(join(root, "dist/main.js"), "utf8");
        const contains = (text: string) =>
            vi.waitFor(async () => expect(await output()).toContain(text), {
                timeout: 10000,
            });
        await contains("globalThis.islands");
        await mkdir(join(root, "features/one"));
        await writeFile(
            join(root, "features/one/browser.ts"),
            `export const islands = { first: () => "first-marker" };`,
        );
        await contains("first-marker");
        await writeFile(
            join(root, "features/one/browser.ts"),
            `export const islands = { first: () => "edited-marker" };`,
        );
        await contains("edited-marker");
        await rename(join(root, "features/one"), join(root, "features/two"));
        await contains("./features/two/browser.ts");
        await rename(
            join(root, "features/two/browser.ts"),
            join(root, "features/two/helper.ts"),
        );
        await vi.waitFor(
            async () => expect(await output()).not.toContain("edited-marker"),
            { timeout: 10000 },
        );
        await rename(
            join(root, "features/two/helper.ts"),
            join(root, "features/two/browser.ts"),
        );
        await contains("edited-marker");
        await rm(join(root, "features/two"), { recursive: true });
        await vi.waitFor(
            async () => expect(await output()).not.toContain("edited-marker"),
            { timeout: 10000 },
        );
        expect(await readFile(join(root, "main.ts"), "utf8")).toBe(source);
    } finally {
        if (watcher && !Array.isArray(watcher) && "close" in watcher)
            await watcher.close();
        await rm(root, { recursive: true, force: true });
    }
}, 60000);
