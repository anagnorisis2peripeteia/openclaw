const TELEGRAM_REQUEST_TIMEOUTS_MS = {
  // Bound startup/control-plane calls so the gateway cannot report Telegram as
  // healthy while provider startup is still hung on Bot API setup.
  deletewebhook: 15_000,
  getme: 15_000,
  getupdates: 45_000,
  setwebhook: 15_000,
  // Bound data-plane calls so a stalled HTTP response cannot block the draft
  // stream flush loop indefinitely (the loop awaits the in-flight promise and
  // every subsequent schedule() piles up behind it).
  sendmessage: 15_000,
  editmessagetext: 15_000,
  deletemessage: 15_000,
} as const;

export function resolveTelegramRequestTimeoutMs(method: string | null): number | undefined {
  if (!method) {
    return undefined;
  }
  return TELEGRAM_REQUEST_TIMEOUTS_MS[method as keyof typeof TELEGRAM_REQUEST_TIMEOUTS_MS];
}
