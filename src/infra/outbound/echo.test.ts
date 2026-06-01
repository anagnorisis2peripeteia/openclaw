import { describe, expect, it } from "vitest";
import { resolveEchoTargets, _isEchoDeliveryInProgress } from "./echo.js";
import type { SessionEntry, SessionEchoTarget } from "../../config/sessions/types.js";

function makeEntry(targets: SessionEchoTarget[]): SessionEntry {
  return { echoTargets: targets } as unknown as SessionEntry;
}

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

describe("echo re-entrancy guard", () => {
  it("guard is not set outside of delivery", () => {
    expect(_isEchoDeliveryInProgress()).toBe(false);
  });
});
