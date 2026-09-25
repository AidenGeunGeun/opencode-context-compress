import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

test("a fork inherits ordered compression blocks with remapped message IDs", async () => {
    const previous = process.env.XDG_DATA_HOME
    const storage = await mkdtemp(join(tmpdir(), "opencode-fork-compress-"))
    process.env.XDG_DATA_HOME = storage
    try {
        const { createSessionState } = await import("../lib/state/state.ts")
        const { saveSessionState, loadSessionState } = await import("../lib/state/persistence.ts")
        const { inheritForkCompression } = await import("../lib/state/fork.ts")
        const { pluginClient } = await import("../lib/sdk/client.ts")
        const { orderCompressBlocks } = await import("../lib/messages/blocks.ts")
        const { transformMessagesForSearch } = await import("../lib/messages/compress-transform.ts")
        const logger = { info() {}, warn() {}, error() {}, debug() {} } as any
        const message = (id: string, sessionID: string, index: number) => ({
            info: { id, sessionID, role: index % 2 ? "assistant" : "user", sourceType: index % 2 ? "assistant" : "user", time: { created: index + 1, ...(index % 2 ? { completed: index + 1 } : {}) } },
            parts: index === 1
                ? [{ type: "tool", callID: "tool-1", tool: "read", state: { status: "completed", input: {}, output: "ok" } }]
                : [{ type: "text", text: `content-${index}` }],
        })
        const parent = Array.from({ length: 5 }, (_, index) => message(`parent-${index}`, "parent", index))
        const child = [
            ...parent.map((item, index) => ({ ...item, info: { ...item.info, id: `child-${index}`, sessionID: "child" } })),
            message("child-question", "child", 5),
        ]
        const parentState = createSessionState()
        parentState.sessionId = "parent"
        parentState.compressed.messageIds = new Set(["parent-0", "parent-1", "parent-2", "parent-3"])
        parentState.compressed.toolIds.add("tool-1")
        parentState.compressSummaries = [
            { anchorMessageId: "parent-0", messageIds: ["parent-0", "parent-1"], summary: "first" },
            { anchorMessageId: "parent-2", messageIds: ["parent-2", "parent-3"], summary: "second" },
        ]
        assert.equal(await saveSessionState(parentState, logger), true)

        const session = {
            get: async () => ({ fork: { sessionID: "parent", boundary: { type: "through", messageID: "parent-4" } } }),
            context: async ({ sessionID }: { sessionID: string }) => sessionID === "parent" ? parent : child,
        } as any
        const childState = createSessionState()
        childState.sessionId = "child"
        await inheritForkCompression(session, pluginClient(session), childState, logger, child as any)

        const loaded = await loadSessionState("child", logger, child as any)
        assert.equal(loaded.status, "loaded")
        if (loaded.status !== "loaded") return
        assert.deepEqual(loaded.state.compressed.messageIds, ["child-0", "child-1", "child-2", "child-3"])
        assert.deepEqual(loaded.state.compressed.toolIds, ["tool-1"])
        assert.deepEqual(
            orderCompressBlocks(child as any, loaded.state.compressSummaries).map((block) => [block.label, block.summary.anchorMessageId]),
            [["b0", "child-0"], ["b1", "child-2"]],
        )
        childState.compressed.messageIds = new Set(loaded.state.compressed.messageIds)
        childState.compressed.toolIds = new Set(loaded.state.compressed.toolIds)
        childState.compressSummaries = loaded.state.compressSummaries
        const context = transformMessagesForSearch(child as any, childState, logger).transformed
        assert.deepEqual(
            context.map((item) => item.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("")),
            [
                "[Compressed conversation block]\n\n[b0]\n\nfirst",
                "[Compressed conversation block]\n\n[b1]\n\nsecond",
                "content-4",
                "content-5",
            ],
        )
        assert.deepEqual(parentState.compressSummaries.map((block) => block.anchorMessageId), ["parent-0", "parent-2"])

        parentState.managementTurns = [{ triggerMessageId: "parent-2", completedMessageId: "parent-4" }]
        assert.equal(await saveSessionState(parentState, logger), true)
        const partialChild = [
            ...parent.slice(0, 3).map((item, index) => ({
                ...item,
                info: { ...item.info, id: "partial-" + index, sessionID: "partial-child" },
            })),
            message("partial-question", "partial-child", 3),
        ]
        const partialSession = {
            get: async () => ({ fork: { sessionID: "parent", boundary: { type: "before", messageID: "parent-3" } } }),
            context: async ({ sessionID }: { sessionID: string }) => sessionID === "parent" ? parent : partialChild,
        } as any
        const partialState = createSessionState()
        partialState.sessionId = "partial-child"
        await inheritForkCompression(partialSession, pluginClient(partialSession), partialState, logger, partialChild as any)
        const partial = await loadSessionState("partial-child", logger, partialChild as any)
        assert.equal(partial.status, "loaded")
        if (partial.status === "loaded") {
            assert.deepEqual(partial.state.compressSummaries.map((block) => block.anchorMessageId), ["partial-0"])
            assert.deepEqual(partial.state.compressed.messageIds, ["partial-0", "partial-1"])
            assert.deepEqual(partial.state.compressed.toolIds, ["tool-1"])
            assert.deepEqual(partial.state.managementTurns, [])
            partialState.compressed.messageIds = new Set(partial.state.compressed.messageIds)
            partialState.compressed.toolIds = new Set(partial.state.compressed.toolIds)
            partialState.compressSummaries = partial.state.compressSummaries
            assert.deepEqual(
                transformMessagesForSearch(partialChild as any, partialState, logger).transformed.map((item) =>
                    item.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
                ),
                ["[Compressed conversation block]\n\n[b0]\n\nfirst", "content-2", "content-3"],
            )
        }

        const active = {
            ...message("parent-active", "parent", 5),
            info: {
                ...message("parent-active", "parent", 5).info,
                time: { created: 6 },
            },
        }
        parent.push(active as any)
        const runningChild = child.map((item) => ({
            ...item,
            info: { ...item.info, sessionID: "running-child" },
        }))
        const runningSession = {
            get: async () => ({ fork: { sessionID: "parent", boundary: { type: "through", messageID: "parent-active" } } }),
            context: async ({ sessionID }: { sessionID: string }) => sessionID === "parent" ? parent : runningChild,
        } as any
        const runningState = createSessionState()
        runningState.sessionId = "running-child"
        await inheritForkCompression(runningSession, pluginClient(runningSession), runningState, logger, runningChild as any)
        const inherited = await loadSessionState("running-child", logger, runningChild as any)
        assert.equal(inherited.status, "loaded")
        if (inherited.status === "loaded") assert.equal(inherited.state.compressSummaries.length, 2)
    } finally {
        if (previous === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previous
        await rm(storage, { recursive: true, force: true })
    }
})
