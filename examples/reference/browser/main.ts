import {
    bindLiveFeedback,
    bindNavigationRecovery,
    bindReadFeedback,
    bindTransportFeedback,
    startHypergraft,
} from "hypergraft/browser";
import "./style.css";

const bound = bindTransportFeedback(document);
const stopReadFeedback = bindReadFeedback(document);
const stopNavigationRecovery = bindNavigationRecovery(document);
const stopLiveFeedback = bindLiveFeedback(document);
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
        stopLiveFeedback();
        stop();
        stopReadFeedback();
        stopNavigationRecovery();
        bound.destroy();
    });
}
