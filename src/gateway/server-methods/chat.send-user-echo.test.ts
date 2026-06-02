import { beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the echo delivery side-effect. The user-message echo must only fire
// once a chat.send turn is *accepted* for dispatch (attachments staged, abort
// controller registered, run added, ack sent) — never on a pre-acceptance
// rejection path, which would leak rejected input to pinned echo targets.
vi.mock("../../infra/outbound/echo.js", () => ({
  fireEchoDeliveries: vi.fn(),
}));

// Force the loaded session entry to carry an echo target so the echo guard
// (`userEchoEntry?.echoTargets?.length`) is satisfied. We keep every other
// session-utils export real so the handler's pre-acceptance resolution
// (model ref, deleted-agent guard, store key) behaves normally.
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: vi.fn((rawSessionKey: string, options?: unknown) => {
      const loaded = actual.loadSessionEntry(rawSessionKey, options as never);
      return {
        ...loaded,
        entry: {
          ...loaded.entry,
          sessionId: loaded.entry?.sessionId ?? "session-user-echo",
          echoTargets: [
            {
              channel: "discord",
              to: "999",
              accountId: "bot1",
              threadId: "456",
              echoUser: true,
              echoAssistant: true,
              addedAt: 1700000000000,
            },
          ],
        },
      };
    }),
  };
});

// Keep the fire-and-forget dispatch chain quiet/deterministic. The user echo
// fires synchronously *before* this runs, so its result is irrelevant to the
// assertions; we stub it only to avoid noisy async rejections during the test.
vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn(() => Promise.resolve({ beforeAgentRunBlocked: false })),
}));

import { dispatchInboundMessage as _mockDispatch } from "../../auto-reply/dispatch.js";
import { fireEchoDeliveries as _mockFireEcho } from "../../infra/outbound/echo.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

const mockFireEcho = vi.mocked(_mockFireEcho);
const mockDispatch = vi.mocked(_mockDispatch);

function createMockContext() {
  return {
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    chatAbortControllers: new Map(),
    agentRunSeq: new Map<string, number>(),
    dedupe: new Map(),
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    logGateway: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    registerToolEventRecipient: vi.fn(),
    loadGatewayModelCatalog: vi.fn(() => Promise.resolve(undefined)),
  };
}

async function runChatSend(ctx: ReturnType<typeof createMockContext>, idempotencyKey: string) {
  await chatHandlers["chat.send"]({
    params: {
      sessionKey: "main",
      message: "hello echo",
      idempotencyKey,
    },
    respond: vi.fn() as never,
    context: ctx as unknown as GatewayRequestContext,
    req: {} as never,
    client: null as never,
    isWebchatConnect: () => false,
  });
}

describe("chat.send user-message echo placement", () => {
  beforeEach(() => {
    mockFireEcho.mockReset();
    mockDispatch.mockReset();
    mockDispatch.mockResolvedValue({ beforeAgentRunBlocked: false } as never);
  });

  it("does NOT echo the user message when the turn is rejected before accepted dispatch", async () => {
    const ctx = createMockContext();
    // addChatRun runs on the accepted-dispatch path *before* the user echo
    // (echo now fires right after the accept ack). A throw here aborts the
    // turn before acceptance, so the raw input must never be mirrored.
    ctx.addChatRun.mockImplementation(() => {
      throw Object.assign(new Error("registry boom"), { code: "REGISTRY" });
    });

    await runChatSend(ctx, "run-reject-1");

    expect(ctx.addChatRun).toHaveBeenCalled();
    expect(mockFireEcho).not.toHaveBeenCalled();
  });

  it("echoes the user message exactly once for an accepted turn", async () => {
    const ctx = createMockContext();

    await runChatSend(ctx, "run-accept-1");

    expect(mockFireEcho).toHaveBeenCalledTimes(1);
    const [opts, payloads] = mockFireEcho.mock.calls[0];
    expect(opts).toMatchObject({ role: "user", originChannel: "webchat" });
    // canonical session key resolved by loadSessionEntry (legacy "main" -> agent-scoped)
    expect((opts as { sessionKey: string }).sessionKey).toBe("agent:main:main");
    expect(payloads).toEqual([{ text: "hello echo" }]);
  });
});
