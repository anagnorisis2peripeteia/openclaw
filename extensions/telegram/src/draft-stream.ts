import type { Bot } from "grammy";
import {
  clearFinalizableDraftMessage,
  createFinalizableDraftStreamControlsForState,
} from "openclaw/plugin-sdk/channel-lifecycle";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import {
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
} from "./network-errors.js";
import { normalizeTelegramReplyToMessageId } from "./outbound-params.js";

const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1000;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const CHAT_SEND_INTERVAL_MS = 3000;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const DRAFT_METHOD_UNAVAILABLE_RE =
  /(unknown method|method .*not (found|available|supported)|unsupported)/i;
const DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only)/i;

// Adaptive throttle: shared across bundled chunks so 429 backoff is respected globally.
interface AdaptiveThrottleState {
  currentMs: number;
  minMs: number;
  maxMs: number;
  pausedUntil: number;
  decayInterval: ReturnType<typeof setInterval> | null;
}
const ADAPTIVE_THROTTLE_KEY = Symbol.for("openclaw.adaptiveThrottle");
const _adaptiveThrottleState: AdaptiveThrottleState =
  (globalThis as Record<PropertyKey, unknown>)[ADAPTIVE_THROTTLE_KEY] as AdaptiveThrottleState ?? {
    currentMs: 1000,
    minMs: 1000,
    maxMs: 120000,
    pausedUntil: 0,
    decayInterval: null,
  };
(globalThis as Record<PropertyKey, unknown>)[ADAPTIVE_THROTTLE_KEY] = _adaptiveThrottleState;

// Per-chat send gate: enforces a minimum interval between sends to the same chat,
// with fair rotation across concurrent streams.
interface GateStreamInfo {
  lastSent: number;
  lastAttempt: number;
  wantsSend: boolean;
}
interface ChatGate {
  lastSentAt: number;
  streams: Map<number, GateStreamInfo>;
}
const PER_CHAT_GATE_KEY = Symbol.for("openclaw.perChatSendGate");
const _perChatSendGate: Map<string | number, ChatGate> =
  (globalThis as Record<PropertyKey, unknown>)[PER_CHAT_GATE_KEY] as Map<string | number, ChatGate> ??
  new Map<string | number, ChatGate>();
(globalThis as Record<PropertyKey, unknown>)[PER_CHAT_GATE_KEY] = _perChatSendGate;

const GATE_STREAM_COUNTER_KEY = Symbol.for("openclaw.gateStreamIdCounter");
let _gateStreamIdCounter: number =
  ((globalThis as Record<PropertyKey, unknown>)[GATE_STREAM_COUNTER_KEY] as number) ?? 0;

function releaseGateSlot(chatId: string | number, streamId: number): void {
  const gate = _perChatSendGate.get(chatId);
  if (!gate) return;
  let mostRecentOther = 0;
  for (const [id, s] of gate.streams) {
    if (id !== streamId && s.lastSent > mostRecentOther) mostRecentOther = s.lastSent;
  }
  gate.lastSentAt = mostRecentOther;
}

function acquireChatSendGate(
  chatId: string | number,
  streamId: number,
  isFinal: boolean,
): boolean {
  let gate = _perChatSendGate.get(chatId);
  if (!gate) {
    gate = { lastSentAt: 0, streams: new Map() };
    _perChatSendGate.set(chatId, gate);
  }
  const now = Date.now();
  const elapsed = now - gate.lastSentAt;
  let info = gate.streams.get(streamId);
  if (!info) {
    info = { lastSent: 0, lastAttempt: 0, wantsSend: false };
    gate.streams.set(streamId, info);
  }
  info.wantsSend = true;
  info.lastAttempt = now;
  if (elapsed < CHAT_SEND_INTERVAL_MS) return false;
  for (const [, s] of gate.streams) {
    if (now - s.lastAttempt > CHAT_SEND_INTERVAL_MS * 2) s.wantsSend = false;
  }
  let pickId: number | null = null;
  let oldestSent = Infinity;
  for (const [id, s] of gate.streams) {
    if (!s.wantsSend) continue;
    if (s.lastSent < oldestSent) {
      oldestSent = s.lastSent;
      pickId = id;
    }
  }
  if (pickId !== null && pickId !== streamId) return false;
  info.lastSent = now;
  info.wantsSend = false;
  gate.lastSentAt = now;
  if (isFinal) gate.streams.delete(streamId);
  return true;
}

function getAdaptiveThrottleMs(baseMs: number): number {
  return Math.max(baseMs, _adaptiveThrottleState.currentMs);
}

function is429Error(err: unknown): boolean {
  const s = String(err);
  return /429|too many requests/i.test(s);
}

function onTelegramRateLimit(retryAfterSec: number): void {
  const backoffMs = retryAfterSec * 1000 + 500;
  _adaptiveThrottleState.pausedUntil = Date.now() + backoffMs;
  _adaptiveThrottleState.currentMs = Math.min(
    _adaptiveThrottleState.maxMs,
    Math.max(_adaptiveThrottleState.currentMs, backoffMs),
  );
  if (!_adaptiveThrottleState.decayInterval) {
    _adaptiveThrottleState.decayInterval = setInterval(() => {
      _adaptiveThrottleState.currentMs = Math.max(
        _adaptiveThrottleState.minMs,
        Math.floor(_adaptiveThrottleState.currentMs / 2),
      );
      if (_adaptiveThrottleState.currentMs <= _adaptiveThrottleState.minMs) {
        if (_adaptiveThrottleState.decayInterval) {
          clearInterval(_adaptiveThrottleState.decayInterval);
          _adaptiveThrottleState.decayInterval = null;
        }
      }
    }, 10000);
  }
}

type TelegramSendMessageDraft = (
  chatId: Parameters<Bot["api"]["sendMessage"]>[0],
  draftId: number,
  text: string,
  params?: {
    message_thread_id?: number;
    parse_mode?: "HTML";
  },
) => Promise<unknown>;

type TelegramSendMessageParams = Parameters<Bot["api"]["sendMessage"]>[2];

function hasNumericMessageThreadId(
  params: TelegramSendMessageParams | undefined,
): params is TelegramSendMessageParams & { message_thread_id: number } {
  return (
    typeof params === "object" &&
    params !== null &&
    typeof (params as { message_thread_id?: unknown }).message_thread_id === "number"
  );
}

/**
 * Keep draft-id allocation shared across bundled chunks so concurrent preview
 * lanes do not accidentally reuse draft ids when code-split entries coexist.
 */
const TELEGRAM_DRAFT_STREAM_STATE_KEY = Symbol.for("openclaw.telegramDraftStreamState");
let draftStreamState: { nextDraftId: number } | undefined;

function getDraftStreamState(): { nextDraftId: number } {
  if (!draftStreamState) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    draftStreamState = (globalStore[TELEGRAM_DRAFT_STREAM_STATE_KEY] as
      | { nextDraftId: number }
      | undefined) ?? {
      nextDraftId: 0,
    };
    globalStore[TELEGRAM_DRAFT_STREAM_STATE_KEY] = draftStreamState;
  }
  return draftStreamState;
}

function allocateTelegramDraftId(): number {
  const state = getDraftStreamState();
  state.nextDraftId = state.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : state.nextDraftId + 1;
  return state.nextDraftId;
}

function resolveSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

function shouldFallbackFromDraftTransport(err: unknown): boolean {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof err === "object" && err && "description" in err
          ? typeof err.description === "string"
            ? err.description
            : ""
          : "";
  if (!/sendMessageDraft/i.test(text)) {
    return false;
  }
  return DRAFT_METHOD_UNAVAILABLE_RE.test(text) || DRAFT_CHAT_UNSUPPORTED_RE.test(text);
}

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => number | undefined;
  previewMode?: () => "message" | "draft";
  previewRevision?: () => number;
  lastDeliveredText?: () => string;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Stop without a final flush or delete. */
  discard?: () => Promise<void>;
  /** Convert the current draft preview into a permanent message (sendMessage). */
  materialize?: () => Promise<number | undefined>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
  /** True when a preview sendMessage was attempted but the response was lost. */
  sendMayHaveLanded?: () => boolean;
};

type TelegramDraftPreview = {
  text: string;
  parseMode?: "HTML";
};

type SupersededTelegramPreview = {
  messageId: number;
  textSnapshot: string;
  parseMode?: "HTML";
};

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  maxChars?: number;
  thread?: TelegramThreadSpec | null;
  previewTransport?: "auto" | "message" | "draft";
  replyToMessageId?: number;
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  /** Skip minInitialChars (used for reasoning lane). */
  skipMinInitialChars?: boolean;
  /** Optional gate check before acquiring the per-chat send gate. */
  beforeGate?: () => boolean;
  /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
  renderText?: (text: string) => TelegramDraftPreview;
  /** Called when a late send resolves after forceNewMessage() switched generations. */
  onSupersededPreview?: (preview: SupersededTelegramPreview) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS,
    TELEGRAM_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.skipMinInitialChars ? null : params.minInitialChars;
  const chatId = params.chatId;
  const _streamId = ++_gateStreamIdCounter;
  (globalThis as Record<PropertyKey, unknown>)[GATE_STREAM_COUNTER_KEY] = _gateStreamIdCounter;
  const requestedPreviewTransport = params.previewTransport ?? "auto";
  const prefersDraftTransport =
    requestedPreviewTransport === "draft"
      ? true
      : requestedPreviewTransport === "message"
        ? false
        : params.thread?.scope === "dm";
  const threadParams = buildTelegramThreadParams(params.thread);
  const replyToMessageId = normalizeTelegramReplyToMessageId(params.replyToMessageId);
  const replyParams =
    replyToMessageId != null
      ? {
          ...threadParams,
          reply_to_message_id: replyToMessageId,
          allow_sending_without_reply: true,
        }
      : threadParams;
  const resolvedDraftApi = prefersDraftTransport
    ? resolveSendMessageDraftApi(params.api)
    : undefined;
  const usesDraftTransport = Boolean(prefersDraftTransport && resolvedDraftApi);
  if (prefersDraftTransport && !usesDraftTransport) {
    params.warn?.(
      "telegram stream preview: sendMessageDraft unavailable; falling back to sendMessage/editMessageText",
    );
  }

  const streamState = { stopped: false, final: false };
  let messageSendAttempted = false;
  let sendFailureCount = 0;
  let rateLimitedUntilMs = 0;
  let pendingForceNewMessage = false;
  let streamMessageId: number | undefined;
  let streamDraftId = usesDraftTransport ? allocateTelegramDraftId() : undefined;
  let previewTransport: "message" | "draft" = usesDraftTransport ? "draft" : "message";
  let lastSentText = "";
  let lastDeliveredText = "";
  let lastSentParseMode: "HTML" | undefined;
  let previewRevision = 0;
  let generation = 0;
  let textBaseOffset = 0;
  type PreviewSendParams = {
    renderedText: string;
    renderedParseMode: "HTML" | undefined;
    sendGeneration: number;
  };
  const sendRenderedMessageWithThreadFallback = async (sendArgs: {
    renderedText: string;
    renderedParseMode: "HTML" | undefined;
    fallbackWarnMessage: string;
  }) => {
    const sendParams = sendArgs.renderedParseMode
      ? {
          ...replyParams,
          parse_mode: sendArgs.renderedParseMode,
        }
      : replyParams;
    const usedThreadParams = hasNumericMessageThreadId(sendParams);
    try {
      return {
        sent: await params.api.sendMessage(chatId, sendArgs.renderedText, sendParams),
        usedThreadParams,
      };
    } catch (err) {
      if (!usedThreadParams || !THREAD_NOT_FOUND_RE.test(String(err))) {
        throw err;
      }
      const threadlessParams: TelegramSendMessageParams = { ...sendParams };
      delete threadlessParams.message_thread_id;
      params.warn?.(sendArgs.fallbackWarnMessage);
      return {
        sent: await params.api.sendMessage(
          chatId,
          sendArgs.renderedText,
          Object.keys(threadlessParams).length > 0 ? threadlessParams : undefined,
        ),
        usedThreadParams: false,
      };
    }
  };
  const sendMessageTransportPreview = async ({
    renderedText,
    renderedParseMode,
    sendGeneration,
  }: PreviewSendParams): Promise<boolean> => {
    if (typeof streamMessageId === "number") {
      if (renderedParseMode) {
        await params.api.editMessageText(chatId, streamMessageId, renderedText, {
          parse_mode: renderedParseMode,
        });
      } else {
        await params.api.editMessageText(chatId, streamMessageId, renderedText);
      }
      return true;
    }
    messageSendAttempted = true;
    let sent: Awaited<ReturnType<typeof sendRenderedMessageWithThreadFallback>>["sent"];
    try {
      ({ sent } = await sendRenderedMessageWithThreadFallback({
        renderedText,
        renderedParseMode,
        fallbackWarnMessage:
          "telegram stream preview send failed with message_thread_id, retrying without thread",
      }));
    } catch (err) {
      if (isSafeToRetrySendError(err) || isTelegramClientRejection(err)) {
        messageSendAttempted = false;
      }
      throw err;
    }
    const sentMessageId = sent?.message_id;
    if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
      sendFailureCount++;
      releaseGateSlot(chatId, _streamId);
      if (sendFailureCount >= 3) {
        streamState.stopped = true;
        params.api
          .sendMessage(
            chatId,
            "⚠️ Stream delivery failed — message_id missing after 3 attempts",
            threadParams ?? {},
          )
          .catch(() => {});
        params.warn?.(
          "telegram stream preview stopped after retry limit (3 attempts, no message_id)",
        );
        return false;
      }
      params.warn?.(
        `telegram stream preview: missing message_id (attempt ${sendFailureCount}/3), will retry`,
      );
      messageSendAttempted = false;
      resetStreamToNewMessage();
      return false;
    }
    const normalizedMessageId = Math.trunc(sentMessageId);
    if (sendGeneration !== generation) {
      params.onSupersededPreview?.({
        messageId: normalizedMessageId,
        textSnapshot: renderedText,
        parseMode: renderedParseMode,
      });
      return true;
    }
    streamMessageId = normalizedMessageId;
    return true;
  };
  const sendDraftTransportPreview = async ({
    renderedText,
    renderedParseMode,
  }: PreviewSendParams): Promise<boolean> => {
    const draftId = streamDraftId ?? allocateTelegramDraftId();
    streamDraftId = draftId;
    const draftParams = {
      ...(threadParams?.message_thread_id != null
        ? { message_thread_id: threadParams.message_thread_id }
        : {}),
      ...(renderedParseMode ? { parse_mode: renderedParseMode } : {}),
    };
    await resolvedDraftApi!(
      chatId,
      draftId,
      renderedText,
      Object.keys(draftParams).length > 0 ? draftParams : undefined,
    );
    return true;
  };

  const resetStreamToNewMessage = () => {
    streamState.stopped = false;
    streamState.final = false;
    generation += 1;
    messageSendAttempted = false;
    streamMessageId = undefined;
    if (previewTransport === "draft") {
      streamDraftId = allocateTelegramDraftId();
    }
    lastSentText = "";
    lastSentParseMode = undefined;
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    // Rate limit backoff: skip sends until backoff expires
    if (rateLimitedUntilMs > 0) {
      const remaining = rateLimitedUntilMs - Date.now();
      if (remaining > 0) {
        return false;
      }
      rateLimitedUntilMs = 0;
      if (pendingForceNewMessage) {
        pendingForceNewMessage = false;
        textBaseOffset = 0;
        resetStreamToNewMessage();
      }
    }
    if (params.beforeGate && !params.beforeGate()) return false;
    if (!acquireChatSendGate(chatId, _streamId, streamState.final)) return false;
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    // Auto-reset offset when fresh content arrives (shorter than offset = new step)
    if (textBaseOffset > 0 && trimmed.length <= textBaseOffset) {
      textBaseOffset = 0;
    }
    const sliced = textBaseOffset > 0 ? trimmed.slice(textBaseOffset).trimStart() : trimmed;
    if (!sliced) {
      return false;
    }
    const rendered = params.renderText?.(sliced) ?? { text: sliced };
    const renderedText = rendered.text.trimEnd();
    const renderedParseMode = rendered.parseMode;
    if (!renderedText) {
      return false;
    }
    if (renderedText.length > maxChars) {
      const deliveredRaw = lastDeliveredText.length || 0;
      const deliveredLen =
        deliveredRaw > textBaseOffset ? deliveredRaw - textBaseOffset : lastSentText.length;
      if (deliveredLen > 0) {
        textBaseOffset += deliveredLen;
      } else {
        const fallbackOffset =
          trimmed.length > maxChars
            ? Math.max(textBaseOffset, trimmed.length - Math.floor(maxChars * 0.8))
            : textBaseOffset;
        textBaseOffset = fallbackOffset;
        params.warn?.(
          `telegram stream preview overflow with no delivery state (post-429?); forcing new message from offset=${textBaseOffset}`,
        );
      }
      resetStreamToNewMessage();
      lastDeliveredText = "";
      params.log?.(
        `telegram stream preview overflow (${renderedText.length} > ${maxChars}); chaining to new message (offset=${textBaseOffset})`,
      );
      const overflowSlice = trimmed.slice(textBaseOffset).trimStart();
      if (overflowSlice) {
        const overflowRendered = params.renderText?.(overflowSlice) ?? { text: overflowSlice };
        if (overflowRendered.text.trimEnd().length <= maxChars) {
          return sendOrEditStreamMessage(trimmed);
        }
      }
      return true;
    }
    if (renderedText === lastSentText && renderedParseMode === lastSentParseMode) {
      return true;
    }
    const sendGeneration = generation;

    if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
      if (renderedText.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = renderedText;
    lastSentParseMode = renderedParseMode;
    try {
      let sent = false;
      if (previewTransport === "draft") {
        try {
          sent = await sendDraftTransportPreview({
            renderedText,
            renderedParseMode,
            sendGeneration,
          });
        } catch (err) {
          if (!shouldFallbackFromDraftTransport(err)) {
            throw err;
          }
          previewTransport = "message";
          streamDraftId = undefined;
          params.warn?.(
            "telegram stream preview: sendMessageDraft rejected by API; falling back to sendMessage/editMessageText",
          );
          sent = await sendMessageTransportPreview({
            renderedText,
            renderedParseMode,
            sendGeneration,
          });
        }
      } else {
        sent = await sendMessageTransportPreview({
          renderedText,
          renderedParseMode,
          sendGeneration,
        });
      }
      if (sent) {
        previewRevision += 1;
        lastDeliveredText = trimmed;
      }
      return sent;
    } catch (err) {
      if (is429Error(err)) {
        const retryMatch = String(err).match(/retry after (\d+)/i);
        const retryAfterSec = retryMatch ? parseInt(retryMatch[1], 10) : 5;
        const backoffMs = retryAfterSec * 1000 + 500;
        rateLimitedUntilMs = Date.now() + backoffMs;
        lastSentText = "";
        lastSentParseMode = undefined;
        onTelegramRateLimit(retryAfterSec);
        params.warn?.(
          `telegram stream preview rate limited; backing off ${retryAfterSec}s (until ${new Date(rateLimitedUntilMs).toISOString()})`,
        );
        return false;
      }
      if (isRecoverableTelegramNetworkError(err, { allowMessageMatch: true })) {
        lastSentText = "";
        lastSentParseMode = undefined;
        if (typeof streamMessageId !== "number") {
          messageSendAttempted = false;
          resetStreamToNewMessage();
        }
        params.warn?.(
          `telegram stream preview transient network error (will retry${typeof streamMessageId === "number" ? " edit" : " send"}): ${formatErrorMessage(err)}`,
        );
        return false;
      }
      streamState.stopped = true;
      params.warn?.(`telegram stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const { loop, update, stop, stopForClear } = createFinalizableDraftStreamControlsForState({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
  });

  const clear = async () => {
    await clearFinalizableDraftMessage({
      stopForClear,
      readMessageId: () => streamMessageId,
      clearMessageId: () => {
        streamMessageId = undefined;
      },
      isValidMessageId: (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
      deleteMessage: async (messageId) => {
        await params.api.deleteMessage(chatId, messageId);
      },
      onDeleteSuccess: (messageId) => {
        params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
      },
      warn: params.warn,
      warnPrefix: "telegram stream preview cleanup failed",
    });
  };

  const discard = async () => {
    await stopForClear();
  };

  const forceNewMessage = () => {
    if (rateLimitedUntilMs > 0 && Date.now() < rateLimitedUntilMs) {
      params.warn?.(
        "telegram stream preview: forceNewMessage suppressed during 429 backoff; lane rotation deferred",
      );
      pendingForceNewMessage = true;
      return;
    }
    textBaseOffset = 0;
    resetStreamToNewMessage();
  };

  const materialize = async (): Promise<number | undefined> => {
    await stop();
    if (previewTransport === "message" && typeof streamMessageId === "number") {
      return streamMessageId;
    }
    const renderedText = lastSentText || lastDeliveredText;
    if (!renderedText) {
      return undefined;
    }
    const renderedParseMode = lastSentText ? lastSentParseMode : undefined;
    try {
      const { sent, usedThreadParams } = await sendRenderedMessageWithThreadFallback({
        renderedText,
        renderedParseMode,
        fallbackWarnMessage:
          "telegram stream preview materialize send failed with message_thread_id, retrying without thread",
      });
      const sentId = sent?.message_id;
      if (typeof sentId === "number" && Number.isFinite(sentId)) {
        streamMessageId = Math.trunc(sentId);
        if (resolvedDraftApi != null && streamDraftId != null) {
          const clearDraftId = streamDraftId;
          const clearThreadParams =
            usedThreadParams && threadParams?.message_thread_id != null
              ? { message_thread_id: threadParams.message_thread_id }
              : undefined;
          try {
            await resolvedDraftApi(chatId, clearDraftId, "", clearThreadParams);
          } catch {}
        }
        return streamMessageId;
      }
    } catch (err) {
      params.warn?.(`telegram stream preview materialize failed: ${formatErrorMessage(err)}`);
    }
    return undefined;
  };

  params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    previewMode: () => previewTransport,
    previewRevision: () => previewRevision,
    lastDeliveredText: () => lastDeliveredText,
    clear,
    stop,
    discard,
    materialize,
    forceNewMessage,
    sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number",
  };
}

export const __testing = {
  resetTelegramDraftStreamForTests() {
    getDraftStreamState().nextDraftId = 0;
  },
};
