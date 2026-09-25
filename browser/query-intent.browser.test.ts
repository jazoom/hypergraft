import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { startHypergraft, resetHypergraftForTests } from "./requests";
import { MEDIA_TYPE } from "./patches";

const original = location.href;

function reply(text: string): Response {
    return new Response(
        `<graft-patch-set version="1"><graft-patch operation="children" target="results"><template>${text}</template></graft-patch></graft-patch-set>`,
        { headers: { "content-type": MEDIA_TYPE } },
    );
}

afterEach(() => {
    resetHypergraftForTests();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    history.replaceState({}, "", original);
});

test.each(["input", "compositionstart", "manual"])(
    "%s rejects the old query without loss of focus or selection",
    async (gesture) => {
        document.body.innerHTML = `<form method="get" data-graft><input name="q" data-graft-submit-on="input" data-graft-debounce="200"><button>Search</button></form><div id="results">Previous results</div>`;
        const form = document.querySelector("form")!;
        const input = document.querySelector("input")!;
        let resolve!: (value: Response) => void;
        const fetcher = vi
            .fn()
            .mockReturnValueOnce(
                new Promise<Response>((done) => {
                    resolve = done;
                }),
            )
            .mockResolvedValueOnce(reply("New results"));
        vi.stubGlobal("fetch", fetcher);
        startHypergraft();
        form.requestSubmit();
        input.focus();
        input.value = "New query";
        input.setSelectionRange(2, 5, "backward");
        if (gesture === "manual") input.removeAttribute("data-graft-submit-on");
        input.dispatchEvent(
            new Event(gesture === "manual" ? "input" : gesture, {
                bubbles: true,
            }),
        );
        resolve(reply("Obsolete results"));
        await new Promise((done) => setTimeout(done, 50));
        expect(document.getElementById("results")!.textContent).toBe(
            "Previous results",
        );
        expect(input.value).toBe("New query");
        expect(document.activeElement).toBe(input);
        expect([
            input.selectionStart,
            input.selectionEnd,
            input.selectionDirection,
        ]).toEqual([2, 5, "backward"]);
        if (gesture === "compositionstart")
            input.dispatchEvent(
                new CompositionEvent("compositionend", { bubbles: true }),
            );
        if (gesture === "manual") form.requestSubmit();
        await expect
            .poll(() => document.getElementById("results")!.textContent)
            .toBe("New results");
    },
);

test.each(["checkbox", "text"])(
    "native %s change preserves an input-triggered query",
    async (type) => {
        document.body.innerHTML = `<form method="get" data-graft><input type="${type}" name="q" data-graft-submit-on="input"><button type="button">Other control</button></form><div id="results">Previous results</div>`;
        const input = document.querySelector("input")!;
        let resolve!: (value: Response) => void;
        let signal: AbortSignal | undefined;
        const fetcher = vi.fn(
            (_url: URL, init: RequestInit) =>
                new Promise<Response>((done) => {
                    resolve = done;
                    signal = init.signal ?? undefined;
                }),
        );
        vi.stubGlobal("fetch", fetcher);
        startHypergraft();
        if (type === "checkbox") await userEvent.click(input);
        else await userEvent.fill(input, "New query");
        await expect.poll(() => fetcher.mock.calls.length).toBe(1);
        if (type === "text")
            await userEvent.click(document.querySelector("button")!);
        expect(signal?.aborted).toBe(false);
        resolve(reply("New results"));
        await expect
            .poll(() => document.getElementById("results")!.textContent)
            .toBe("New results");
        expect(fetcher).toHaveBeenCalledTimes(1);
    },
);
