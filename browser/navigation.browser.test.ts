import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { listenForNavigation, type NavigationDetail } from "./events";
import { MEDIA_TYPE } from "./patches";
import { resetHypergraftForTests, startHypergraft } from "./requests";

const cleanup: (() => void)[] = [];

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
