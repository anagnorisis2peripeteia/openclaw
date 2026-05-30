# Channel Echo / Session Pinning — RFC

## Problem

When a session is used across multiple transports (e.g. Telegram + VituReClaw glasses + web UI), each transport only sees the messages that were sent/received through it. Telegram loses visibility of exchanges that happened on the glasses. The AI has full context (session history is the source of truth), but the human-facing chat logs are fragmented.

## Proposed Solution

**Session-level echo channels**: allow a session to declare one or more "echo targets" — delivery channels that receive a copy of every turn (both user input and AI response) regardless of which transport originated the turn.

## User-Facing Behaviour

```bash
# Pin a session to echo to a Telegram thread
openclaw sessions echo <sessionKey> --channel telegram --to 8661849123 --thread 6216

# Pin to multiple targets
openclaw sessions echo <sessionKey> --channel telegram --to 8661849123
openclaw sessions echo <sessionKey> --channel discord --to general

# Remove an echo pin
openclaw sessions echo <sessionKey> --remove telegram:8661849123

# List echo pins for a session
openclaw sessions echo <sessionKey> --list
```

From VituReClaw HUD: a "PIN" button in the session picker that pins the current session to the Telegram transport Cameron is using.

## Architecture

### Data Model

Add `echoChannels` to the session entry (persisted in the session store):

```typescript
type SessionEchoTarget = {
  channel: string;          // "telegram" | "discord" | etc
  to: string;               // chat ID / channel ID
  accountId?: string;       // which bot account (multi-account)
  threadId?: string;        // Telegram forum topic / Discord thread
  echoUser?: boolean;       // echo user messages too (default: true)
  echoAssistant?: boolean;  // echo AI responses (default: true)
};

// In session entry:
{
  echoChannels?: SessionEchoTarget[];
}
```

### Delivery Flow

```
[Any transport sends a message]
        |
        v
[AI generates response]
        |
        v
[Primary delivery to originating transport]
        |
        v
[Post-delivery echo hook]
        |
        ├── Load session's echoChannels[]
        ├── For each echo target:
        │     ├── Skip if target === originating transport (dedup)
        │     ├── Format user message as echo: "📱 [via Glasses] user said: ..."
        │     ├── Format AI response as echo (full text, best-effort)
        │     └── deliverOutboundPayloads({ channel, to, payloads, bestEffort: true })
        └── All echo deliveries are fire-and-forget (never block primary)
```

### Hook Point

The least-invasive insertion is the existing `message:sent` internal hook in `deliver.ts` (~line 1014). After the primary delivery succeeds and the hook fires, an echo handler:

1. Reads `echoChannels` from the session entry
2. Filters out the originating channel (dedup)
3. Fires `deliverOutboundPayloads` for each remaining target with `bestEffort: true`

### Files Changed

| File | Change |
|------|--------|
| `src/config/sessions/types.ts` | Add `SessionEchoTarget` type and `echoChannels` field to session entry |
| `src/config/sessions/store.ts` | Read/write `echoChannels` in session load/save |
| **`src/infra/outbound/echo.ts`** (new) | Echo fanout logic: load targets, dedup, format, deliver |
| `src/infra/outbound/deliver.ts` | After `message:sent` hook, call echo fanout |
| `src/gateway/server-methods/chat.ts` | Echo user messages from webchat/gateway path (the deliver callback only has AI responses; user message echo needs explicit handling) |
| `src/gateway/server-methods/sessions.ts` | New `sessions.echo` method for add/remove/list echo targets |
| `src/gateway/protocol/schema/sessions.ts` | Schema for echo target CRUD |

### Echo Message Formatting

Echo messages should be visually distinct from native messages:

**User message echo (to Telegram):**
```
📱 [via Glasses] Cameron:
What's the weather like?
```

**AI response echo (to Telegram):**
```
🤖 [echo]
The weather in London is 18°C and partly cloudy.
```

The prefix format should be configurable per-channel (Telegram supports HTML, Discord supports markdown, etc).

### Dedup Rules

1. **Same channel + same `to`**: never echo back to the exact transport that originated the message
2. **Same channel + different `to`**: allowed (e.g. echo to a different Telegram chat)
3. **Multiple echo targets**: all fire independently, no ordering guarantees

### Edge Cases

| Case | Behaviour |
|------|-----------|
| Echo target is offline/unreachable | Best-effort, silently dropped |
| Echo target rate-limited | Respect transport rate limits, may delay |
| Echo during streaming | Echo the final message only, not deltas |
| Echo of media/images | Include media URLs if the target channel supports them |
| Echo of tool-use blocks | Skip tool internals, echo final text only |
| Circular echo (A echoes to B, B echoes to A) | Dedup by checking if the message is itself an echo (add `isEcho: true` flag to delivery context) |
| Session has no echo targets | No-op, zero overhead |

### VituReClaw Client Changes

Add to the HUD session picker:

- **PIN** button per session — opens a target picker (list of known channels from `channel.list`)
- **UNPIN** button for active pins
- Visual indicator (📌) on pinned sessions in the picker

The client calls `sessions.echo` gateway method to manage pins.

## Non-Goals (v1)

- Real-time sync of typing indicators across transports
- Retroactive echo of historical messages (only future turns)
- Per-message echo opt-out (all turns echo once pinned)
- Echo of system/tool messages (only user + assistant)

## Testing

1. Pin a session to Telegram, send a message from VituReClaw, verify both user message and AI response appear in Telegram
2. Send a message from Telegram on the same session, verify it does NOT double-echo back to Telegram
3. Pin to two targets, verify both receive echoes
4. Remove a pin, verify echoes stop
5. Verify primary delivery is never blocked by echo failures

## Estimated Effort

- Session config + store: ~2h
- Echo fanout logic: ~3h
- Gateway method + schema: ~2h
- User message echo from webchat path: ~1h
- VituReClaw PIN UI: ~1h
- Testing: ~2h

**Total: ~11h across 2-3 sessions**
