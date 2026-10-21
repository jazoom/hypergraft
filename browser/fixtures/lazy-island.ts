import type { IslandInitialiser } from "../islands";

export const initialise: IslandInitialiser = (root, { signal }) => {
    const button = root.querySelector<HTMLButtonElement>("button")!;
    button.addEventListener(
        "click",
        () => {
            root.dataset.clicks = String(Number(root.dataset.clicks ?? 0) + 1);
        },
        { signal },
    );
    return () => {
        root.dataset.cleaned = String(signal.aborted);
    };
};
