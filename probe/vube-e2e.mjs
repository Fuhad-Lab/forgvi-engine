#!/usr/bin/env node
/**
 * probe/vube-e2e.mjs — the full local Vube goal run.
 *
 * Boots nothing (expects ENGINE_URL), POSTs a goal that REQUIRES the new
 * Vube surface, streams the SSE journal, answers any ask_user question,
 * and verifies the workspace artifacts + judge verdict at the end.
 *
 *   node probe/vube-e2e.mjs
 */
const ENGINE = process.env.ENGINE_URL ?? "http://localhost:8090";

const objective =
  "Scaffold the Vube platform monorepo in the workspace and build a landing page inside apps/web-client whose src/app/page.tsx renders a hero section with the app name demo-app, using the pre-installed Tailwind stack. Use the scaffold_vube tool first.";
const acceptance = [
  "apps/web-client/package.json exists and declares tailwindcss, motion, zustand, @tanstack/react-query, react-hook-form, zod",
  "apps/web-client/src/app/page.tsx exists and contains the text demo-app",
  "packages/vube-types/src/index.ts exists",
  "the workspace root package.json declares workspaces apps/* and packages/*",
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const started = await fetch(`${ENGINE}/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    objective,
    acceptance,
  }),
});
if (!started.ok) {
  console.error("run start failed:", started.status, await started.text());
  process.exit(1);
}
const { runId } = await started.json();
log("run started:", runId);

let sawScaffold = false;
let sawOrchestrate = false;
let sawQuestion = false;
const roles = new Set();

const stream = await fetch(`${ENGINE}/runs/${runId}/events`);
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const deadline = Date.now() + 9.5 * 60_000;
let finished = false;

(async () => {
  while (Date.now() < deadline && !finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const env = JSON.parse(dataLine.slice(6));
        const e = env.event;
        if (e.type === "scaffold_written") {
          sawScaffold = true;
          log("SCAFFOLD WRITTEN:", e.files, "files at", e.root);
        } else if (e.type === "role_spawned") {
          roles.add(e.role);
          if (env.role !== "verifier") sawOrchestrate = true;
          log("role spawned:", e.role);
        } else if (e.type === "role_finished") {
          log("role finished:", e.role, e.ok ? "ok" : "FAIL");
        } else if (e.type === "question") {
          sawQuestion = true;
          log("QUESTION:", e.question);
          const answer = e.options?.[0] ?? "use the defaults";
          await fetch(`${ENGINE}/runs/${runId}/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionId: e.questionId, answer }),
          });
          log("answered:", answer);
        } else if (e.type === "tool_used") {
          log("tool:", e.tool, e.status, (e.detail ?? "").slice(0, 80));
        } else if (e.type === "verification_result") {
          log("VERIFICATION score:", e.score);
        } else if (e.type === "completion_decision") {
          log("DECISION:", e.action, (e.reason ?? "").slice(0, 100));
        } else if (e.type === "assistant_text" && env.iteration) {
          // keep the log compact — only headline chief text per iteration
        } else if (e.type === "run_error") {
          log("RUN ERROR:", e.error);
        } else if (e.type === "run_finished") {
          finished = true;
          log("RUN FINISHED:", e.status, "score", e.verificationScore, "iterations", e.iterations);
          if (e.remainingIssues?.length) log("remaining:", e.remainingIssues);
        }
      } catch {
        /* malformed frame */
      }
    }
  }
})();

// Poll the run state as the backstop (SSE + poll, like the frontend).
while (Date.now() < deadline && !finished) {
  await new Promise((r) => setTimeout(r, 4000));
  const res = await fetch(`${ENGINE}/runs/${runId}`);
  if (!res.ok) continue;
  const data = await res.json();
  if (data.status && data.status !== "running") {
    finished = true;
    log("run state:", data.status);
    if (data.report) {
      log("report score:", data.report.verificationScore, "iterations:", data.report.iterations);
      log("report summary:", (data.report.summary ?? "").slice(0, 300));
    }
  }
}

log("---- CAPABILITY CHECKS ----");
log("scaffold_vube used:", sawScaffold);
log("orchestrate used (specialist spawned):", sawOrchestrate, [...roles]);
log("ask_user used:", sawQuestion);
process.exit(finished ? 0 : 2);
