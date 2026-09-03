# Forgvi Engine

**Forgvi 2.0** — the goal-completion agent engine that powers Forge's 2.0 chat-bar mode.

The engine is a fork-by-dependency of [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) (v0.8.1 release kernel): the kernel owns agent execution, sessions, tools, and streaming; Forgvi adds the layer the kernel deliberately does not have:

- **The goal-completion loop** — an objective with acceptance criteria (the engine's law: *a goal without acceptance criteria is invalid*) driven through bounded iterations.
- **Machine verification** — an independent, tool-less judge session scores every acceptance criterion PASS/FAIL on tool evidence after each iteration.
- **Completion policy** — `complete` (all criteria pass) · `continue` (fix the named gaps) · `escalate` (same gaps twice → a new approach is mandated).
- **The event journal** — every run is journaled; SSE subscribers get full replay + live events.
- **The HTTP surface** — the API the Forge frontend consumes via `NEXT_PUBLIC_FORGVI_ENGINE_URL`.

Claims are not proof: the chief cannot finish a run — only the judge can, by verifying every criterion.

## API

| Route | Method | Description |
|---|---|---|
| `/health` | GET | liveness + kernel/model status |
| `/runs` | POST | start a run — `{objective, acceptance: string[], budgets?}` → `{runId}` |
| `/runs` | GET | list runs (diagnostics) |
| `/runs/:id` | GET | run state + completion report |
| `/runs/:id/events` | GET | SSE — journal replay (`?since=N`) + live events |
| `/runs/:id/abort` | POST | abort a running goal |

### Event envelope (SSE)

```json
{
  "seq": 7, "ts": 1693500000000, "id": "…", "runId": "…", "sessionId": "…",
  "goalId": "…", "iteration": 2, "role": "chief",
  "event": { "type": "assistant_text", "text": "…" }
}
```

Event types: `run_started`, `iteration_started`, `assistant_text`, `assistant_thinking`, `role_spawned`, `role_finished`, `verification_result`, `completion_decision` (`complete` \| `continue` \| `escalate`), `run_error`, `run_finished`.

### Completion report (`GET /runs/:id` → `report`)

```json
{
  "goalId": "…", "runId": "…", "status": "complete" | "incomplete",
  "summary": "…", "verificationScore": 0.75,
  "remainingIssues": ["…"], "iterations": 3, "durationMs": 120000,
  "evidence": [{ "kind": "tool", "name": "bash: …", "status": "pass" }]
}
```

## Run

```bash
NVIDIA_API_KEY=nvapi-… node src/server.js   # PORT defaults to 8080
```

Environment: `NVIDIA_API_KEY` (required), `PORT`, `ENGINE_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`), `ENGINE_MAX_CONCURRENT` (default 3), `ENGINE_EXTRA_ORIGINS` (comma-separated CORS origins).

The model provider is configured in `.prime-agent/models.json` (OpenAI-compatible; NVIDIA NIM by default). The kernel resolves the key from the environment — never from disk.

## Kernel provenance

- Kernel: `prime-agent@0.8.1` — official release tarball from PrimeIntellect-ai/prime-agent (installed as a dependency, `dist/` prebuilt).
- Provider: `packages/ai` openai-completions API against NVIDIA NIM.
- Chief sessions: bash + edit tools in a per-run workspace (`workspace/<runId>/`) — artifacts are real files.
- Judge sessions: tool-less, fresh per verification turn — verdicts never anchor on the chief's reasoning.

## The Vube surface (2.1 — 2026-09)

The engine now carries the Vube platform spec end-to-end:

**Dynamic persona management (pillar 4)** — agent system prompts live as
markdown profiles in `.prime/prompts/` (chief_orchestrator, frontend_expert,
logic_architect, visual_specialist, backend_engineer, qa_verifier,
research_analyst), loaded into harness memory (`G.prompts`) at boot and
hot-reloaded on edit. `GET /personas` lists them; `POST /personas/reload`
forces a rescan; the chief's briefing embeds the live roster.

**Dynamic orchestration (pillar 3, the Replit pattern)** — the chief's
`orchestrate` tool spawns 1-5 specialist subagents concurrently
(`Promise.all` = `asyncio.gather`), each running its persona prompt in a
fresh tool-less session (the rlm equivalent). No hardcoded graphs: the
chief writes the dispatch plan per iteration. Every run also persists its
full step history to an append-only JSONL (`ENGINE_JOURNAL_DIR/<runId>.jsonl`),
and agents exchange direct messages through the nuclear-family mailbox
(`agent_message` events; cross-run chatter is rejected).

**The universal node registry (pillar 3)** — every capability (persona
spawn, dispatch, GitHub, Supabase, scaffold, VM exec) registers with a
dynamic runtime schema in `src/registry.js`; `GET /nodes` prints the
catalog; the chief's `list_nodes` tool discovers it live.

**The Vube monorepo scaffold (pillars 1 + 2)** — `scaffold_vube` writes
the platform monorepo into the workspace: apps/web-client (Next.js with
the full pre-installed premium stack: Tailwind, shadcn/ui, Motion, Magic
UI, Aceternity, HeroUI, Lenis, GSAP, React Three Fiber, Radix, Lucide,
Sonner, Vaul, Embla, TanStack Query, Zustand, React Hook Form, Zod),
apps/api-server, apps/execution-engine, packages/vube-types,
packages/vube-ui, infrastructure.

**MCP parity with Forgvi 1.0** — `github` (REST + git-data-API workspace
sync; `GITHUB_TOKEN`) and `supabase` (execute_sql, apply_migration,
list_tables, list_projects; `SUPABASE_ACCESS_TOKEN` +
`SUPABASE_PROJECT_REF`) — the same tool surface the 1.0 swarm exposes.

**Clarification (ask the user)** — the chief's `ask_user` tool journals a
`question` SSE event (the studio renders the interactive card) and parks
until `POST /runs/:id/answer` (or timeout — the honest fallback instructs
the chief to proceed with best judgment).

**Keep-alive** — on Render, the engine self-pings its public `/health`
every 10 min so the free tier never spins it down (the Uptime Robot
"can't be reached" incident).

### New/changed env

| Var | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT for the github tool |
| `SUPABASE_ACCESS_TOKEN` | sbp_ token for the supabase tool |
| `SUPABASE_PROJECT_REF` | the bound project |
| `ENGINE_JOURNAL_DIR` | where run JSONL histories land |
| `KEEPALIVE_ENABLED` / `KEEPALIVE_INTERVAL_SECONDS` | self-ping guard |

### Probes

`probe/vube-e2e.mjs` — full local goal run: scaffold → judge loop →
capability assertions. The other probes (kernel, tool, e2e-vm, debug)
remain the pre-deploy gauntlet.
