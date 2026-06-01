import { readSessionEntry } from "../../config/sessions/store-load.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  registerInternalHook,
  type InternalHookEvent,
} from "../../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import { resolveEchoTargets } from "./echo.js";
import { deliverOutboundPayloadsInternal } from "./deliver.js";

const log = createSubsystemLogger("outbound/echo-hook");

let registered = false;

export function registerEchoHook(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerInternalHook("message:sent", handleMessageSent);
  registerInternalHook("message:received", handleMessageReceived);
}

function resolveSessionEchoEntry(sessionKey: string): SessionEntry | undefined {
  let cfg;
  try {
    cfg = getRuntimeConfig();
  } catch {
    return undefined;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId: parsed?.agentId });
  try {
    return readSessionEntry(storePath, sessionKey) as SessionEntry | undefined;
  } catch {
    return undefined;
  }
}

function fireEchoToTargets(params: {
  entry: SessionEntry;
  originChannel: string;
  originTo: string;
  originAccountId?: string;
  originThreadId?: string | number;
  role: "user" | "assistant";
  content: string;
}): void {
  const targets = resolveEchoTargets(params.entry, {
    originChannel: params.originChannel,
    originTo: params.originTo,
    originAccountId: params.originAccountId,
    originThreadId: params.originThreadId,
    role: params.role,
  });

  if (targets.length === 0) {
    return;
  }

  let cfg;
  try {
    cfg = getRuntimeConfig();
  } catch {
    return;
  }

  const prefix = params.role === "user" ? `\u{1F4F1} [via ${params.originChannel}] ` : `\u{1F916} [echo] `;
  const echoPayloads = [{ text: prefix + params.content }];

  for (const target of targets) {
    deliverOutboundPayloadsInternal({
      cfg,
      channel: target.channel as Exclude<string, "none">,
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
      payloads: echoPayloads,
      bestEffort: true,
      skipQueue: true,
      silent: true,
    }).catch((err: unknown) => {
      log.warn(
        `Echo delivery failed for ${target.channel}:${target.to}: ${formatErrorMessage(err)}`,
      );
    });
  }
}

async function handleMessageSent(event: InternalHookEvent): Promise<void> {
  const ctx = event.context as {
    to?: string;
    content?: string;
    success?: boolean;
    channelId?: string;
    accountId?: string;
  } | null;

  if (!ctx?.success || !ctx.content || !event.sessionKey) {
    return;
  }

  const entry = resolveSessionEchoEntry(event.sessionKey);
  if (!entry?.echoTargets?.length) {
    return;
  }

  const originChannel = ctx.channelId ?? "";
  const originTo = ctx.to ?? "";
  if (!originChannel || !originTo) {
    return;
  }

  fireEchoToTargets({
    entry,
    originChannel,
    originTo,
    originAccountId: ctx.accountId,
    originThreadId: entry.lastThreadId,
    role: "assistant",
    content: ctx.content,
  });
}

async function handleMessageReceived(event: InternalHookEvent): Promise<void> {
  const ctx = event.context as {
    from?: string;
    content?: string;
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    metadata?: { threadId?: string | number };
  } | null;

  if (!ctx?.content || !event.sessionKey) {
    return;
  }

  const entry = resolveSessionEchoEntry(event.sessionKey);
  if (!entry?.echoTargets?.length) {
    return;
  }

  const originChannel = ctx.channelId ?? "";
  const originTo = ctx.conversationId ?? ctx.from ?? "";
  if (!originChannel || !originTo) {
    return;
  }

  fireEchoToTargets({
    entry,
    originChannel,
    originTo,
    originAccountId: ctx.accountId,
    originThreadId: ctx.metadata?.threadId ?? entry.lastThreadId,
    role: "user",
    content: ctx.content,
  });
}
