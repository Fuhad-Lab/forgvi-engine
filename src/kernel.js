/**
 * Forgvi Engine — kernel wrapper.
 *
 * The kernel is prime-agent (PrimeIntellect-ai/prime-agent v0.8.1, forked
 * as the foundation of Forgvi 2.0). This module owns:
 *   - the provider registry (models.json, OpenAI-compatible providers —
 *     NVIDIA NIM by default; aihubmix + aihubmix-alt available via env)
 *   - chief sessions (bash + edit tools)
 *   - judge sessions (no tools — the independent verifier)
 *
 * Provider selection is env-driven so switching providers never needs a
 * code change or redeploy:
 *   ENGINE_PROVIDER      "nvidia" (default) | "aihubmix" | "aihubmix-alt"
 *   ENGINE_MODEL         override (defaults to the provider default below)
 *   ENGINE_API_KEY       generic override (wins over the provider's own env)
 *   NVIDIA_API_KEY       key for the nvidia provider
 *   AIHUBMIX_API_KEY     key for the aihubmix / aihubmix-alt providers
 *   AIHUBMIX_BASE_URL    optional: swap the aihubmix baseUrl at runtime
 *
 * aihubmix-alt points at the preferred mirror (api.inferera.com) for when
 * the default aihubmix.com route is unreachable from the host network.
 *
 * Chief tool execution has two backends, chosen per run:
 *   - VM-bound (the default in production): the run carries a verified
 *     workspace grant, and bash/edit operate directly on the project's
 *     Daytona sandbox through the daytona-service — the SAME /workspace
 *     filesystem Forgvi 1.0's in-VM swarm uses. The VM IS the workspace;
 *     nothing is built on the engine host.
 *   - local fallback (dev / unbound runs): a per-run directory on disk.
 *
 * The rest of the engine NEVER talks to an LLM directly; everything goes
 * through the kernel. One owner per subsystem.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createEditTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "prime-agent";
import { createVmWorkspace } from "./vm-operations.js";

const ENGINE_DIR = resolve(new URL("..", import.meta.url).pathname);
const MODELS_JSON = resolve(ENGINE_DIR, ".prime-agent", "models.json");
const WORKSPACE_ROOT = process.env.ENGINE_WORKSPACE_ROOT
  ? resolve(process.env.ENGINE_WORKSPACE_ROOT)
  : resolve(ENGINE_DIR, "workspace");

/**
 * Provider table — one row per provider defined in .prime-agent/models.json.
 *   keyEnv:      the env var the provider's API key lives in
 *   defaultModel: used when ENGINE_MODEL is unset
 */
const PROVIDERS = {
  nvidia: { keyEnv: "NVIDIA_API_KEY", defaultModel: "nvidia/nemotron-3-super-120b-a12b" },
  aihubmix: { keyEnv: "AIHUBMIX_API_KEY", defaultModel: "coding-glm-5.3" },
  "aihubmix-alt": { keyEnv: "AIHUBMIX_API_KEY", defaultModel: "coding-glm-5.3" },
};

const ENGINE_PROVIDER = (process.env.ENGINE_PROVIDER ?? "nvidia").toLowerCase();
const PROVIDER = PROVIDERS[ENGINE_PROVIDER] ?? PROVIDERS.nvidia;
const MODEL_ID = process.env.ENGINE_MODEL ?? PROVIDER.defaultModel;

/** The env var a operator must set for the active provider (health msgs). */
export function requiredKeyEnv() {
  return PROVIDER.keyEnv;
}

let _auth = null;
let _registry = null;
let _model = null;

/** Lazy singletons for auth + model registry + resolved model. */
function getModel() {
  if (_model) return _model;
  const apiKey = process.env.ENGINE_API_KEY ?? process.env[PROVIDER.keyEnv];
  if (!apiKey) {
    throw new Error(
      `${PROVIDER.keyEnv} is not set — the engine cannot reach its ${ENGINE_PROVIDER} model provider`
    );
  }
  _auth = AuthStorage.create(resolve(ENGINE_DIR, ".prime-agent", "auth.json"));
  _auth.setRuntimeApiKey(ENGINE_PROVIDER, apiKey);
  _registry = ModelRegistry.create(_auth, MODELS_JSON);
  _model = _registry.find(ENGINE_PROVIDER, MODEL_ID);
  if (!_model) {
    throw new Error(
      `model "${MODEL_ID}" is not defined for provider "${ENGINE_PROVIDER}" in .prime-agent/models.json`
    );
  }
  return _model;
}

/** True when the kernel can resolve its model + key (health check). */
export function kernelReady() {
  try {
    const model = getModel();
    return Boolean(model && model.id);
  } catch {
    return false;
  }
}

/** Provider/model identity for /health and reports. */
export function kernelModelId() {
  try {
    const model = getModel();
    return `${model.provider}/${model.id}`;
  } catch {
    return null;
  }
}

/**
 * Chief session — the primary agent of a run.
 *
 * When `workspace` (a verified workspace grant's claims) is provided, the
 * bash + edit tools execute against the project's Daytona sandbox: the
 * session's cwd is the VM's /workspace, commands run inside the VM, and
 * edits write into it — the exact filesystem Forgvi 1.0 and the studio's
 * Files/Preview tabs operate on. The local disk is never touched.
 *
 * The tool allowlist ("bash" + "edit") matters: without it prime-agent
 * also activates its built-in ipython tool, which would run a LOCAL python
 * kernel and silently diverge from the VM workspace.
 *
 * Without a workspace, the legacy local-disk backend is used (per-run
 * directory under ENGINE_WORKSPACE_ROOT) — dev runs and unbound fallbacks.
 * The session persists across iterations (the chief keeps its context); the
 * goal loop drives it turn by turn.
 */
export async function createChiefSession({ runId, sessionId, workspace }) {
  const model = getModel();

  if (workspace?.sandboxId) {
    const vm = createVmWorkspace(workspace);
    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      authStorage: _auth,
      modelRegistry: _registry,
      cwd: vm.workspaceRoot,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        enableBuiltinSkills: false,
      }),
      customTools: [
        createBashTool(vm.workspaceRoot, { operations: vm.bashOperations }),
        createEditTool(vm.workspaceRoot, { operations: vm.editOperations }),
      ],
      tools: ["bash", "edit"],
      sessionStartEvent: {
        type: "session_start",
        sessionId,
        source: "forgvi-engine",
        objective: undefined,
      },
    });
    return { session, cwd: vm.workspaceRoot, vm };
  }

  const cwd = resolve(WORKSPACE_ROOT, runId);
  mkdirSync(cwd, { recursive: true });
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage: _auth,
    modelRegistry: _registry,
    cwd,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      enableBuiltinSkills: false,
    }),
    customTools: [createBashTool(cwd), createEditTool(cwd)],
    sessionStartEvent: {
      type: "session_start",
      sessionId,
      source: "forgvi-engine",
      objective: undefined,
    },
  });
  return { session, cwd, vm: null };
}

/**
 * Judge session — the independent verifier. No tools, no workspace, no
 * memory of the chief's reasoning: it sees only the objective, the
 * acceptance criteria, the chief's report, and the evidence. Fresh
 * instance per verification turn so verdicts never anchor on the run's
 * own conversation.
 */
export async function createJudgeSession() {
  const model = getModel();
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage: _auth,
    modelRegistry: _registry,
    cwd: ENGINE_DIR,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      enableBuiltinSkills: false,
    }),
    noTools: "all",
  });
  return session;
}

/** Extract the last assistant text from a session's messages. */
export function lastAssistantText(session) {
  const last = [...session.messages].reverse().find((m) => m.role === "assistant");
  return (last?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}
