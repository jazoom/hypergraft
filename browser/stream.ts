import { HypergraftError } from "./diagnostics";
import {
    MAX_RESPONSE_BYTES,
    MAX_STREAM_BYTES,
    MAX_STREAM_FRAMES,
} from "./patches";

const MAX_LENGTH_DIGITS = String(MAX_RESPONSE_BYTES).length;

/** Read length-prefixed envelopes from a stream body. */
export async function* readStreamFrames(
    response: Response,
): AsyncGenerator<string> {
    if (!response.body)
        throw new HypergraftError("protocol", "Invalid Hypergraft stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let chunk: Uint8Array = new Uint8Array(0);
    let offset = 0;
    let total = 0;
    let frames = 0;
    let cleanEnd = false;

    const pull = async (): Promise<boolean> => {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
            result = await reader.read();
        } catch (error) {
            throw new HypergraftError(
                "transport",
                `Hypergraft response stream failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (result.done) {
            cleanEnd = true;
            return false;
        }
        total += result.value.byteLength;
        if (total > MAX_STREAM_BYTES)
            throw new HypergraftError(
                "byte-limit",
                "Hypergraft response byte limit exceeded",
            );
        chunk = result.value;
        offset = 0;
        return true;
    };

    const nextByte = async (): Promise<number | undefined> => {
        while (offset === chunk.length) if (!(await pull())) return undefined;
        return chunk[offset++];
    };

    try {
        while (true) {
            const digits: number[] = [];
            while (true) {
                const byte = await nextByte();
                if (byte === undefined) {
                    if (digits.length === 0) return;
                    throw new HypergraftError(
                        "protocol",
                        "Invalid Hypergraft stream",
                    );
                }
                if (byte === 10) break;
                if (digits.length >= MAX_LENGTH_DIGITS)
                    throw new HypergraftError(
                        "protocol",
                        "Invalid Hypergraft stream",
                    );
                digits.push(byte);
            }
            const line = String.fromCharCode(...digits);
            if (!/^[1-9][0-9]{0,6}$/.test(line))
                throw new HypergraftError(
                    "protocol",
                    "Invalid Hypergraft stream",
                );
            const length = Number(line);
            if (length > MAX_RESPONSE_BYTES)
                throw new HypergraftError(
                    "byte-limit",
                    "Hypergraft response byte limit exceeded",
                );
            frames += 1;
            if (frames > MAX_STREAM_FRAMES)
                throw new HypergraftError(
                    "protocol",
                    "Invalid Hypergraft stream",
                );

            const envelopeBytes = new Uint8Array(length);
            let written = 0;
            while (written < length) {
                if (offset === chunk.length && !(await pull()))
                    throw new HypergraftError(
                        "protocol",
                        "Invalid Hypergraft stream",
                    );
                const available = Math.min(
                    length - written,
                    chunk.length - offset,
                );
                envelopeBytes.set(
                    chunk.subarray(offset, offset + available),
                    written,
                );
                offset += available;
                written += available;
            }
            try {
                yield decoder.decode(envelopeBytes);
            } catch (error) {
                throw new HypergraftError(
                    "utf-8",
                    `Invalid Hypergraft response: invalid UTF-8 (${error instanceof Error ? error.message : String(error)})`,
                );
            }
        }
    } finally {
        if (!cleanEnd)
            try {
                await reader.cancel();
            } catch {
                // Cancellation failure must not hide the protocol failure.
            }
        reader.releaseLock();
    }
}
