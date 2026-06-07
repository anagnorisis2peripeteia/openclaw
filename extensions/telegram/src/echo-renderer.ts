import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { resolveMarkdownTableMode } from "./bot-message-dispatch.runtime.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";

const TELEGRAM_DRAFT_MAX_CHARS = 4096;

/**
 * B-full native streaming echo — the Telegram render target.
 *
 * Given a target chat, builds a live-edited draft (createTelegramDraftStream — the
 * SAME primitive the native inbound compositor uses, with the same markdown→HTML
 * render + table mode) and exposes it as a GetReplyOptions callback bundle. Driven
 * by the mirror reply resolver (echo-mirror-resolver.ts), it streams the origin
 * run's response onto the target chat as a native, live-edited message — without
 * re-running the agent and without going through the inbound dispatch pipeline
 * (so no admission, persistence, or message:sent hook → loop-safe by construction).
 *
 * This is the answer lane (response text). Reasoning/tool-progress lanes are
 * follow-ups; the resolver simply no-ops the unimplemented callbacks.
 */
export type TelegramEchoRenderer = {
  /** Hand to the mirror resolver so it drives the draft from the origin run. */
  options: GetReplyOptions;
  /** Flush the streamed draft into its final state (call when the origin run ends). */
  finalize: (final?: ReplyPayload) => Promise<void>;
  /** Abort without finalizing (origin turn aborted); stops the draft loop. */
  dispose: () => Promise<void>;
};

export function createTelegramEchoRenderer(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  thread?: TelegramThreadSpec | null;
  cfg: OpenClawConfig;
  accountId?: string;
  /** Per-account text limit (native dispatch passes this; draft caps at 4096). */
  textLimit: number;
  throttleMs?: number;
  log?: (message: string) => void;
}): TelegramEchoRenderer {
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
  });
  const renderText = (text: string) => ({
    text: renderTelegramHtmlText(text, { tableMode }),
    parseMode: "HTML" as const,
  });

  const answer = createTelegramDraftStream({
    api: params.api,
    chatId: params.chatId,
    maxChars: Math.min(params.textLimit, TELEGRAM_DRAFT_MAX_CHARS),
    thread: params.thread ?? undefined,
    renderText,
    ...(params.throttleMs ? { throttleMs: params.throttleMs } : {}),
    log: params.log,
    warn: params.log,
  });

  let deltaAccumulator = "";
  let lastText: string | undefined;
  let settled = false;

  const options: GetReplyOptions = {
    onPartialReply: (payload) => {
      // The resolver forwards cumulative `text` (embedded/CLI); fall back to
      // accumulating raw deltas for delta-only producers.
      const text =
        typeof payload.text === "string"
          ? payload.text
          : payload.delta
            ? ((deltaAccumulator += payload.delta), deltaAccumulator)
            : undefined;
      if (text === undefined) {
        return;
      }
      lastText = text;
      answer.update(text);
    },
  };

  const finalize = async (final?: ReplyPayload) => {
    if (settled) {
      return;
    }
    settled = true;
    const finalText = typeof final?.text === "string" ? final.text : lastText;
    if (finalText !== undefined && finalText !== lastText) {
      answer.update(finalText);
    }
    await answer.stop();
  };

  const dispose = async () => {
    if (settled) {
      return;
    }
    settled = true;
    await (answer.discard?.() ?? answer.stop());
  };

  return { options, finalize, dispose };
}
