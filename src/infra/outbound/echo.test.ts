import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEchoTargets, fireEchoDeliveries, _isEchoDeliveryInProgress } from "./echo.js";
import type { SessionEntry, SessionEchoTarget } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

vi.mock("./deliver.js", () => ({
  deliverOutboundPayloadsInternal: vi.fn(() => Promise.resolve()),
}));

import { deliverOutboundPayloadsInternal as _mockDeliver } from "./deliver.js";
const mockDeliver = vi.mocked(_mockDeliver);

function makeEntry(targets: SessionEchoTarget[]): SessionEntry {
  return { echoTargets: targets } as unknown as SessionEntry;
}

const fakeCfg = {} as OpenClawConfig;

describe("resolveEchoTargets", () => {
  const target: SessionEchoTarget = {
    channel: "discord",
    to: "123",
    accountId: "bot1",
    threadId: "456",
    echoUser: true,
    echoAssistant: true,
  };

  it("returns empty when entry has no echoTargets", () => {
    expect(resolveEchoTargets(undefined, { originChannel: "telegram", originTo: "x", role: "user" })).toEqual([]);
    expect(resolveEchoTargets({} as SessionEntry, { originChannel: "telegram", originTo: "x", role: "user" })).toEqual([]);
  });

  it("excludes the origin target (self-echo prevention)", () => {
    const result = resolveEchoTargets(makeEntry([target]), {
      originChannel: "discord",
      originTo: "123",
      originAccountId: "bot1",
      originThreadId: "456",
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("includes targets that differ by channel", () => {
    const result = resolveEchoTargets(makeEntry([target]), {
      originChannel: "telegram",
      originTo: "123",
      originAccountId: "bot1",
      originThreadId: "456",
      role: "assistant",
    });
    expect(result).toEqual([target]);
  });

  it("includes targets that differ by threadId", () => {
    const result = resolveEchoTargets(makeEntry([target]), {
      originChannel: "discord",
      originTo: "123",
      originAccountId: "bot1",
      originThreadId: "789",
      role: "assistant",
    });
    expect(result).toEqual([target]);
  });

  it("matches threadId via string coercion (number vs string)", () => {
    const result = resolveEchoTargets(makeEntry([{ ...target, threadId: 456 }]), {
      originChannel: "discord",
      originTo: "123",
      originAccountId: "bot1",
      originThreadId: "456",
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("treats both-undefined threadId as same (self-match)", () => {
    const noThread = { ...target, threadId: undefined };
    const result = resolveEchoTargets(makeEntry([noThread]), {
      originChannel: "discord",
      originTo: "123",
      originAccountId: "bot1",
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("filters by echoUser=false for user role", () => {
    const noUserEcho = { ...target, echoUser: false };
    const result = resolveEchoTargets(makeEntry([noUserEcho]), {
      originChannel: "telegram",
      originTo: "999",
      role: "user",
    });
    expect(result).toEqual([]);
  });

  it("filters by echoAssistant=false for assistant role", () => {
    const noAssistantEcho = { ...target, echoAssistant: false };
    const result = resolveEchoTargets(makeEntry([noAssistantEcho]), {
      originChannel: "telegram",
      originTo: "999",
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("returns multiple non-origin targets", () => {
    const t2: SessionEchoTarget = { channel: "slack", to: "C01", echoUser: true, echoAssistant: true };
    const result = resolveEchoTargets(makeEntry([target, t2]), {
      originChannel: "telegram",
      originTo: "999",
      role: "user",
    });
    expect(result).toHaveLength(2);
  });
});

describe("fireEchoDeliveries", () => {
  afterEach(() => {
    mockDeliver.mockReset();
    mockDeliver.mockResolvedValue(undefined as never);
  });

  it("calls deliverOutboundPayloadsInternal without session or mirror (loop safety)", () => {
    const entry = makeEntry([{ channel: "discord", to: "999", echoUser: true, echoAssistant: true }]);
    fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    expect(mockDeliver).toHaveBeenCalledOnce();
    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty("session");
    expect(callArgs).not.toHaveProperty("mirror");
  });

  it("prefixes assistant echo with robot emoji", () => {
    const entry = makeEntry([{ channel: "discord", to: "999", echoUser: true, echoAssistant: true }]);
    fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    const payloads = callArgs.payloads as Array<{ text: string }>;
    expect(payloads[0].text).toMatch(/\[echo\] hello$/);
  });

  it("prefixes user echo with phone emoji and channel name", () => {
    const entry = makeEntry([{ channel: "discord", to: "999", echoUser: true, echoAssistant: true }]);
    fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "user",
      },
      [{ text: "hi there" }],
    );

    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    const payloads = callArgs.payloads as Array<{ text: string }>;
    expect(payloads[0].text).toMatch(/\[via telegram\] hi there$/);
  });

  it("skips delivery when re-entrancy guard is active", () => {
    let reentrantCallCount = 0;
    mockDeliver.mockImplementation((() => {
      fireEchoDeliveries(
        {
          cfg: fakeCfg,
          sessionKey: "agent:main",
          sessionEntry: makeEntry([{ channel: "slack", to: "C02", echoUser: true, echoAssistant: true }]),
          originChannel: "discord",
          originTo: "999",
          role: "assistant",
        },
        [{ text: "reentrant" }],
      );
      reentrantCallCount++;
      return Promise.resolve();
    }) as never);

    const entry = makeEntry([{ channel: "discord", to: "999", echoUser: true, echoAssistant: true }]);
    fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    expect(mockDeliver).toHaveBeenCalledOnce();
    expect(reentrantCallCount).toBe(1);
  });

  it("guard is not set outside of delivery", () => {
    expect(_isEchoDeliveryInProgress()).toBe(false);
  });

  it("does not deliver to targets filtered by self-exclusion", () => {
    const entry = makeEntry([{ channel: "telegram", to: "123", echoUser: true, echoAssistant: true }]);
    fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    expect(mockDeliver).not.toHaveBeenCalled();
  });
});
