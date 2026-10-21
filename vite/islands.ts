import {
    mkdtempSync,
    readdirSync,
    rmSync,
    watch,
    writeFileSync,
    type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

export { islandModules, type IslandModulesOptions } from "./modules.js";

export function discoverIslandFiles(roots: readonly string[]): string[] {
    const files = new Set<string>();
    const visit = (directory: string) => {
        let entries;
        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            // Editors can rename a directory between its parent's scan and this read.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            if (entry.name === "node_modules") continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name === "browser.ts")
                files.add(path);
        }
    };
    for (const root of roots) visit(root);
    return [...files].sort();
}

export interface IslandWatchOptions {
    importer: string;
    roots: readonly string[];
}

export function watchIslandModules(options: IslandWatchOptions): Plugin {
    let importer: string;
    let roots: string[];
    let enabled = false;
    let scratch: string | undefined;
    let trigger: string;
    let signature: string;
    let revision = 0;
    let failure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchers: FSWatcher[] = [];
    const discover = () => JSON.stringify(discoverIslandFiles(roots));
    const stop = () => {
        clearTimeout(timer);
        for (const watcher of watchers.splice(0)) watcher.close();
        if (scratch) rmSync(scratch, { recursive: true, force: true });
        scratch = undefined;
    };
    return {
        name: "hypergraft-island-watch",
        apply: "build",
        enforce: "pre",
        configResolved(config) {
            enabled = !!config.build.watch;
            importer = resolve(config.root, options.importer);
            roots = options.roots.map((root) => resolve(config.root, root));
        },
        buildStart() {
            if (failure) this.error(failure);
            if (!enabled || scratch) return;
            try {
                signature = discover();
                scratch = mkdtempSync(join(tmpdir(), "hypergraft-islands-"));
                trigger = join(scratch, "revision");
                writeFileSync(trigger, "0");
                const report = (error: Error) => {
                    if (!scratch) return;
                    failure = error;
                    writeFileSync(trigger, String(++revision));
                };
                for (const root of roots)
                    watchers.push(
                        watch(root, { recursive: true }, () => {
                            if (!scratch) return;
                            clearTimeout(timer);
                            timer = setTimeout(() => {
                                try {
                                    const next = discover();
                                    if (next === signature && !failure) return;
                                    signature = next;
                                    failure = undefined;
                                } catch (error) {
                                    report(error as Error);
                                    return;
                                }
                                writeFileSync(trigger, String(++revision));
                            }, 20);
                        }).on("error", report),
                    );
            } catch (error) {
                stop();
                throw error;
            }
        },
        transform(_code, id) {
            // A private file dependency invalidates the glob importer without editing host source.
            if (enabled && resolve(id) === importer) this.addWatchFile(trigger);
        },
        closeWatcher: stop,
    };
}
