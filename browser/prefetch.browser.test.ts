import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { listenForNavigation, type NavigationDetail } from "./events";
import { MEDIA_TYPE } from "./patches";
import { resetHypergraftForTests, startHypergraft } from "./requests";

const cleanup: (() => void)[] = [];
const original = location.href;
afterEach(() => {
    resetHypergraftForTests();
    for (const stop of cleanup.splice(0).reverse()) stop();
    history.replaceState({}, "", original);
    vi.unstubAllGlobals();
});

function setup() {
    document.body.innerHTML = `<main id="main" tabindex="-1"><input value="Draft"></main>
        <a href="?destination=prefetch" data-graft>Next page</a>`;
    const events: NavigationDetail[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(
                    '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template>Destination</template></graft-patch></graft-patch-set>',
                    {
                        headers: {
                            "content-type": MEDIA_TYPE,
                            "cache-control": "no-store",
                            "Graft-Prefetch": "intent",
                        },
                    },
                ),
        ),
    );
    cleanup.push(
        listenForNavigation((detail) => events.push(detail)),
        startHypergraft({ prefetch: { routes: [location.pathname] } }),
    );
    return { link: document.querySelector("a")!, events };
}

test.each(["pointer", "keyboard"])(
    "real %s intent reuses completed work without early document changes",
    async (kind) => {
        const { link, events } = setup();
        const length = history.length;
        if (kind === "pointer") await userEvent.hover(link);
        else {
            document.querySelector("input")!.focus();
            await userEvent.tab();
        }
        await expect.poll(() => vi.mocked(fetch).mock.calls.length).toBe(1);
        expect(events).toEqual([]);
        expect(document.querySelector("input")!.value).toBe("Draft");
        expect(location.href).toBe(original);
        expect(history.length).toBe(length);
        if (kind === "keyboard") await userEvent.keyboard("{Enter}");
        else await userEvent.click(link);
        await expect.poll(() => events.at(-1)?.state).toBe("succeeded");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(document.getElementById("main")!.textContent).toBe(
            "Destination",
        );
        expect(document.activeElement?.id).toBe("main");
        expect(history.length).toBe(length + 1);
    },
);

test("a replacement next link under a stationary pointer does not speculate again", async () => {
    document.body.innerHTML =
        '<main id="main" tabindex="-1"><div id="old"><a href="?step=one" data-graft>Next</a></div></main>';
    const events: NavigationDetail[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(
                    '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template><section id="new"><a href="?step=two" data-graft>Next</a></section></template></graft-patch></graft-patch-set>',
                    {
                        headers: {
                            "content-type": MEDIA_TYPE,
                            "cache-control": "no-store",
                            "Graft-Prefetch": "intent",
                        },
                    },
                ),
        ),
    );
    cleanup.push(
        listenForNavigation((detail) => events.push(detail)),
        startHypergraft({ prefetch: { links: "all" } }),
    );
    const link = document.querySelector("a")!;
    await userEvent.hover(link);
    await userEvent.click(link);
    await expect.poll(() => events.at(-1)?.state).toBe("succeeded");
    await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await userEvent.unhover(document.querySelector("a")!);
    await userEvent.hover(document.querySelector("a")!);
    expect(fetch).toHaveBeenCalledTimes(2);
});

test("a cancelled touch press never navigates and cannot supply a later activation", async () => {
    const { link, events } = setup();
    link.dispatchEvent(
        new PointerEvent("pointerdown", {
            bubbles: true,
            pointerType: "touch",
            isPrimary: true,
            button: 0,
        }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    link.dispatchEvent(
        new PointerEvent("pointercancel", {
            bubbles: true,
            pointerType: "touch",
        }),
    );
    expect(vi.mocked(fetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(events).toEqual([]);
    expect(location.href).toBe(original);
    link.click();
    await expect.poll(() => events.at(-1)?.state).toBe("succeeded");
    expect(fetch).toHaveBeenCalledTimes(2);
});
