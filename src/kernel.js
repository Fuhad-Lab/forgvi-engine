/**
 * Forgvi Engine — kernel wrapper.
 *
 * The kernel is prime-agent (PrimeIntellect-ai/prime-agent v0.8.1, forked
 * as the foundation of Forgvi 2.0). This module owns:
 *   - the provider registry (NVIDIA NIM via models.json, OpenAI-compatible)
 *   - chief sessions (bash + edit tools)
 *   - judge sessions (no tools — the independent verifier)
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

const MODEL_ID = process.env.ENGINE_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";

let _auth = null;
let _registry = null;
let _model = null;

/** Lazy singletons for auth + model registry + resolved model. */
function getModel() {
  if (_model) return _model;
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not set — the engine cannot reach its model provider");
  }
  _auth = AuthStorage.create(resolve(ENGINE_DIR, ".prime-agent", "auth.json"));
  _auth.setRuntimeApiKey("nvidia", apiKey);
  _registry = ModelRegistry.create(_auth, MODELS_JSON);
  _model = _registry.find("nvidia", MODEL_ID);
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
