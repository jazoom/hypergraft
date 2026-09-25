import { HypergraftError } from "./diagnostics";
import { MAX_RESPONSE_BYTES } from "./patches";

export async function readBoundedResponse(
    response: Response,
    options: { maxBytes?: () => number; signal?: AbortSignal } = {},
): Promise<string> {
    const limit = () => options.maxBytes?.() ?? MAX_RESPONSE_BYTES;
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > limit()) {
        await response.body?.cancel().catch(() => undefined);
        throw new HypergraftError(
            "byte-limit",
            "Hypergraft response byte limit exceeded",
        );
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const cancel = () => {
        void reader.cancel().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    let bytes = 0;
    let text = "";
    try {
        while (true) {
            options.signal?.throwIfAborted();
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch (error) {
                throw new HypergraftError(
                    "transport",
                    `Hypergraft response stream failed: ${String(error)}`,
                );
            }
            options.signal?.throwIfAborted();
            const { done, value } = chunk;
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit()) {
                cancel();
                throw new HypergraftError(
                    "byte-limit",
                    "Hypergraft response byte limit exceeded",
                );
            }
            try {
                text += decoder.decode(value, { stream: true });
            } catch (error) {
                cancel();
                throw new HypergraftError(
                    "utf-8",
                    `Invalid Hypergraft response: invalid UTF-8 (${String(error)})`,
                );
            }
        }
        try {
            return text + decoder.decode();
        } catch (error) {
            throw new HypergraftError(
                "utf-8",
                `Invalid Hypergraft response: invalid UTF-8 (${String(error)})`,
            );
        }
    } finally {
        options.signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
    }
}
