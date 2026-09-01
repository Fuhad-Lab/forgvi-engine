/**
 * Forgvi Engine — HTTP server.
 *
 * The engine the Forge frontend talks to (NEXT_PUBLIC_FORGVI_ENGINE_URL):
 *
 *   GET  /health                 liveness + kernel/model status
 *   POST /runs                   start a goal run {objective, acceptance, budgets}
 *   GET  /runs/:id               run state + completion report
 *   GET  /runs/:id/events        SSE — journal replay + live events
 *   POST /runs/:id/abort         abort a running goal
 *   GET  /runs                   list runs (diagnostics)
 *
 * CORS: origin allowlist (the Forge site + local dev + Render previews).
 * The engine is browser-reachable only from those origins.
 */

// Startup hygiene for the kernel: no version checks, no network on boot.
process.env.PI_OFFLINE ??= "1";
process.env.PI_SKIP_VERSION_CHECK ??= "1";

import express from "express";
import { kernelModelId, kernelReady } from "./kernel.js";
import { RunManager } from "./goal-loop.js";

const PORT = Number(process.env.PORT ?? 8080);
const ALLOWED_ORIGINS = new Set(
  [
    "https://forgeyn.com.ng",
    "https://www.forgeyn.com.ng",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    ...(process.env.ENGINE_EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ].filter(Boolean),
);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

/** CORS with an origin allowlist (credentials never used). */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const manager = new RunManager();

app.get("/health", (_req, res) => {
  const ready = kernelReady();
  res.status(ready ? 200 : 503).json({
    ok: ready,
    status: ready ? "ok" : "degraded",
    engine: "forgvi",
    version: "1.0.0",
    kernel: "prime-agent@0.8.1",
    model: kernelModelId(),
    activeRuns: manager.countActive(),
    totalRuns: manager.runs.size,
  });
});

app.post("/runs", (req, res) => {
  if (!kernelReady()) {
    res.status(503).json({ error: "engine kernel is not configured (missing NVIDIA_API_KEY)" });
    return;
  }
  const { objective, acceptance, budgets, workspaceGrant } = req.body ?? {};
  try {
    const run = manager.start({ objective, acceptance, budgets, workspaceGrant });
    res.status(201).json({
      runId: run.runId,
      goalId: run.goalId,
      status: run.status,
      workspace: run.workspace
        ? { sandboxId: run.workspace.sandboxId, projectId: run.workspace.projectId, bound: true }
        : { bound: false },
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    const isValidation =
      message.includes("acceptance criteria") ||
      message.includes("objective is required") ||
      Boolean(error?.validation);
    res.status(isValidation ? 400 : 429).json({ error: message });
  }
});

app.get("/runs", (_req, res) => {
  res.json({
    runs: [...manager.runs.values()].map((run) => manager.view(run)),
  });
});

app.get("/runs/:id", (req, res) => {
  const run = manager.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json(manager.view(run));
});

app.post("/runs/:id/abort", (req, res) => {
  const run = manager.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  const reason = String(req.body?.reason ?? "user abort");
  const ok = manager.abort(req.params.id, reason);
  res.json({ ok, runId: run.runId, status: run.status, aborted: ok });
});

/** SSE — journal replay + live events, heartbeat every 15s. */
app.get("/runs/:id/events", (req, res) => {
  const run = manager.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  const since = Number(req.query.since ?? 0) || 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const write = (frame) => res.write(frame);
  const detach = run.journal.attach(write, since);

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* closed */
    }
  }, 15_000);

  // Terminal hygiene: when the journal closes, the client has the full
  // replay + the forge-close frame — actually END the response so the
  // EventSource fires onerror/onclose and every consumer (frontend poll
  // fallback included) settles immediately instead of hanging on pings.
  const closeWatcher = setInterval(() => {
    if (run.journal.closed) {
      clearInterval(closeWatcher);
      clearInterval(heartbeat);
      detach();
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
  }, 1_000);

  const close = new Set(req.socket ? [req.socket] : []);
  req.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(closeWatcher);
    detach();
    close.clear();
  });
});

/** 404 + error handling. */
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((error, _req, res, _next) => {
  console.error("[forgvi] unhandled error:", error);
  res.status(500).json({ error: "internal engine error" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[forgvi] engine listening on :${PORT}`);
  console.log(`[forgvi] kernel: ${kernelReady() ? `ready (${kernelModelId()})` : "NOT READY — set NVIDIA_API_KEY"}`);
});

const shutdown = () => {
  console.log("[forgvi] shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
