/**
 * Plugin SDK surface for native streaming channel echo (B-full).
 *
 * A channel plugin registers an EchoRendererFactory so that, when an origin turn
 * has streaming-enabled echo targets on that channel, the core fan-out can render
 * the single agent run natively on each target. See src/infra/outbound/echo-streaming.ts.
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
