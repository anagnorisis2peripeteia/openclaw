# Mantis-level proof — #88815 pin-from-here (rework/pin-from-here @ d6c154cb)

Recreation of ClawSweeper's Mantis telegram-desktop flow using the patched local crabbox: a real
OpenClaw gateway built from the branch + Telegram Desktop + user-driver + screen capture, run locally.
Gateway = the branch's own build, global-installed: **OpenClaw 2026.5.31 (d6c154c)**.

## Tests + CI (green on the head being filmed, d6c154cb)
- Typecheck: `pnpm tsgo:core` + `pnpm tsgo:test:src` — 0 errors.
- Lint: `oxlint` on all 8 changed files — 0 warnings / 0 errors.
- Unit tests (changed surface): `commands-pin.test` (8), `echo.test` (28), `chat.send-user-echo` (3),
  and **`agent-runner-execution.test` (152 — the suite the origin fix touches)** — all pass.
- Broader sweep of `src/infra/outbound/` + `src/commands/` as one unsharded batch: 443 pass / 65 fail —
  but those 65 are **cross-file test-isolation artifacts**, not regressions: the named files
  (`target-resolver.test`, `outbound-session.test`, `doctor/empty-allowlist-policy.test`) **pass cleanly
  in isolation** (verified: 38/38), none are files this change touches, and CI runs the unit suite sharded
  (which avoids the batch state-bleed). The change-relevant suites all pass.

## What is filmed (real Telegram Desktop, supergroup forum topic "# General")
A Telegram thread and webchat are bound to one session
(`agent:main:telegram:group:-1003900553563:topic:1`). The thread opts itself in with `/pin on`
(pin-from-here). Then webchat triggers a turn on the same session; the pinned thread receives that
webchat-origin turn rendered through the channel's **native** renderer.

Captured sequence (pinvid.png / pinvid-motion.gif):
1. `/pin on`  →  bot: **"📌 Pinned. This thread will mirror turns from other threads of this session."**
2. `📱 [via webchat] Please answer concisely.`  ← the webchat-origin prompt echoed into the group
3. bot: **"Here is the answer from the webchat-triggered turn, mirrored live into the pinned Telegram
   group via the native renderer."**  ← the mirror landing in the pinned channel

## Native-path evidence (why this is the native renderer, not flat post-hoc)
Instrumented run (PINDBG2) on the same build proved the native fan-out engages for the webchat origin:
```
resolveEchoTargets returned 1 target: ["telegram:..."] (origin=webchat)   <- not self-excluded
target telegram:... factory=found
target telegram:... renderer=CREATED (native!)
```
Gateway log for the filmed run:
```
embedded run start ... messageChannel=webchat
[telegram] outbound send ok chatId=-1003900553563 messageId=194
```
Session store after `/pin`:
```
echoTargets: [{"channel":"telegram","to":"telegram:-1003900553563","accountId":"default","threadId":1,"label":"pinned"}]
```

## The fix that makes native rendering work for webchat origin (commit d6c154cb)
The native fan-out derived its origin from the session's `last*`, which webchat `chat.send` deliberately
does not claim (so a transient webchat poke can't hijack an external session's delivery route — guard at
session-delivery.ts:103-127 / #47745). That left origin = stale telegram = the pinned channel → the
fan-out self-excluded it → flat post-hoc only. Fix: derive the fan-out origin from the turn's actual
origin (`sessionCtx.OriginatingChannel/To`), falling back to `last*`. `last*` semantics are unchanged
(interactive webchat on a webchat-native session still claims `last*` correctly).

Artifacts: `~/clawd/tmp/pinvid.png`, `~/clawd/tmp/pinvid-motion.gif`. Reusable capture:
`~/clawd/.agents/skills/local-mantis/mantis-pin.sh` (desktop) + `mantis-pin-headless.sh` (headless).
