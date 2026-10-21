import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseSync, type Expression } from "oxc-parser";
import { normalizePath, type Plugin, type ViteDevServer } from "vite";
import { discoverIslandFiles, watchIslandModules } from "./islands.js";

export interface IslandModulesOptions {
    roots: readonly string[];
}

const virtualId = "virtual:hypergraft/islands";

function expression(value: Expression): Expression {
    while (
        value.type === "TSSatisfiesExpression" ||
        value.type === "TSAsExpression" ||
        value.type === "ParenthesizedExpression"
    )
        value = value.expression;
    return value;
}

export function islandModules(options: IslandModulesOptions): Plugin[] {
    let roots: string[] = [];
    let hostRoot: string;
    let resolvedId: string;
    let scratch: string;
    let watching = false;
    const stop = () => {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
    };
    const refresh = (server: ViteDevServer) => {
        const module = server.moduleGraph.getModuleById(resolvedId);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
    };
    const plugin: Plugin = {
        name: "hypergraft-island-modules",
        enforce: "pre",
        configResolved(config) {
            hostRoot = config.root;
            roots = options.roots.map((root) => resolve(config.root, root));
            watching = !!config.build.watch;
            // Build watch needs a real importer to invalidate discovery dependencies.
            scratch = mkdtempSync(resolve(tmpdir(), "hypergraft-registry-"));
            resolvedId = resolve(scratch, "islands.ts");
            writeFileSync(resolvedId, "");
        },
        resolveId(id, importer) {
            if (id === virtualId)
                return { id: resolvedId, moduleSideEffects: true };
            if (importer === resolvedId && id === "hypergraft/browser")
                return this.resolve(id, resolve(hostRoot, "package.json"));
        },
        load(id) {
            if (id === resolvedId) return "";
        },
        async transform(_code, id) {
            if (id !== resolvedId) return;
            const imports: string[] = [
                'import { defineIslandModules } from "hypergraft/browser";',
            ];
            const definitions: string[] = [];
            const declared = new Map<string, string>();
            for (const file of discoverIslandFiles(roots)) {
                this.addWatchFile(file);
                const fail = (message: string): never =>
                    this.error(
                        `${file}: ${message}. Automatic islands need an exported literal islands object; use collectIslands for factories or dynamic registries.`,
                    );
                const parsed = parseSync(file, readFileSync(file, "utf8"));
                if (parsed.errors.length) fail(parsed.errors[0]!.message);
                let names: string[] | undefined;
                let eager = false;
                for (const statement of parsed.program.body) {
                    if (
                        statement.type === "ImportDeclaration" &&
                        /\.(css|scss|sass|less|styl)(?:\?|$)/.test(
                            statement.source.value,
                        )
                    ) {
                        if (
                            statement.specifiers.length ||
                            statement.source.value.includes("?")
                        )
                            fail(
                                "Required stylesheets must use direct, side-effect imports",
                            );
                        const css = await this.resolve(
                            statement.source.value,
                            file,
                        );
                        if (!css)
                            fail(
                                `Cannot resolve stylesheet ${statement.source.value}`,
                            );
                        imports.push(`import ${JSON.stringify(css!.id)};`);
                    }
                    if (statement.type !== "ExportNamedDeclaration") continue;
                    for (const specifier of statement.specifiers) {
                        const name =
                            specifier.exported.type === "Identifier"
                                ? specifier.exported.name
                                : specifier.exported.value;
                        if (name === "islands" || name === "islandLoading")
                            fail(
                                `Declare ${name} directly, rather than re-exporting it`,
                            );
                    }
                    const declaration = statement.declaration;
                    if (
                        declaration?.type === "FunctionDeclaration" &&
                        declaration.id?.name === "islands"
                    )
                        fail(
                            "Island factories are not supported by automatic discovery",
                        );
                    if (declaration?.type !== "VariableDeclaration") continue;
                    for (const item of declaration.declarations) {
                        if (item.id.type !== "Identifier") continue;
                        if (item.id.name === "islandLoading") {
                            if (
                                item.init?.type !== "Literal" ||
                                item.init.value !== "eager"
                            )
                                fail(
                                    'islandLoading must be the literal "eager", or omitted',
                                );
                            eager = true;
                        }
                        if (item.id.name !== "islands") continue;
                        const value = item.init && expression(item.init);
                        if (value?.type !== "ObjectExpression")
                            return fail("islands must be a literal object");
                        names = [];
                        for (const property of value.properties) {
                            if (
                                property.type !== "Property" ||
                                property.computed ||
                                property.kind !== "init"
                            )
                                return fail(
                                    "Computed keys, spreads and accessors are not supported",
                                );
                            const key = property.key;
                            const name =
                                key.type === "Identifier"
                                    ? key.name
                                    : key.type === "Literal" &&
                                        typeof key.value === "string"
                                      ? key.value
                                      : undefined;
                            if (!name)
                                return fail(
                                    "Island names must be non-empty literal strings",
                                );
                            if (declared.has(name))
                                fail(
                                    `Duplicate island ${JSON.stringify(name)} (also declared in ${declared.get(name)})`,
                                );
                            declared.set(name, file);
                            names.push(name);
                        }
                    }
                }
                if (!names?.length)
                    fail("Missing or empty islands declaration");
                const path = JSON.stringify(
                    normalizePath(resolve(dirname(file), "browser.ts")),
                );
                const index = definitions.length;
                if (eager)
                    imports.push(`import * as module${index} from ${path};`);
                definitions.push(
                    `{ names: ${JSON.stringify(names)}, ${eager ? `module: module${index}` : `load: () => import(${path})`} }`,
                );
            }
            return {
                code: `${imports.join("\n")}\nexport const islands = defineIslandModules([${definitions.join(",\n")}]);\n`,
                map: { mappings: "" },
            };
        },
        configureServer(server) {
            server.watcher.add(roots);
            const changed = (path: string) => {
                if (
                    path.endsWith("/browser.ts") &&
                    roots.some((root) => path.startsWith(`${root}/`))
                )
                    refresh(server);
            };
            server.watcher.on("add", changed).on("unlink", changed);
            server.httpServer?.once("close", () => {
                server.watcher.off("add", changed).off("unlink", changed);
                stop();
            });
        },
        closeWatcher: stop,
        closeBundle() {
            if (!watching) stop();
        },
        handleHotUpdate(context) {
            if (context.file.endsWith("/browser.ts")) {
                refresh(context.server);
                return [];
            }
        },
    };
    return [
        plugin,
        watchIslandModules({
            get importer() {
                return resolvedId;
            },
            roots: options.roots,
        }),
    ];
}
