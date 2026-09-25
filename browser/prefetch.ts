import { MAX_RESPONSE_BYTES, MEDIA_TYPE } from "./patches";
import { readBoundedResponse } from "./read-response";

export const GRAFT_PREFETCH = "Graft-Prefetch";
export const PREFETCH_INTENT = "intent";
export const DEFAULT_PREFETCH_MAX_AGE_MS = 10_000;
// Browser timers use a signed 32-bit delay. Larger values can expire immediately.
export const PREFETCH_MAX_AGE_LIMIT_MS = 2_147_483_647;
export const PREFETCH_MAX_BYTES = 512 * 1024;
export const PREFETCH_MAX_REQUESTS = 4;
export const PREFETCH_WINDOW_MS = 10_000;

export type PrefetchOptions = (
    | { routes: readonly string[]; links?: never }
    | { links?: "marked" | "all"; routes?: never }
) & { maxAgeMs?: number };

export type NavigationResponse = { response: Response; text?: string };
type Entry = {
    url: string;
    started: number;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    adopted: boolean;
    result: Promise<NavigationResponse | undefined>;
};

export function fetchSafe(
    url: URL,
    kind: "navigation" | "patch",
    signal?: AbortSignal,
) {
    return fetch(url, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "manual",
        signal,
        headers: { "Graft-Request": kind, Accept: MEDIA_TYPE },
    });
}

function savesData(): boolean {
    return (
        (navigator as Navigator & { connection?: { saveData?: boolean } })
            .connection?.saveData === true
    );
}

function prefetchLinkUrl(
    link: HTMLAnchorElement,
    routes: ReadonlySet<string> | undefined,
    allLinks: boolean,
): URL | undefined {
    const attribute = link.getAttribute("data-graft-prefetch");
    if (
        !link.isConnected ||
        !link.matches("a[data-graft][href]") ||
        (attribute !== null && attribute !== "" && attribute !== "true") ||
        link.hasAttribute("download") ||
        (link.target && link.target !== "_self") ||
        link.relList.contains("external") ||
        link.hasAttribute("data-graft-navigation-retry")
    )
        return;
    let url: URL;
    try {
        url = new URL(link.href, document.baseURI);
    } catch {
        return;
    }
    if (
        url.origin !== location.origin ||
        !["http:", "https:"].includes(url.protocol) ||
        url.href.includes("#") ||
        url.username ||
        url.password ||
        url.href === location.href
    )
        return;
    if (routes ? !routes.has(url.pathname) : !allLinks && attribute === null)
        return;
    return url;
}

export function createPrefetch(options: true | PrefetchOptions) {
    const maxAgeMs =
        options === true || options.maxAgeMs === undefined
            ? DEFAULT_PREFETCH_MAX_AGE_MS
            : options.maxAgeMs;
    if (
        !Number.isInteger(maxAgeMs) ||
        maxAgeMs < 1 ||
        maxAgeMs > PREFETCH_MAX_AGE_LIMIT_MS
    )
        throw new RangeError(
            "prefetch.maxAgeMs must be an integer from 1 to 2147483647.",
        );
    const routes =
        options !== true && options.routes
            ? new Set(options.routes)
            : undefined;
    const allLinks = options !== true && options.links === "all";
    let current: Entry | undefined;
    // Admission survives cancellation and navigation. Rapid pointer movement cannot refund traffic.
    const starts: number[] = [];
    const invalidate = (preserve?: () => boolean) => {
        const entry = current;
        if (entry && preserve?.()) return;
        current = undefined;
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.controller.abort();
    };
    const available = () => !document.hidden && !savesData();
    const start = (url: URL) => {
        if (!available()) {
            invalidate();
            return;
        }
        const now = performance.now();
        if (current?.url === url.href && now - current.started < maxAgeMs)
            return;
        invalidate();
        while (starts.length && now - starts[0]! >= PREFETCH_WINDOW_MS)
            starts.shift();
        if (starts.length >= PREFETCH_MAX_REQUESTS) return;
        starts.push(now);
        const entry: Entry = {
            url: url.href,
            started: now,
            controller: new AbortController(),
            timer: setTimeout(() => {
                if (current === entry) invalidate();
            }, maxAgeMs),
            adopted: false,
            result: Promise.resolve(undefined),
        };
        current = entry;
        entry.result = (async () => {
            try {
                const response = await fetchSafe(
                    url,
                    "navigation",
                    entry.controller.signal,
                );
                if (
                    entry.controller.signal.aborted ||
                    response.status !== 200 ||
                    response.redirected ||
                    (response.url && response.url !== url.href) ||
                    response.headers.get(GRAFT_PREFETCH) !== PREFETCH_INTENT ||
                    response.headers.get("content-type") !== MEDIA_TYPE ||
                    ![null, "complete"].includes(
                        response.headers.get("Graft-Transfer"),
                    ) ||
                    !response.headers
                        .get("cache-control")
                        ?.split(",")
                        .some(
                            (value) =>
                                value.trim().toLowerCase() === "no-store",
                        )
                ) {
                    await response.body?.cancel().catch(() => undefined);
                    return;
                }
                const text = await readBoundedResponse(response, {
                    maxBytes: () =>
                        entry.adopted ? MAX_RESPONSE_BYTES : PREFETCH_MAX_BYTES,
                    signal: entry.controller.signal,
                });
                if (entry.controller.signal.aborted) return;
                return { response, text };
            } catch (error) {
                // After adoption, ordinary navigation owns transport failures and recovery.
                if (entry.adopted) throw error;
                return;
            } finally {
                // A late result cannot retire another destination.
                if (current === entry && entry.controller.signal.aborted)
                    invalidate();
            }
        })();
        void entry.result.then(
            (result) => {
                if (!result && current === entry) invalidate();
            },
            () => undefined,
        );
    };
    const take = (
        url: URL,
        signal: AbortSignal,
    ): Promise<NavigationResponse | undefined> | undefined => {
        const entry = current;
        if (
            !available() ||
            !entry ||
            entry.url !== url.href ||
            entry.controller.signal.aborted ||
            performance.now() - entry.started >= maxAgeMs
        ) {
            invalidate();
            return;
        }
        current = undefined;
        entry.adopted = true;
        clearTimeout(entry.timer);
        const abort = () => entry.controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const result = entry.result.finally(() =>
            signal.removeEventListener("abort", abort),
        );
        // A synchronous navigation listener can dispose the runtime before its consumer awaits this result.
        void result.catch(() => undefined);
        return result;
    };
    return {
        linkUrl: (link: HTMLAnchorElement) =>
            prefetchLinkUrl(link, routes, allLinks),
        start,
        take,
        invalidate,
    };
}

export type Prefetch = ReturnType<typeof createPrefetch>;
