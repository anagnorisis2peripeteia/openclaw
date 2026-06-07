/**
 * Plugin SDK surface for native streaming channel echo (B-full).
 *
 * A channel plugin registers an EchoRendererFactory so that, when an origin turn
 * has streaming-enabled echo targets on that channel, the core fan-out can render
 * the single agent run natively on each target. See src/infra/outbound/echo-streaming.ts.
 *
 * Ownership contract (stable surface):
 * - A channel plugin registers the factory for ITS OWN channel id, once, at startup.
 *   Registration is first-wins: a foreign/later caller cannot overwrite an already
 *   registered channel (conflicting re-registration is ignored with a warning).
 * - The factory returns a ChannelEchoRenderer to stream a target natively, or
 *   `undefined` to decline (e.g. streaming disabled), in which case the core post-hoc
 *   final-text mirror handles that target. A renderer MUST NOT block or throw into the
 *   origin turn; the fan-out isolates each renderer.
 */
export {
  echoTargetKey,
  isStreamingEchoTargetHandled,
  registerEchoRendererFactory,
  resolveEchoRendererFactory,
} from "../infra/outbound/echo-streaming.js";
export type {
  ChannelEchoRenderer,
  EchoRendererFactory,
  EchoRendererFactoryParams,
} from "../infra/outbound/echo-streaming.js";
