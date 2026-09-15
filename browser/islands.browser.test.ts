import { expect, test } from "vitest";
import { observeIslands } from "./islands";
import { apply, preflightLive } from "./patches";

test("island attribute changes update lifetimes on a retained Morphlex root", async () => {
    const host = document.createElement("div");
    host.id = "island-target";
    host.innerHTML = '<section id="island-root"><b>Content</b></section>';
    document.body.append(host);
    const root = host.firstElementChild;
    const mounted: HTMLElement[] = [];
    const aborted: boolean[] = [];
    const initialise = (
        element: HTMLElement,
        { signal }: { signal: AbortSignal },
    ) => {
        mounted.push(element);
        return { destroy: () => aborted.push(signal.aborted) };
    };
    const dispose = observeIslands({ first: initialise, second: initialise });
    const update = async (attribute: string) => {
        apply(
            preflightLive(
                `<graft-patch-set version="1"><graft-patch operation="children" target="island-target"><template><section id="island-root"${attribute}><b>Content</b></section></template></graft-patch></graft-patch-set>`,
            ),
        );
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(host.firstElementChild).toBe(root);
    };
    try {
        expect(mounted).toEqual([]);
        await update(' data-island="first"');
        expect(mounted).toEqual([root]);
        await update(' data-island="second"');
        expect(mounted).toEqual([root, root]);
        expect(aborted).toEqual([true]);
        await update("");
        expect(aborted).toEqual([true, true]);
        expect(root!.isConnected).toBe(true);
    } finally {
        dispose();
        host.remove();
    }
});
