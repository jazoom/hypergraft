export type NavigationScrollOptions =
    { mode: "reset" | "preserve" } | { mode: "targeted"; pageRoot: string };

type Position = {
    x: number;
    y: number;
    anchor?: string;
    offset?: number;
    offsetX?: number;
};
type Snapshot = { window: Position; containers: Map<string, Position> };

function capture(root?: HTMLElement): Position {
    const top = root?.getBoundingClientRect().top ?? 0;
    const bottom = root?.getBoundingClientRect().bottom ?? innerHeight;
    const anchors = (root ?? document).querySelectorAll<HTMLElement>(
        "[data-graft-scroll-anchor]",
    );
    const anchor = [...anchors].find((element) => {
        if (element.closest("[data-graft-scroll]") !== (root ?? null))
            return false;
        const rect = element.getBoundingClientRect();
        const left = root?.getBoundingClientRect().left ?? 0;
        const right = root?.getBoundingClientRect().right ?? innerWidth;
        return (
            rect.height > 0 &&
            rect.bottom > top &&
            rect.top < bottom &&
            rect.right > left &&
            rect.left < right
        );
    });
    return {
        x: root?.scrollLeft ?? scrollX,
        y: root?.scrollTop ?? scrollY,
        ...(anchor
            ? {
                  anchor: anchor.dataset.graftScrollAnchor,
                  offset: anchor.getBoundingClientRect().top - top,
                  offsetX:
                      anchor.getBoundingClientRect().left -
                      (root?.getBoundingClientRect().left ?? 0),
              }
            : {}),
    };
}

function restore(position: Position | undefined, root?: HTMLElement): void {
    let x = position?.x ?? 0;
    let y = position?.y ?? 0;
    if (position?.anchor) {
        const anchor = [
            ...(root ?? document).querySelectorAll<HTMLElement>(
                "[data-graft-scroll-anchor]",
            ),
        ].find(
            (element) =>
                element.dataset.graftScrollAnchor === position.anchor &&
                element.closest("[data-graft-scroll]") === (root ?? null),
        );
        if (anchor) {
            x =
                (root?.scrollLeft ?? scrollX) +
                anchor.getBoundingClientRect().left -
                (root?.getBoundingClientRect().left ?? 0) -
                (position.offsetX ?? 0);
            y =
                (root?.scrollTop ?? scrollY) +
                anchor.getBoundingClientRect().top -
                (root?.getBoundingClientRect().top ?? 0) -
                (position.offset ?? 0);
        } else {
            // A missing logical position must not select unrelated content at an old offset.
            x = 0;
            y = 0;
        }
    }
    if (root) root.scrollTo({ left: x, top: y, behavior: "instant" });
    else window.scrollTo({ left: x, top: y, behavior: "instant" });
}

function containers(): HTMLElement[] {
    return [
        ...document.querySelectorAll<HTMLElement>("[data-graft-scroll][id]"),
    ].slice(0, 32);
}

export function scrollAfterNavigation(
    options: NavigationScrollOptions,
    replacementTargets: Iterable<HTMLElement>,
): void {
    if (options.mode === "preserve") return;
    const targets = [...replacementTargets].filter(
        (target) => target.isConnected,
    );
    const replaced = (root: HTMLElement) =>
        targets.some((target) => target.contains(root));
    for (const root of containers()) {
        if (options.mode === "reset" || replaced(root))
            restore(undefined, root);
    }
    const pageRoot =
        options.mode === "targeted"
            ? document.getElementById(options.pageRoot)
            : null;
    if (options.mode === "reset" || (pageRoot && replaced(pageRoot)))
        restore(undefined);
}

export function createScrollRestoration() {
    const positions = new Map<string, Snapshot>();
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    const entry = () => {
        let key = history.state?.hypergraftScroll;
        if (typeof key !== "string") {
            key = crypto.randomUUID();
            history.replaceState(
                { ...history.state, hypergraftScroll: key },
                "",
            );
        }
        return key as string;
    };
    let current = entry();
    return {
        capture() {
            positions.delete(current);
            positions.set(current, {
                window: capture(),
                containers: new Map(
                    containers().map((root) => [root.id, capture(root)]),
                ),
            });
            if (positions.size > 50)
                positions.delete(positions.keys().next().value!);
        },
        committed() {
            current = entry();
        },
        restore() {
            current = entry();
            const snapshot = positions.get(current);
            for (const root of containers())
                restore(snapshot?.containers.get(root.id), root);
            restore(snapshot?.window);
        },
        destroy() {
            positions.clear();
            history.scrollRestoration = previous;
        },
    };
}
