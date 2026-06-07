import {
  createTelegramBotCore,
  getTelegramSequentialKey,
  setTelegramBotRuntimeForTest,
} from "./bot-core.js";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { registerTelegramEchoRenderer } from "./echo-renderer-register.js";

export type { TelegramBotOptions } from "./bot.types.js";

export { getTelegramSequentialKey, setTelegramBotRuntimeForTest };

export function createTelegramBot(
  opts: TelegramBotOptions,
): ReturnType<typeof createTelegramBotCore> {
  // Register the native streaming echo renderer (B-full) once; idempotent.
  registerTelegramEchoRenderer();
  return createTelegramBotCore({
    ...opts,
    telegramDeps: opts.telegramDeps ?? defaultTelegramBotDeps,
  });
}
