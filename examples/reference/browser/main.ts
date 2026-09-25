import {
    bindNavigationRecovery,
    bindReadFeedback,
    bindTransportFeedback,
    listenForLivePatches,
    listenForLiveStateChanges,
    startHypergraft,
} from "hypergraft/browser";
import "./style.css";

const liveStatus = document.getElementById("live-status");
const uncertain = document.querySelector("[data-graft-feedback-uncertain]");
let ignoreNextPatch = true;

function uncertaintyDominates(): boolean {
    return uncertain instanceof HTMLElement && !uncertain.hidden;
}

function setLiveStatus(message: string | null): void {
    if (!(liveStatus instanceof HTMLElement)) return;
    if (message === null || uncertaintyDominates()) {
        liveStatus.hidden = true;
        liveStatus.textContent = "";
        return;
    }
    liveStatus.hidden = false;
    liveStatus.textContent = message;
}

listenForLiveStateChanges((detail) => {
    if (detail.state === "reconnecting") {
        ignoreNextPatch = true;
        setLiveStatus("Live updates are disconnected.");
        return;
    }
    if (detail.state === "stopped") {
        ignoreNextPatch = true;
        setLiveStatus("Live updates stopped.");
        return;
    }
    if (detail.state === "open") ignoreNextPatch = true;
    setLiveStatus(null);
});

listenForLivePatches(() => {
    if (ignoreNextPatch) {
        ignoreNextPatch = false;
        return;
    }
    setLiveStatus("The list updated.");
});

const bound = bindTransportFeedback(document);
const stopReadFeedback = bindReadFeedback(document);
const stopNavigationRecovery = bindNavigationRecovery(document);
const stop = startHypergraft({
    scrollRestoration: true,
    prefetch: { links: "all" },
    feedback: bound.feedback,
    enterEffects: {
        task: {
            keyframes: [{ opacity: 0.2 }, { opacity: 1 }],
            timing: { duration: 200, easing: "ease-out" },
        },
    },
});

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        stop();
        stopReadFeedback();
        stopNavigationRecovery();
        bound.destroy();
    });
}
