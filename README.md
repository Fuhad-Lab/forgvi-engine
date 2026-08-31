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
