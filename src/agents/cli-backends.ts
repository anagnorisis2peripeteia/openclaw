/**
 * Resolves CLI runtime backends registered by plugins or setup metadata.
 */
import {
  normalizeLegacyCliBackendKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { CliBackendConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineHostCapability } from "../context-engine/types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import {
  resolvePluginSetupCliBackend,
  resolvePluginSetupRegistry,
} from "../plugins/setup-registry.js";
import { resolveRuntimeTextTransforms } from "../plugins/text-transforms.runtime.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendNormalizeConfigContext,
  CliBundleMcpMode,
  CliBackendPlugin,
  CliBackendNativeToolMode,
  PluginTextTransforms,
} from "../plugins/types.js";
import { mergePluginTextTransforms } from "./plugin-text-transforms.js";

type CliBackendsDeps = {
  resolvePluginSetupCliBackend: typeof resolvePluginSetupCliBackend;
  resolvePluginSetupRegistry: typeof resolvePluginSetupRegistry;
  resolveRuntimeCliBackends: typeof resolveRuntimeCliBackends;
};

const defaultCliBackendsDeps: CliBackendsDeps = {
  resolvePluginSetupCliBackend,
  resolvePluginSetupRegistry,
  resolveRuntimeCliBackends,
};

let cliBackendsDeps: CliBackendsDeps = defaultCliBackendsDeps;

/** Fully merged CLI backend definition used by agent runner execution. */
export type ResolvedCliBackend = {
  id: string;
  modelProvider?: string;
  config: CliBackendConfig;
  bundleMcp: boolean;
  bundleMcpMode?: CliBundleMcpMode;
  pluginId?: string;
  transformSystemPrompt?: CliBackendPlugin["transformSystemPrompt"];
  textTransforms?: PluginTextTransforms;
  defaultAuthProfileId?: string;
  authEpochMode?: CliBackendAuthEpochMode;
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  ownsNativeCompaction?: boolean;
  prepareExecution?: CliBackendPlugin["prepareExecution"];
  resolveExecutionArgs?: CliBackendPlugin["resolveExecutionArgs"];
  nativeToolMode?: CliBackendNativeToolMode;
};

type ResolvedCliBackendLiveTest = {
  defaultModelRef?: string;
  defaultImageProbe: boolean;
  defaultMcpProbe: boolean;
  dockerNpmPackage?: string;
  dockerBinaryName?: string;
};

/** Binding between a model provider and the CLI runtime that serves it. */
export type CliRuntimeModelBackendBinding = {
  provider: string;
  runtime: string;
  pluginId?: string;
};

type FallbackCliBackendPolicy = {
  modelProvider?: string;
  bundleMcp: boolean;
  bundleMcpMode?: CliBundleMcpMode;
  baseConfig?: CliBackendConfig;
  normalizeConfig?: (
    config: CliBackendConfig,
    context?: CliBackendNormalizeConfigContext,
  ) => CliBackendConfig;
  transformSystemPrompt?: CliBackendPlugin["transformSystemPrompt"];
  textTransforms?: PluginTextTransforms;
  defaultAuthProfileId?: string;
  authEpochMode?: CliBackendAuthEpochMode;
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  ownsNativeCompaction?: boolean;
  prepareExecution?: CliBackendPlugin["prepareExecution"];
  resolveExecutionArgs?: CliBackendPlugin["resolveExecutionArgs"];
  nativeToolMode?: CliBackendNativeToolMode;
  // Carried through from setup-registered backends so cold-setup / live-test
  // / fallback resolution paths can honour the same inheritance metadata
  // that the main `registered` path uses (line 221 below). Without this,
  // a user who configures only `cliBackends.claude-cli.command` would lose
  // the inherited Claude binary on those paths and the wrapper would fall
  // back to a PATH lookup of `claude`.
  inheritUserConfigFrom?: CliBackendPlugin["inheritUserConfigFrom"];
};

const FALLBACK_CLI_BACKEND_POLICIES: Record<string, FallbackCliBackendPolicy> = {};

function normalizeBundleMcpMode(
  mode: CliBundleMcpMode | undefined,
  enabled: boolean,
): CliBundleMcpMode | undefined {
  if (!enabled) {
    return undefined;
  }
  return mode ?? "claude-config-file";
}

function resolveSetupCliBackendPolicy(provider: string): FallbackCliBackendPolicy | undefined {
  const entry = cliBackendsDeps.resolvePluginSetupCliBackend({
    backend: provider,
  });
  if (!entry) {
    return undefined;
  }
  return {
    // Setup-registered backends keep narrow CLI paths generic even when the
    // runtime plugin registry has not booted yet.
    bundleMcp: entry.backend.bundleMcp === true,
    modelProvider: resolveCliBackendModelProvider(entry.backend),
    bundleMcpMode: normalizeBundleMcpMode(
      entry.backend.bundleMcpMode,
      entry.backend.bundleMcp === true,
    ),
    baseConfig: entry.backend.config,
    normalizeConfig: entry.backend.normalizeConfig,
    transformSystemPrompt: entry.backend.transformSystemPrompt,
    textTransforms: entry.backend.textTransforms,
    defaultAuthProfileId: entry.backend.defaultAuthProfileId,
    authEpochMode: entry.backend.authEpochMode,
    contextEngineHostCapabilities: entry.backend.contextEngineHostCapabilities,
    ownsNativeCompaction: entry.backend.ownsNativeCompaction,
    prepareExecution: entry.backend.prepareExecution,
    resolveExecutionArgs: entry.backend.resolveExecutionArgs,
    nativeToolMode: entry.backend.nativeToolMode,
    inheritUserConfigFrom: entry.backend.inheritUserConfigFrom,
  };
}

function resolveFallbackCliBackendPolicy(provider: string): FallbackCliBackendPolicy | undefined {
  return FALLBACK_CLI_BACKEND_POLICIES[provider] ?? resolveSetupCliBackendPolicy(provider);
}

function normalizeBackendKey(key: string): string {
  return normalizeProviderId(key);
}

function pickBackendConfig(
  config: Record<string, CliBackendConfig>,
  normalizedId: string,
): CliBackendConfig | undefined {
  const directKey = Object.keys(config).find(
    (key) => normalizeOptionalLowercaseString(key) === normalizedId,
  );
  if (directKey) {
    return config[directKey];
  }
  for (const [key, entry] of Object.entries(config)) {
    if (normalizeBackendKey(key) === normalizedId) {
      return entry;
    }
  }
  return undefined;
}

function resolveRegisteredBackend(provider: string) {
  const normalized = normalizeBackendKey(provider);
  return cliBackendsDeps
    .resolveRuntimeCliBackends()
    .find((entry) => normalizeBackendKey(entry.id) === normalized);
}

function resolveCliBackendModelProvider(
  backend: Pick<CliBackendPlugin, "modelProvider">,
): string | undefined {
  const provider = backend.modelProvider?.trim();
  return provider ? normalizeProviderId(provider) : undefined;
}

function addCliRuntimeModelBinding(
  bindings: Map<string, CliRuntimeModelBackendBinding>,
  params: { backend: CliBackendPlugin; pluginId?: string },
): void {
  const provider = resolveCliBackendModelProvider(params.backend);
  const runtime = normalizeBackendKey(params.backend.id);
  if (!provider || !runtime) {
    return;
  }
  bindings.set(`${provider}:${runtime}`, {
    provider,
    runtime,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
  });
}

/** Lists model-provider to CLI-runtime bindings from runtime and optional setup registries. */
export function listCliRuntimeModelBackendBindings(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
  } = {},
): CliRuntimeModelBackendBinding[] {
  const bindings = new Map<string, CliRuntimeModelBackendBinding>();
  for (const backend of cliBackendsDeps.resolveRuntimeCliBackends()) {
    addCliRuntimeModelBinding(bindings, {
      backend,
      ...(backend.pluginId ? { pluginId: backend.pluginId } : {}),
    });
  }
  if (params.includeSetupRegistry === true) {
    for (const entry of cliBackendsDeps.resolvePluginSetupRegistry({
      config: params.config,
      env: params.env,
    }).cliBackends) {
      addCliRuntimeModelBinding(bindings, {
        backend: entry.backend,
        pluginId: entry.pluginId,
      });
    }
  }
  return [...bindings.values()].toSorted((left, right) =>
    left.provider === right.provider
      ? left.runtime.localeCompare(right.runtime)
      : left.provider.localeCompare(right.provider),
  );
}

/** Lists CLI runtime ids that alias canonical model providers. */
export function listCliRuntimeProviderIds(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
  } = {},
): string[] {
  // Only CLI backends with a canonical modelProvider are runtime aliases that
  // should be hidden from model-provider pickers. Standalone CLI backends own
  // direct refs such as acme-cli/model and must remain selectable.
  return [
    ...new Set(
      listCliRuntimeModelBackendBindings(params)
        .map((binding) => normalizeBackendKey(binding.runtime))
        .filter(Boolean),
    ),
  ].toSorted();
}

/** Resolves the canonical model provider served by a CLI runtime id. */
export function resolveCliRuntimeCanonicalProvider(params: {
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeSetupRegistry?: boolean;
}): string | undefined {
  const runtime = normalizeBackendKey(params.runtime ?? "");
  if (!runtime) {
    return undefined;
  }
  const runtimeBinding = listCliRuntimeModelBackendBindings().find(
    (binding) => binding.runtime === runtime,
  );
  if (runtimeBinding) {
    return runtimeBinding.provider;
  }
  if (params.includeSetupRegistry !== true) {
    return undefined;
  }
  const setupBackend = cliBackendsDeps.resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
    env: params.env,
  });
  return setupBackend ? resolveCliBackendModelProvider(setupBackend.backend) : undefined;
}

/** Resolves the binding for one provider/runtime pair when registered. */
export function resolveCliRuntimeModelBackendBinding(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): CliRuntimeModelBackendBinding | undefined {
  const provider = normalizeProviderId(params.provider ?? "");
  const runtime = normalizeBackendKey(params.runtime ?? "");
  if (!provider || !runtime) {
    return undefined;
  }
  const runtimeBinding = listCliRuntimeModelBackendBindings().find(
    (binding) => binding.provider === provider && binding.runtime === runtime,
  );
  if (runtimeBinding) {
    return runtimeBinding;
  }
  const includeSetupRegistry = params.config !== undefined || params.env !== undefined;
  if (!includeSetupRegistry) {
    return undefined;
  }
  const setupBackend = cliBackendsDeps.resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
    env: params.env,
  });
  if (!setupBackend) {
    return undefined;
  }
  const setupProvider = resolveCliBackendModelProvider(setupBackend.backend);
  return setupProvider === provider
    ? {
        provider,
        runtime,
        ...(setupBackend.pluginId ? { pluginId: setupBackend.pluginId } : {}),
      }
    : undefined;
}

/** Checks whether a runtime is registered to serve a model provider. */
export function isCliRuntimeModelBackendForProvider(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCliRuntimeModelBackendBinding(params) !== undefined;
}

function mergeBackendConfig(base: CliBackendConfig, override?: CliBackendConfig): CliBackendConfig {
  if (!override) {
    return { ...base };
  }
  const baseFresh = base.reliability?.watchdog?.fresh ?? {};
  const baseResume = base.reliability?.watchdog?.resume ?? {};
  const baseOutputLimits = base.reliability?.outputLimits ?? {};
  const overrideFresh = override.reliability?.watchdog?.fresh ?? {};
  const overrideResume = override.reliability?.watchdog?.resume ?? {};
  const overrideOutputLimits = override.reliability?.outputLimits ?? {};
  return {
    ...base,
    ...override,
    args: override.args ?? base.args,
    env: { ...base.env, ...override.env },
    modelAliases: { ...base.modelAliases, ...override.modelAliases },
    clearEnv: uniqueStrings([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])]),
    sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
    sessionArgs: override.sessionArgs ?? base.sessionArgs,
    resumeArgs: override.resumeArgs ?? base.resumeArgs,
    reliability: {
      ...base.reliability,
      ...override.reliability,
      outputLimits: {
        ...baseOutputLimits,
        ...overrideOutputLimits,
      },
      watchdog: {
        ...base.reliability?.watchdog,
        ...override.reliability?.watchdog,
        fresh: {
          ...baseFresh,
          ...overrideFresh,
        },
        resume: {
          ...baseResume,
          ...overrideResume,
        },
      },
    },
  };
}

/** Resolves live-test defaults advertised by a CLI backend plugin. */
export function resolveCliBackendLiveTest(provider: string): ResolvedCliBackendLiveTest | null {
  const normalized = normalizeBackendKey(provider);
  const entry =
    cliBackendsDeps.resolvePluginSetupCliBackend({ backend: normalized }) ??
    cliBackendsDeps
      .resolveRuntimeCliBackends()
      .find((backend) => normalizeBackendKey(backend.id) === normalized);
  if (!entry) {
    return null;
  }
  const backend = "backend" in entry ? entry.backend : entry;
  return {
    defaultModelRef: backend.liveTest?.defaultModelRef,
    defaultImageProbe: backend.liveTest?.defaultImageProbe === true,
    defaultMcpProbe: backend.liveTest?.defaultMcpProbe === true,
    dockerNpmPackage: backend.liveTest?.docker?.npmPackage,
    dockerBinaryName: backend.liveTest?.docker?.binaryName,
  };
}

/** Resolves the executable CLI backend config after plugin defaults and user overrides. */
export function resolveCliBackendConfig(
  provider: string,
  cfg?: OpenClawConfig,
  options: { agentId?: string } = {},
): ResolvedCliBackend | null {
  const normalized = normalizeBackendKey(provider);
  const normalizeContext: CliBackendNormalizeConfigContext = {
    backendId: normalized,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(cfg ? { config: cfg } : {}),
  };
  const runtimeTextTransforms = resolveRuntimeTextTransforms();
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  const directOverride = pickBackendConfig(configured, normalized);
  const registered = resolveRegisteredBackend(normalized);
  // Fallback policy is resolved here (early) instead of after the
  // `registered` branch so its `inheritUserConfigFrom` can be consulted
  // alongside `registered.inheritUserConfigFrom`. Cold setup / live-test
  // paths reach this function with `registered === undefined` but with a
  // setup-registered policy in `fallbackPolicy`; without consulting its
  // inheritance metadata, those paths would lose the inherited Claude
  // binary that a user has configured via `cliBackends.claude-cli`.
  const fallbackPolicy = resolveFallbackCliBackendPolicy(normalized);
  const inheritSpec = registered?.inheritUserConfigFrom ?? fallbackPolicy?.inheritUserConfigFrom;
  let override = directOverride;
  if (!override && inheritSpec) {
    // Fold the legacy `anthropic-cli` alias to `claude-cli` on BOTH the
    // inherit target and the configured keys, so an operator who has only
    // `agents.defaults.cliBackends.anthropic-cli` (the pre-rename key) still
    // has it inherited by a backend that declares
    // `inheritUserConfigFrom: { backendId: "claude-cli" }`. Plain
    // `normalizeBackendKey` only normalizes casing/spacing, so the legacy key
    // would never match. Same alias fold the doctor migration + security
    // audit paths use. The direct (non-legacy) match still works because the
    // fold is identity for `claude-cli`.
    const inheritTarget = normalizeLegacyCliBackendKey(inheritSpec.backendId);
    const inherited =
      pickBackendConfig(configured, normalizeBackendKey(inheritSpec.backendId)) ??
      Object.entries(configured).find(
        ([key]) => normalizeLegacyCliBackendKey(key) === inheritTarget,
      )?.[1];
    if (inherited) {
      const filterArgs = inheritSpec.filterArgs;
      override = filterArgs
        ? {
            ...inherited,
            ...(inherited.args ? { args: [...filterArgs(inherited.args)] } : {}),
            ...(inherited.resumeArgs ? { resumeArgs: [...filterArgs(inherited.resumeArgs)] } : {}),
          }
        : inherited;
    }
  }
  if (registered) {
    const merged = mergeBackendConfig(registered.config, override);
    const config = registered.normalizeConfig
      ? registered.normalizeConfig(merged, normalizeContext)
      : merged;
    const command = config.command?.trim();
    if (!command) {
      return null;
    }
    return {
      id: normalized,
      ...(registered.modelProvider
        ? { modelProvider: normalizeProviderId(registered.modelProvider) }
        : {}),
      config: { ...config, command },
      bundleMcp: registered.bundleMcp === true,
      bundleMcpMode: normalizeBundleMcpMode(
        registered.bundleMcpMode,
        registered.bundleMcp === true,
      ),
      pluginId: registered.pluginId,
      transformSystemPrompt: registered.transformSystemPrompt,
      textTransforms: mergePluginTextTransforms(runtimeTextTransforms, registered.textTransforms),
      defaultAuthProfileId: registered.defaultAuthProfileId,
      authEpochMode: registered.authEpochMode,
      contextEngineHostCapabilities: registered.contextEngineHostCapabilities,
      ownsNativeCompaction: registered.ownsNativeCompaction,
      prepareExecution: registered.prepareExecution,
      resolveExecutionArgs: registered.resolveExecutionArgs,
      nativeToolMode: registered.nativeToolMode,
    };
  }

  if (!override) {
    if (!fallbackPolicy?.baseConfig) {
      return null;
    }
    const baseConfig = fallbackPolicy.normalizeConfig
      ? fallbackPolicy.normalizeConfig(fallbackPolicy.baseConfig, normalizeContext)
      : fallbackPolicy.baseConfig;
    const command = baseConfig.command?.trim();
    if (!command) {
      return null;
    }
    return {
      id: normalized,
      ...(fallbackPolicy.modelProvider ? { modelProvider: fallbackPolicy.modelProvider } : {}),
      config: { ...baseConfig, command },
      bundleMcp: fallbackPolicy.bundleMcp,
      bundleMcpMode: fallbackPolicy.bundleMcpMode,
      transformSystemPrompt: fallbackPolicy.transformSystemPrompt,
      textTransforms: mergePluginTextTransforms(
        runtimeTextTransforms,
        fallbackPolicy.textTransforms,
      ),
      defaultAuthProfileId: fallbackPolicy.defaultAuthProfileId,
      authEpochMode: fallbackPolicy.authEpochMode,
      contextEngineHostCapabilities: fallbackPolicy.contextEngineHostCapabilities,
      ownsNativeCompaction: fallbackPolicy.ownsNativeCompaction,
      prepareExecution: fallbackPolicy.prepareExecution,
      resolveExecutionArgs: fallbackPolicy.resolveExecutionArgs,
      nativeToolMode: fallbackPolicy.nativeToolMode,
    };
  }
  const mergedFallback = fallbackPolicy?.baseConfig
    ? mergeBackendConfig(fallbackPolicy.baseConfig, override)
    : override;
  const config = fallbackPolicy?.normalizeConfig
    ? fallbackPolicy.normalizeConfig(mergedFallback, normalizeContext)
    : mergedFallback;
  const command = config.command?.trim();
  if (!command) {
    return null;
  }
  return {
    id: normalized,
    ...(fallbackPolicy?.modelProvider ? { modelProvider: fallbackPolicy.modelProvider } : {}),
    config: { ...config, command },
    bundleMcp: fallbackPolicy?.bundleMcp === true,
    bundleMcpMode: fallbackPolicy?.bundleMcpMode,
    transformSystemPrompt: fallbackPolicy?.transformSystemPrompt,
    textTransforms: mergePluginTextTransforms(
      runtimeTextTransforms,
      fallbackPolicy?.textTransforms,
    ),
    defaultAuthProfileId: fallbackPolicy?.defaultAuthProfileId,
    authEpochMode: fallbackPolicy?.authEpochMode,
    contextEngineHostCapabilities: fallbackPolicy?.contextEngineHostCapabilities,
    ownsNativeCompaction: fallbackPolicy?.ownsNativeCompaction,
    prepareExecution: fallbackPolicy?.prepareExecution,
    resolveExecutionArgs: fallbackPolicy?.resolveExecutionArgs,
    nativeToolMode: fallbackPolicy?.nativeToolMode,
  };
}

/** Test-only dependency controls for CLI backend registry resolution. */
export const testing = {
  resetDepsForTest(): void {
    cliBackendsDeps = defaultCliBackendsDeps;
  },
  setDepsForTest(deps: Partial<CliBackendsDeps>): void {
    cliBackendsDeps = {
      ...defaultCliBackendsDeps,
      ...deps,
    };
  },
} as const;
export { testing as __testing };
