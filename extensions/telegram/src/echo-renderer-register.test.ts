import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

let capturedFactory:
  | ((params: { cfg: OpenClawConfig; target: Record<string, unknown> }) => unknown)
  | undefined;

vi.mock("openclaw/plugin-sdk/channel-echo", () => ({
  registerEchoRendererFactory: (_channel: string, factory: typeof capturedFactory) => {
    capturedFactory = factory;
  },
}));
vi.mock("openclaw/plugin-sdk/reply-chunking", () => ({
  resolveTextChunkLimit: () => 4096,
}));
vi.mock("./account-throttler.js", () => ({
  getOrCreateAccountThrottler: () => () => {},
}));
const accountMock = vi.fn();
vi.mock("./accounts.js", () => ({
  resolveTelegramAccount: (...args: unknown[]) => accountMock(...args),
}));
const streamModeMock = vi.fn();
vi.mock("./bot/helpers.js", () => ({
  resolveTelegramStreamMode: (...args: unknown[]) => streamModeMock(...args),
}));
const createRendererMock = vi.fn(() => ({ options: {}, finalize: () => {}, dispose: () => {} }));
vi.mock("./echo-renderer.js", () => ({
  createTelegramEchoRenderer: (...args: unknown[]) => createRendererMock(...args),
}));
vi.mock("grammy", () => ({
  Bot: class {
    api = { config: { use: vi.fn() } };
  },
}));

import { registerTelegramEchoRenderer } from "./echo-renderer-register.js";

const cfg = {} as OpenClawConfig;

describe("registerTelegramEchoRenderer", () => {
  beforeEach(() => {
    createRendererMock.mockClear();
    accountMock.mockReset();
    streamModeMock.mockReset();
    accountMock.mockReturnValue({ accountId: "default", token: "TOKEN", config: {} });
    streamModeMock.mockReturnValue("progress");
    registerTelegramEchoRenderer();
  });

  it("registers a telegram factory that builds a renderer for a streaming account", () => {
    expect(capturedFactory).toBeTypeOf("function");
    const renderer = capturedFactory?.({
      cfg,
      target: {
        channel: "telegram",
        to: "telegram:123",
        accountId: "default",
        threadId: undefined,
      },
    });
    expect(renderer).toBeTruthy();
    const passed = createRendererMock.mock.calls[0][0] as { chatId: unknown; textLimit: number };
    // chat id normalized (prefix stripped, numeric coerced).
    expect(passed.chatId).toBe(123);
    expect(passed.textLimit).toBe(4096);
  });

  it("returns undefined (post-hoc fallback) when the account streams off", () => {
    streamModeMock.mockReturnValue("off");
    const renderer = capturedFactory?.({
      cfg,
      target: { channel: "telegram", to: "999", accountId: "default" },
    });
    expect(renderer).toBeUndefined();
    expect(createRendererMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the account has no token", () => {
    accountMock.mockReturnValue({ accountId: "default", token: "", config: {} });
    const renderer = capturedFactory?.({
      cfg,
      target: { channel: "telegram", to: "999", accountId: "default" },
    });
    expect(renderer).toBeUndefined();
  });

  it("passes a forum thread spec when the target has a threadId", () => {
    capturedFactory?.({
      cfg,
      target: { channel: "telegram", to: "555", accountId: "default", threadId: 42 },
    });
    const passed = createRendererMock.mock.calls[0][0] as {
      thread: { id: number; scope: string } | null;
    };
    expect(passed.thread).toEqual({ id: 42, scope: "forum" });
  });
});
