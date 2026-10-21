import {
    mkdtemp,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, type InlineConfig } from "vite";
import { afterEach, expect, test, vi } from "vitest";
import { islandModules } from "./islands";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function fixture(): Promise<{
    root: string;
    config: InlineConfig;
    put: (path: string, content: string) => Promise<void>;
}> {
    const root = await mkdtemp(join(tmpdir(), "hypergraft-modules-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const put = async (path: string, content: string) => {
        await mkdir(join(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), content);
    };
    await put("features/.keep", "");
    await put(
        "runtime.ts",
        "export const defineIslandModules = modules => modules;",
    );
    await put(
        "main.ts",
        'import { islands } from "virtual:hypergraft/islands"; globalThis.islands = islands;',
    );
    return {
        root,
        put,
        config: {
            root,
            configFile: false,
            logLevel: "silent",
            plugins: islandModules({ roots: ["features"] }),
            resolve: {
                alias: { "hypergraft/browser": join(root, "runtime.ts") },
            },
            build: {
                manifest: true,
                minify: false,
                rolldownOptions: {
                    input: join(root, "main.ts"),
                    output: { entryFileNames: "main.js" },
                },
            },
        },
    };
}

test("automatic entries keep required CSS eager and share engines without eagerly importing them", async () => {
    const { root, put, config } = await fixture();
    await put(
        "features/engine.ts",
        'export function engine() { return "shared-engine-marker"; }',
    );
    for (const name of ["one", "two"]) {
        await put(`features/${name}/editor.css`, `.${name} { color: red; }`);
        await put(
            `features/${name}/browser.ts`,
            `import { engine } from "../engine"; import "./editor.css"; export const islands = { "${name}": () => engine() } satisfies Record<string, Function>;`,
        );
    }
    await put(
        "features/shell/browser.ts",
        'export const islandLoading = "eager"; export const islands = { shell() { return "shell-marker"; } };',
    );
    const result = await build(config);
    if (Array.isArray(result) || !("output" in result))
        throw new Error("Expected build output");
    const chunks = result.output.filter((output) => output.type === "chunk");
    const entry = chunks.find((chunk) => chunk.isEntry)!;
    expect(entry.code).toContain("shell-marker");
    expect(entry.code).not.toContain("shared-engine-marker");
    expect(
        chunks.filter((chunk) =>
            chunk.moduleIds.some((id) => id.endsWith("/engine.ts")),
        ),
    ).toHaveLength(1);
    const manifest = JSON.parse(
        await readFile(join(root, "dist/.vite/manifest.json"), "utf8"),
    );
    const css = (
        await Promise.all(
            manifest["main.ts"].css.map((path: string) =>
                readFile(join(root, "dist", path), "utf8"),
            ),
        )
    ).join("");
    expect(css).toContain(".one");
    expect(css).toContain(".two");
});

test.each([
    ["export const islands = {};", "empty islands"],
    ['export const islands = { ["computed"]: () => {} };', "Computed"],
    ["export const islands = { ...other };", "spreads"],
    ["export function islands() { return {}; }", "factories"],
    ['export { islands } from "./elsewhere";', "re-exporting"],
    [
        'export const islandLoading = "lazy"; export const islands = { x() {} };',
        "literal",
    ],
    ["export const islands = { x() {}, x() {} };", "Duplicate"],
])(
    "unsupported declarations fail at build time: %s",
    async (source, message) => {
        const { put, config } = await fixture();
        await put("features/browser.ts", source);
        await expect(build(config)).rejects.toThrow(message);
    },
);

test("duplicates across modules name both sources", async () => {
    const { put, config } = await fixture();
    await put(
        "features/one/browser.ts",
        "export const islands = { same() {} };",
    );
    await put(
        "features/two/browser.ts",
        "export const islands = { same() {} };",
    );
    await expect(build(config)).rejects.toThrow(/one\/browser.ts/);
});

test("build watch discovers additions, declaration edits, renames and removals from one root configuration", async () => {
    const { root, put, config } = await fixture();
    const watcher = await build({
        ...config,
        build: { ...config.build, watch: {} },
    });
    if (Array.isArray(watcher) || !("close" in watcher))
        throw new Error("Expected watcher");
    cleanups.push(() => watcher.close());
    const output = () => readFile(join(root, "dist/main.js"), "utf8");
    const contains = (name: string) =>
        vi.waitFor(async () => expect(await output()).toContain(name), {
            timeout: 10000,
        });
    await contains("globalThis.islands");
    await put(
        "features/one/browser.ts",
        "export const islands = { first() {} };",
    );
    await contains('"first"');
    await put(
        "features/one/browser.ts",
        "export const islands = { changed() {} };",
    );
    await contains('"changed"');
    await rename(join(root, "features/one"), join(root, "features/two"));
    await contains('"changed"');
    await rm(join(root, "features/two"), { recursive: true });
    await vi.waitFor(
        async () => expect(await output()).not.toContain('"changed"'),
        { timeout: 10000 },
    );
}, 30000);

test("development discovery invalidates the virtual entry for new and removed modules", async () => {
    const { root, put, config } = await fixture();
    const server = await createServer(config);
    cleanups.push(() => server.close());
    await server.transformRequest("/main.ts");
    await server.transformRequest("virtual:hypergraft/islands");
    await put(
        "features/one/browser.ts",
        "export const islands = { first() {} };",
    );
    await vi.waitFor(async () =>
        expect(
            (await server.transformRequest("virtual:hypergraft/islands"))?.code,
        ).toContain("first"),
    );
    await rm(join(root, "features/one"), { recursive: true });
    await vi.waitFor(async () =>
        expect(
            (await server.transformRequest("virtual:hypergraft/islands"))?.code,
        ).not.toContain("first"),
    );
});
