import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./bot-message-dispatch.runtime.js", () => ({
  resolveMarkdownTableMode: () => "off",
}));
vi.mock("./format.js", () => ({
  renderTelegramHtmlText: (text: string) => text,
}));

import { createTelegramEchoRenderer } from "./echo-renderer.js";

function fakeApi() {
  const sendMessage = vi.fn(async () => ({ message_id: 100 }));
  const editMessageText = vi.fn(async () => true);
  const deleteMessage = vi.fn(async () => true);
  return { sendMessage, editMessageText, deleteMessage } as unknown as Parameters<
    typeof createTelegramEchoRenderer
  >[0]["api"] & {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
    deleteMessage: ReturnType<typeof vi.fn>;
  };
}

const cfg = {} as OpenClawConfig;

describe("createTelegramEchoRenderer", () => {
  it("streams the response onto the target chat and finalizes the draft", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({
      api,
      chatId: 999,
      cfg,
      textLimit: 4096,
      throttleMs: 250,
    });

    await r.options.onPartialReply?.({ text: "Hello" });
    await r.finalize({ text: "Hello world" });

    expect(api.sendMessage).toHaveBeenCalled();
    // First send targets the echo chat.
    expect(api.sendMessage.mock.calls[0][0]).toBe(999);
    const rendered = [
      ...api.sendMessage.mock.calls.map((c) => c[1]),
      ...api.editMessageText.mock.calls.map((c) => c[2]),
    ].join("|");
    expect(rendered).toContain("Hello world");
  });

  it("accumulates delta-only payloads", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({ api, chatId: 7, cfg, textLimit: 4096, throttleMs: 250 });

    await r.options.onPartialReply?.({ delta: "foo" });
    await r.options.onPartialReply?.({ delta: "bar" });
    await r.finalize();

    const rendered = [
      ...api.sendMessage.mock.calls.map((c) => c[1]),
      ...api.editMessageText.mock.calls.map((c) => c[2]),
    ].join("|");
    expect(rendered).toContain("foobar");
  });

  it("dispose() stops without sending a late final", async () => {
    const api = fakeApi();
    const r = createTelegramEchoRenderer({ api, chatId: 1, cfg, textLimit: 4096, throttleMs: 250 });

    await r.dispose();
    await r.finalize({ text: "late" }); // no-op after dispose

    const sent = api.sendMessage.mock.calls.map((c) => c[1]).join("|");
    expect(sent).not.toContain("late");
  });
});
