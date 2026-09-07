import {
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

const { feedback } = bindTransportFeedback(document);
startHypergraft({ feedback });
