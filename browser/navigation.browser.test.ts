import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { listenForNavigation, type NavigationDetail } from "./events";
import { MEDIA_TYPE } from "./patches";
import { resetHypergraftForTests, startHypergraft } from "./requests";
import { bindNavigationRecovery } from "./navigation-feedback";

const cleanup: (() => void)[] = [];

test("retry retains native click guards and real history traversals select fresh authoritative content", async () => {
    const original = location.href;
    document.body.innerHTML = `<main id="main" tabindex="-1"><input value="Draft"></main>
        <a href="#main">Skip to content</a>
        <a data-graft href="?destination=one">One</a><a data-graft href="?destination=two">Two</a>
        <p data-graft-navigation-status role="status" aria-atomic="true"></p>
        <aside data-graft-navigation-failure hidden><p data-graft-navigation-message>Connection failed</p><a data-graft data-graft-navigation-retry>Retry</a><button data-graft-navigation-dismiss>Dismiss</button></aside>`;
    const links = document.querySelectorAll<HTMLAnchorElement>(
        "a[data-graft][href]",
    );
    const events: NavigationDetail[] = [];
    let fail = true;
    const requests: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: URL) => {
            requests.push(url.href);
            if (fail) throw new TypeError("offline");
            return new Response(
                `<graft-patch-set version="1"><graft-patch operation="children" target="main"><template>${url.search}</template></graft-patch></graft-patch-set>`,
                { headers: { "content-type": MEDIA_TYPE } },
            );
        }),
    );
    cleanup.push(
        () => history.replaceState({}, "", original),
        listenForNavigation((detail) => events.push(detail)),
        bindNavigationRecovery(document),
        startHypergraft(),
    );
    await userEvent.click(
        document.querySelector<HTMLAnchorElement>('a[href="#main"]')!,
    );
    await expect.poll(() => location.hash).toBe("#main");
    const length = history.length;
    await userEvent.click(links[0]!);
    await expect.poll(() => events.at(-1)?.state).toBe("failed");
    expect(document.querySelector("input")?.value).toBe("Draft");
    expect(location.hash).toBe("#main");
    expect(history.length).toBe(length);
    const retry = document.querySelector<HTMLAnchorElement>(
        "[data-graft-navigation-retry]",
    )!;
    retry.addEventListener("click", (event) => event.preventDefault(), {
        once: true,
        capture: true,
    });
    await userEvent.click(retry);
    expect(requests).toHaveLength(1);
    fail = false;
    retry.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => events.at(-1)?.state).toBe("succeeded");
    expect(history.length).toBe(length + 1);
    expect(document.activeElement?.id).toBe("main");
    await userEvent.click(links[1]!);
    await expect.poll(() => location.search).toBe("?destination=two");
    history.back();
    await expect
        .poll(() => document.getElementById("main")?.textContent)
        .toBe("?destination=one");
    expect(location.search).toBe("?destination=one");
    history.forward();
    await expect
        .poll(() => document.getElementById("main")?.textContent)
        .toBe("?destination=two");
    expect(location.search).toBe("?destination=two");
    expect(requests).toHaveLength(5);
});

test.each([
    "visible",
    "display-none",
    "visibility-hidden",
    "inert",
    "detached",
])("dismissal restores focus when the source link is %s", async (state) => {
    document.body.innerHTML = `<main id="main" tabindex="-1">Current page</main>
            <nav><a data-graft href="?destination=next">Next page</a></nav>
            <p data-graft-navigation-status role="status" aria-atomic="true"></p>
            <aside data-graft-navigation-failure hidden><p data-graft-navigation-message>Connection failed</p><a data-graft data-graft-navigation-retry>Retry</a><button type="button" data-graft-navigation-dismiss>Dismiss</button></aside>`;
    const link = document.querySelector<HTMLAnchorElement>("nav a")!;
    const menu = document.querySelector("nav")!;
    const failure = document.querySelector<HTMLElement>(
        "[data-graft-navigation-failure]",
    )!;
    const status = document.querySelector<HTMLElement>(
        "[data-graft-navigation-status]",
    )!;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    cleanup.push(bindNavigationRecovery(document), startHypergraft());
    await userEvent.click(link);
    await expect.poll(() => failure.hidden).toBe(false);
    expect(status.textContent).toBe("Connection failed");
    expect(status.closest("[hidden]")).toBeNull();
    if (state === "display-none") menu.style.display = "none";
    if (state === "visibility-hidden") menu.style.visibility = "hidden";
    if (state === "inert") menu.inert = true;
    if (state === "detached") menu.remove();
    document
        .querySelector<HTMLButtonElement>("[data-graft-navigation-dismiss]")!
        .focus();
    await userEvent.keyboard("{Enter}");
    expect(failure.hidden).toBe(true);
    expect(status.textContent).toBe("");
    expect(document.activeElement).toBe(
        state === "visible" ? link : document.getElementById("main"),
    );
});

afterEach(() => {
    resetHypergraftForTests();
    for (const stop of cleanup.splice(0).reverse()) stop();
    vi.unstubAllGlobals();
});

test.each(["pointer", "keyboard"])(
    "%s activation reports the selected link and teardown prevents late success",
    async (input) => {
        document.body.innerHTML =
            '<main id="main">Original page</main><a href="/next" data-graft>Next page</a>';
        const link = document.querySelector("a")!;
        const events: NavigationDetail[] = [];
        let resolve!: (response: Response) => void;
        vi.stubGlobal(
            "fetch",
            vi.fn(
                () =>
                    new Promise<Response>((done) => {
                        resolve = done;
                    }),
            ),
        );
        cleanup.push(listenForNavigation((detail) => events.push(detail)));
        const stop = startHypergraft();
        cleanup.push(stop);
        if (input === "keyboard") {
            link.focus();
            await userEvent.keyboard("{Enter}");
        } else await userEvent.click(link);
        expect(events).toEqual([
            {
                requestId: expect.any(Number),
                url: link.href,
                cause: "link-navigation",
                link,
                state: "started",
            },
        ]);
        stop();
        resolve(
            new Response(
                '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template>Obsolete page</template></graft-patch></graft-patch-set>',
                { headers: { "content-type": MEDIA_TYPE } },
            ),
        );
        await new Promise((done) => setTimeout(done, 0));
        expect(events.map((event) => event.state)).toEqual([
            "started",
            "disposed",
        ]);
        expect(document.getElementById("main")!.textContent).toBe(
            "Original page",
        );
    },
);
