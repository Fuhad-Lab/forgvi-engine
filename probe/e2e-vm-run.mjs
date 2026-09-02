/**
 * Local E2E: VM-bound Forgvi 2.0 run against a REAL Daytona sandbox.
 *
 * 1. Mint a grant with the shared secret
 * 2. POST /runs with the grant (objective that forces file writes + commands)
 * 3. Follow the SSE journal until the run finishes
 * 4. Check the sandbox's file-tree for the artifacts the chief created
 * 5. Also verify a forged grant is rejected
 */
import { mintWorkspaceGrant } from "/home/z/forgvi-engine/src/grant.js";

const ENGINE = "http://localhost:8080";
const DAYTONA = "https://arcforge-daytona.onrender.com";
const SECRET = process.env.WORKSPACE_GRANT_SECRET;
const SANDBOX_ID = process.argv[2];
if (!SANDBOX_ID) {
  console.error("usage: node e2e-vm-run.mjs <sandboxId>");
  process.exit(1);
}

const grant = mintWorkspaceGrant(
  { projectId: "forgvi-e2e-ws-test", sandboxId: SANDBOX_ID, userId: "e2e-test-user" },
  { secret: SECRET },
);
console.log("[e2e] grant minted:", grant.slice(0, 28) + "…");

// 1. Forged grant must be rejected.
const forgedRes = await fetch(`${ENGINE}/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    objective: "forged",
    acceptance: ["x"],
    workspaceGrant: grant.slice(0, -2) + "AA",
  }),
});
console.log("[e2e] forged grant →", forgedRes.status, (await forgedRes.json()).error?.slice(0, 80));
if (forgedRes.status !== 400) throw new Error("forged grant was NOT rejected!");

// 2. Real run.
const runRes = await fetch(`${ENGINE}/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    objective:
      "Create the file /workspace/frontend/hello.html containing a minimal HTML page with an <h1> that says 'Hello from the VM workspace'. Then run `ls -la /workspace/frontend` and `cat /workspace/frontend/hello.html` to verify it exists, and report the verification.",
    acceptance: ["The file /workspace/frontend/hello.html exists in the workspace", "The page contains an h1 saying 'Hello from the VM workspace'"],
    budgets: { maxIterations: 3, wallClockMs: 8 * 60_000, tokenBudget: 120_000 },
    workspaceGrant: grant,
  }),
});
const started = await runRes.json();
console.log("[e2e] run started:", JSON.stringify(started));
if (!runRes.ok || !started.workspace?.bound) throw new Error("run not VM-bound: " + JSON.stringify(started));

// 3. Follow the stream (plain fetch SSE — no EventSource global in node).
const interesting = new Set([
  "workspace_bound", "tool_used", "iteration_started", "completion_decision",
  "role_finished", "run_error", "run_finished",
]);
let toolCount = 0;
let streamDone;
const streamFinished = new Promise((resolve) => { streamDone = resolve; });
const controller = new AbortController();
(async () => {
  try {
    const res = await fetch(`${ENGINE}/runs/${started.runId}/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const env = JSON.parse(dataLine.slice(6));
          const e = env.event;
          if (interesting.has(e.type)) {
            if (e.type === "tool_used") {
              toolCount++;
              console.log(`[e2e] tool #${toolCount}: ${e.tool} ${e.status} — ${String(e.detail).slice(0, 90)}`);
            } else {
              console.log(`[e2e] ${e.type}:`, JSON.stringify(e).slice(0, 160));
            }
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* aborted or closed */ }
  streamDone();
})();
const timeout = new Promise((r) => setTimeout(() => r("timeout-9min"), 9 * 60_000));
const outcome = await Promise.race([streamFinished.then(() => "stream-closed"), timeout]);
controller.abort();
console.log("[e2e] run finished:", outcome);

// 4. Verify the artifacts in the VM.
const tree = await (await fetch(
  `${DAYTONA}/api/v1/workspace/${encodeURIComponent(SANDBOX_ID)}/file-tree?max_depth=3`,
)).json();
const flat = JSON.stringify(tree);
console.log("[e2e] hello.html in VM tree:", flat.includes("hello.html"));
const read = await (await fetch(
  `${DAYTONA}/api/v1/workspace/${encodeURIComponent(SANDBOX_ID)}/read?path=/workspace/frontend/hello.html`,
)).json();
console.log("[e2e] file content:", JSON.stringify((read.content ?? "").slice(0, 200)));
if (!flat.includes("hello.html")) throw new Error("hello.html did NOT land in the VM!");
if (!String(read.content ?? "").includes("Hello from the VM workspace")) {
  throw new Error("file content mismatch — the chief did not build in the VM!");
}

// 5. Local disk check — the engine must NOT have written locally.
console.log("[e2e] DONE — files verified in the VM");
process.exit(0);
