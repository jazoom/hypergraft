// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { MAX_RESPONSE_BYTES, MAX_STREAM_FRAMES } from "./patches";
import { readStreamFrames } from "./stream";

function response(
    chunks: Uint8Array[],
    cancel?: () => void,
    close = true,
): Response {
    return new Response(
        new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                if (close) controller.close();
            },
            cancel,
        }),
    );
}

async function collect(reply: Response): Promise<string[]> {
    const frames: string[] = [];
    for await (const frame of readStreamFrames(reply)) frames.push(frame);
    return frames;
}

test("reads frame headers and UTF-8 content across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("2\né");
    const chunks = [...bytes].map((byte) => new Uint8Array([byte]));
    await expect(collect(response(chunks))).resolves.toEqual(["é"]);
});

test("rejects an overlong frame header and cancels the body", async () => {
    const cancel = vi.fn();
    const reply = response(
        [
            new TextEncoder().encode(
                "1".repeat(String(MAX_RESPONSE_BYTES).length + 1),
            ),
        ],
        cancel,
        false,
    );
    await expect(collect(reply)).rejects.toThrow("stream");
    expect(cancel).toHaveBeenCalledOnce();
});

test("reads an eight-digit frame length within the envelope budget", async () => {
    const text = "x".repeat(10_000_000);
    const bytes = new TextEncoder().encode(`${text.length}\n${text}`);
    await expect(collect(response([bytes]))).resolves.toEqual([text]);
});

test("rejects a frame after the stream frame limit", async () => {
    const bytes = new TextEncoder().encode(
        "1\nx".repeat(MAX_STREAM_FRAMES + 1),
    );
    await expect(collect(response([bytes]))).rejects.toThrow("stream");
});

test("rejects a truncated frame", async () => {
    const reply = response([new TextEncoder().encode("2\nx")]);
    await expect(collect(reply)).rejects.toThrow("stream");
});
