import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEchoTarget, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../agent-events.js";
import {
  isStreamingEchoTargetHandled,
  launchStreamingEchoFanout,
  registerEchoRendererFactory,
  resetEchoStreamingForTest,
} from "./echo-streaming.js";

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const cfg = {} as OpenClawConfig;

function makeEntry(targets: Array<Partial<SessionEchoTarget>>): SessionEntry {
  return { echoTargets: targets } as unknown as SessionEntry;
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("launchStreamingEchoFanout", () => {
  afterEach(() => {
    resetAgentEventsForTest();
    resetEchoStreamingForTest();
  });

  it("drives a registered renderer from the origin run and finalizes on lifecycle end", async () => {
    const partials: string[] = [];
    let finalized: string | undefined;
    registerEchoRendererFactory("discord", () => ({
      options: {
        onPartialReply: (p) => {
          if (p.text) partials.push(p.text);
        },
      },
      finalize: (f) => {
        finalized = f?.text;
      },
      dispose: () => {},
    }));

    const entry = makeEntry([{ channel: "discord", to: "999", echoAssistant: true }]);
    const handle = await launchStreamingEchoFanout({
      originRunId: "run1",
      cfg,
      sessionKey: "s1",
      sessionEntry: entry,
      originChannel: "telegram",
      originTo: "123",
    });

    expect(handle.count).toBe(1);
    expect(isStreamingEchoTargetHandled("s1", { channel: "discord", to: "999" })).toBe(true);

    emitAgentEvent({ runId: "run1", stream: "assistant", data: { text: "streaming" } });
    emitAgentEvent({ runId: "run1", stream: "lifecycle", data: { phase: "end" } });
    await flush();

    expect(partials).toEqual(["streaming"]);
    expect(finalized).toBe("streaming");
    // Target stays handled AFTER finalize so the post-hoc message:sent mirror (which
    // fires after the run resolves) skips it — no duplicate final. (Regression: it used
    // to clear on resolve, letting the post-hoc double-deliver.)
    expect(isStreamingEchoTargetHandled("s1", { channel: "discord", to: "999" })).toBe(true);
  });

  it("clears the previous run's handled marks at the next launch (per-run gating)", async () => {
    registerEchoRendererFactory("discord", () => ({
      options: {},
      finalize: () => {},
      dispose: () => {},
    }));
    const streamed = makeEntry([{ channel: "discord", to: "999", echoAssistant: true }]);
    await launchStreamingEchoFanout({
      originRunId: "run1",
      cfg,
      sessionKey: "s1",
      sessionEntry: streamed,
      originChannel: "telegram",
      originTo: "123",
    });
    expect(isStreamingEchoTargetHandled("s1", { channel: "discord", to: "999" })).toBe(true);

    // Next run on the same session has NO streaming targets → its launch clears the
    // stale mark so the post-hoc mirror is free to deliver again.
    await launchStreamingEchoFanout({
      originRunId: "run2",
      cfg,
      sessionKey: "s1",
      sessionEntry: makeEntry([]),
      originChannel: "telegram",
      originTo: "123",
    });
    expect(isStreamingEchoTargetHandled("s1", { channel: "discord", to: "999" })).toBe(false);
  });

  it("skips targets whose channel has no registered factory", async () => {
    const entry = makeEntry([{ channel: "slack", to: "C1", echoAssistant: true }]);
    const handle = await launchStreamingEchoFanout({
      originRunId: "r",
      cfg,
      sessionKey: "s",
      sessionEntry: entry,
      originChannel: "telegram",
      originTo: "1",
    });
    expect(handle.count).toBe(0);
    expect(isStreamingEchoTargetHandled("s", { channel: "slack", to: "C1" })).toBe(false);
  });

  it("treats a factory returning undefined as a post-hoc fallback (not handled)", async () => {
    registerEchoRendererFactory("discord", () => undefined);
    const entry = makeEntry([{ channel: "discord", to: "9", echoAssistant: true }]);
    const handle = await launchStreamingEchoFanout({
      originRunId: "r",
      cfg,
      sessionKey: "s",
      sessionEntry: entry,
      originChannel: "telegram",
      originTo: "1",
    });
    expect(handle.count).toBe(0);
    expect(isStreamingEchoTargetHandled("s", { channel: "discord", to: "9" })).toBe(false);
  });

  it("dispose() aborts live renderers and clears handled marks", async () => {
    let disposed = false;
    registerEchoRendererFactory("discord", () => ({
      options: {},
      finalize: () => {},
      dispose: () => {
        disposed = true;
      },
    }));
    const entry = makeEntry([{ channel: "discord", to: "9", echoAssistant: true }]);
    const handle = await launchStreamingEchoFanout({
      originRunId: "r",
      cfg,
      sessionKey: "s",
      sessionEntry: entry,
      originChannel: "telegram",
      originTo: "1",
    });
    expect(isStreamingEchoTargetHandled("s", { channel: "discord", to: "9" })).toBe(true);

    await handle.dispose();
    expect(disposed).toBe(true);
    expect(isStreamingEchoTargetHandled("s", { channel: "discord", to: "9" })).toBe(false);
  });

  it("excludes the origin target itself (no self-echo)", async () => {
    registerEchoRendererFactory("telegram", () => ({
      options: {},
      finalize: () => {},
      dispose: () => {},
    }));
    const entry = makeEntry([{ channel: "telegram", to: "123", echoAssistant: true }]);
    const handle = await launchStreamingEchoFanout({
      originRunId: "r",
      cfg,
      sessionKey: "s",
      sessionEntry: entry,
      originChannel: "telegram",
      originTo: "123",
    });
    expect(handle.count).toBe(0);
  });
});
