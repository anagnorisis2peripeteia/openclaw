import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEchoTargets, fireEchoDeliveries } from "./echo.js";
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

  it("never passes session or mirror to deliver (loop-safety contract)", () => {
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
    expect(callArgs).toHaveProperty("bestEffort", true);
    expect(callArgs).toHaveProperty("silent", true);
  });

  it("prefixes assistant echo payload with [echo]", () => {
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

  it("prefixes user echo payload with [via <channel>]", () => {
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

  it("preserves non-text payloads without prefix", () => {
    const entry = makeEntry([{ channel: "discord", to: "999", echoUser: true, echoAssistant: true }]);
    const mediaPayload = { media: "image.png" } as unknown as ReplyPayload;
    fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "123",
        role: "assistant",
      },
      [mediaPayload],
    );

    const callArgs = mockDeliver.mock.calls[0][0] as Record<string, unknown>;
    const payloads = callArgs.payloads as Array<Record<string, unknown>>;
    expect(payloads[0]).toEqual(mediaPayload);
  });

  it("delivers to each resolved target independently", () => {
    const entry = makeEntry([
      { channel: "discord", to: "111", echoUser: true, echoAssistant: true },
      { channel: "slack", to: "222", echoUser: true, echoAssistant: true },
    ]);
    fireEchoDeliveries(
      {
        cfg: fakeCfg,
        sessionKey: "agent:main",
        sessionEntry: entry,
        originChannel: "telegram",
        originTo: "999",
        role: "assistant",
      },
      [{ text: "hello" }],
    );

    expect(mockDeliver).toHaveBeenCalledTimes(2);
    const channels = mockDeliver.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).channel,
    );
    expect(channels).toContain("discord");
    expect(channels).toContain("slack");
  });

  it("does not deliver when all targets are self-excluded", () => {
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

  it("does not deliver when entry has no echo targets", () => {
    const entry = makeEntry([]);
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

// Type import for the non-text payload test
import type { ReplyPayload } from "../../auto-reply/types.js";
