import { playwright } from "@vitest/browser-playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const BROWSER_ENGINES = ["chromium", "firefox", "webkit"] as const;
type BrowserEngine = (typeof BROWSER_ENGINES)[number];

function selectedBrowserEngine(): BrowserEngine {
    const value = process.env.HYPERGRAFT_BROWSER?.trim() || "chromium";
    if (!BROWSER_ENGINES.includes(value as BrowserEngine)) {
        throw new Error(
            `HYPERGRAFT_BROWSER must be one of: ${BROWSER_ENGINES.join(", ")}`,
        );
    }
    return value as BrowserEngine;
}

const browserEngine = selectedBrowserEngine();
const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
const launchOptions =
    browserEngine === "chromium" && executablePath ? { executablePath } : {};
const instances = (
    [
        { browser: "chromium" },
        { browser: "firefox" },
        { browser: "webkit" },
    ] as const
).filter((instance) => instance.browser === browserEngine);
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const cspHtmlPath = path.join(rootDir, "browser/fixtures/csp.html");
const CSP_HTML_PATH = "/browser/fixtures/csp.html";

function trustedTypesDirective(mode: string): string {
    return mode === "denied" ? "'none'" : "hypergraft";
}

function contentSecurityPolicy(mode: string): string {
    return [
        "default-src 'none'",
        "script-src 'self' 'nonce-hypergraft-csp-fixture'",
        "style-src 'none'",
        "img-src 'none'",
        "font-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
        "require-trusted-types-for 'script'",
        `trusted-types ${trustedTypesDirective(mode)}`,
    ].join("; ");
}

function cspFixturePlugin(): Plugin {
    return {
        name: "hypergraft-csp-fixtures",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!req.url) {
                    next();
                    return;
                }
                const url = new URL(req.url, "http://hypergraft.test");
                if (url.pathname !== CSP_HTML_PATH) {
                    next();
                    return;
                }
                const mode = url.searchParams.get("mode") ?? "allowed";
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.setHeader(
                    "Content-Security-Policy",
                    contentSecurityPolicy(mode),
                );
                res.end(fs.readFileSync(cspHtmlPath, "utf8"));
            });
        },
    };
}

export default defineConfig({
    plugins: [cspFixturePlugin()],
    server: {
        hmr: false,
    },
    test: {
        include: ["browser/**/*.browser.test.ts"],
        browser: {
            enabled: true,
            provider: playwright({ launchOptions }),
            headless: true,
            instances: [...instances],
        },
    },
});
