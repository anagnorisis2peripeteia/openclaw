/**
 * Lightweight Anthropic setup entry. It registers Claude CLI backend metadata
 * without loading full provider runtime code.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAnthropicInteractiveCliBackend } from "./cli-backend-interactive.js";
import { buildAnthropicCliBackend } from "./cli-backend.js";

/** Setup entry for Claude CLI backend registration. */
export default definePluginEntry({
  id: "anthropic",
  name: "Anthropic Setup",
  description: "Lightweight Anthropic setup hooks",
  register(api) {
    api.registerCliBackend(buildAnthropicCliBackend());
    // Setup lookup narrows by manifest owner then matches a backend id from
    // the setup-registered list. The manifest declares claude-cli-interactive,
    // so the setup entry must register it too — cold setup/live-test/fallback
    // paths cannot resolve this backend before the full runtime registry is
    // active otherwise.
    api.registerCliBackend(buildAnthropicInteractiveCliBackend());
  },
});
