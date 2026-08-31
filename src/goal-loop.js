/**
 * Forgvi Engine — the goal-completion loop.
 *
 * The loop that separates Forgvi 2.0 from a chat loop:
 *
 *   goal (objective + acceptance criteria — the engine's law)
 *     → chief iteration (prime-agent kernel, real tools, real artifacts)
 *     → independent verification (the judge scores every criterion)
 *     → completion decision (complete | continue | escalate)
 *     → repeat within the iteration budget
 *     → completion report with evidence, score, and remaining issues
 *
 * Claims are not proof: the chief cannot finish the run; only the judge
 * can, by passing every acceptance criterion.
 */

import { randomUUID } from "node:crypto";
import { Journal } from "./journal.js";
import { createChiefSession, lastAssistantText } from "./kernel.js";
import { verifyAcceptance } from "./verify.js";

/** Clamp helper. */
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/**
 * DeltaPump — forwards chief streaming to the journal without flooding SSE.
 *
 * Chief text: the frontend REPLACES the assistant bubble content with each
 * `assistant_text` event, so we always send the FULL accumulated text.
 * Chief thinking: the frontend APPENDS; we send batched deltas.
 */
class DeltaPump {
  constructor(journal, iteration) {
    this.journal = journal;
    this.iteration = iteration;
    this.text = "";
    this.thinkingBatch = "";
    this.lastTextFlush = 0;
    this.lastTextFlushLen = 0;
    this.lastThinkingFlush = 0;
    this.textDirty = false;
  }

  onTextDelta(delta) {
    this.text += delta;
    this.textDirty = true;
    const now = Date.now();
    // Flush when 400+ new chars accumulated or 600ms since the last flush,
    // or when the message looks finished (deltas arrive fast; the final
    // flush happens in finish()).
    if (this.text.length - this.lastTextFlushLen >= 400 || now - this.lastTextFlush >= 600) {
      this.flushText();
    }
  }

  flushText() {
    if (!this.textDirty) return;
    this.lastTextFlush = Date.now();
    this.lastTextFlushLen = this.text.length;
    this.textDirty = false;
    this.journal.emit({ type: "assistant_text", text: this.text }, { role: "chief", iteration: this.iteration });
  }

  onThinkingDelta(delta) {
    this.thinkingBatch += delta;
    const now = Date.now();
    if (this.thinkingBatch.length >= 240 || now - this.lastThinkingFlush >= 1200) {
      this.flushThinking();
    }
  }

  flushThinking() {
    if (!this.thinkingBatch) return;
    const batch = this.thinkingBatch;
    this.thinkingBatch = "";
    this.lastThinkingFlush = Date.now();
    this.journal.emit({ type: "assistant_thinking", text: batch }, { role: "chief", iteration: this.iteration });
  }

  /** Final flush when the chief turn ends. */
  finish() {
    this.flushThinking();
    this.flushText();
  }
}

/** Normalize + clamp the client-supplied budgets (the engine sets the ceiling). */
function normalizeBudgets(budgets) {
  const b = budgets ?? {};
  return {
    maxIterations: clamp(Number(b.maxIterations) || 6, 1, 8),
    wallClockMs: clamp(Number(b.wallClockMs) || 30 * 60_000, 60_000, 30 * 60_000),
    tokenBudget: clamp(Number(b.tokenBudget) || 500_000, 10_000, 500_000),
  };
}

/**
 * RunManager — the registry of live runs.
 */
export class RunManager {
  constructor({ maxConcurrent = Number(process.env.ENGINE_MAX_CONCURRENT ?? 3) } = {}) {
    this.maxConcurrent = maxConcurrent;
    /** @type {Map<string, any>} */
    this.runs = new Map();
  }

  /**
   * Create + start a run. Returns the run record immediately; the loop
   * continues in the background. Throws on validation/overload.
   */
  start({ objective, acceptance, budgets }) {
    const cleanObjective = String(objective ?? "").trim();
    const cleanAcceptance = (Array.isArray(acceptance) ? acceptance : [])
      .map((a) => String(a ?? "").trim())
      .filter(Boolean);

    // The engine's law: a goal without acceptance criteria is invalid.
    if (!cleanObjective) throw new Error("objective is required");
    if (cleanAcceptance.length === 0) throw new Error("acceptance criteria are required — a goal without acceptance criteria is invalid");

    if (this.countActive() >= this.maxConcurrent) {
      throw new Error("engine at max concurrent runs — try again shortly");
    }

    const runId = randomUUID();
    const sessionId = randomUUID();
    const goalId = randomUUID();
    const clamped = normalizeBudgets(budgets);

    const run = {
      runId,
      sessionId,
      goalId,
      objective: cleanObjective,
      acceptance: cleanAcceptance,
      budgets: clamped,
      status: "running",
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: null,
      abortRequested: false,
      report: null,
      journal: new Journal(runId, sessionId, goalId),
      /** @type {Array<{kind: string, name: string, status: string}>} */
      evidence: [],
      lastChiefReport: "",
      promise: null,
    };

    this.runs.set(runId, run);
    run.promise = this.#execute(run).catch((error) => {
      // The last-resort guard: no run ends without a terminal event.
      if (run.status === "running") {
        run.status = "incomplete";
        run.finishedAt = Date.now();
        run.journal.emit({ type: "run_error", error: String(error?.message ?? error) });
        run.journal.emit({
          type: "run_finished",
          status: "incomplete",
          summary: "The run failed with an internal error.",
          verificationScore: 0,
          iterations: run.iteration,
          durationMs: Date.now() - run.startedAt,
          remainingIssues: [String(error?.message ?? error)],
        });
        run.journal.close();
      }
    });
    return run;
  }

  get(runId) {
    return this.runs.get(runId) ?? null;
  }

  countActive() {
    let n = 0;
    for (const run of this.runs.values()) if (run.status === "running") n++;
    return n;
  }

  abort(runId, reason = "user abort") {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return false;
    run.abortRequested = true;
    run.abortReason = reason;
    return true;
  }

  /** Public view of a run (GET /runs/:id). */
  view(run) {
    return {
      runId: run.runId,
      goalId: run.goalId,
      status: run.status,
      objective: run.objective,
      acceptance: run.acceptance,
      iteration: run.iteration,
      budgets: run.budgets,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      report: run.report,
      eventCount: run.journal.seq,
    };
  }

  async #execute(run) {
    const { journal } = run;
    journal.emit(
      {
        type: "run_started",
        objective: run.objective,
        acceptance: run.acceptance,
        budgets: run.budgets,
      },
      {},
    );

    const { session } = await createChiefSession({ runId: run.runId, sessionId: run.sessionId });
    run.chiefSession = session;

    // Track tool evidence from the kernel's own event stream:
    // tool_execution_start carries the args; tool_execution_end carries the
    // result + status. The judge sees commands AND their outputs.
    const pendingArgs = new Map();
    const unsubTools = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        pendingArgs.set(event.toolCallId, event.args);
      } else if (event.type === "tool_execution_end") {
        const args = pendingArgs.get(event.toolCallId) ?? event.args;
        pendingArgs.delete(event.toolCallId);
        run.evidence.push({
          kind: "tool",
          name: `${event.toolName}: ${summarizeArgs(args)}`,
          status: event.isError ? "fail" : "pass",
          output: summarizeResult(event.result),
        });
      }
    });

    let previousGaps = [];
    let escalate = false;

    try {
      for (
        let iteration = 1;
        iteration <= run.budgets.maxIterations && run.status === "running";
        iteration++
      ) {
        // Wall-clock budget check.
        if (Date.now() - run.startedAt > run.budgets.wallClockMs) {
          journal.emit({ type: "run_error", error: "wall clock budget exhausted" });
          run.status = "incomplete";
          break;
        }

        run.iteration = iteration;
        journal.emit({ type: "iteration_started", iteration }, { iteration });

        // ── Chief turn ────────────────────────────────────────────────
        const pump = new DeltaPump(journal, iteration);
        const chiefPrompt =
          iteration === 1
            ? buildFirstPrompt(run)
            : buildFollowUpPrompt({ run, gaps: previousGaps, escalate, iteration });

        const unsubStream = session.subscribe((event) => {
          if (event.type !== "message_update" || !event.assistantMessageEvent) return;
          const kind = event.assistantMessageEvent.type;
          if (kind === "text_delta" && event.assistantMessageEvent.delta) {
            pump.onTextDelta(event.assistantMessageEvent.delta);
          } else if (kind === "thinking_delta" && event.assistantMessageEvent.delta) {
            pump.onThinkingDelta(event.assistantMessageEvent.delta);
          }
        });

        try {
          await session.prompt(chiefPrompt);
        } finally {
          unsubStream();
          pump.finish();
        }

        if (run.abortRequested) break;

        run.lastChiefReport = lastAssistantText(session);

        // ── Verification turn (the independent judge) ─────────────────
        journal.emit({ type: "role_spawned", role: "verifier" }, { role: "verifier", iteration });
        const verdict = await verifyAcceptance({
          objective: run.objective,
          acceptance: run.acceptance,
          chiefReport: run.lastChiefReport,
          evidence: run.evidence,
        });
        journal.emit(
          {
            type: "role_finished",
            role: "verifier",
            ok: verdict.ok,
            summary: `${Math.round(verdict.score * 100)}% of criteria pass — ${verdict.summary}`,
          },
          { role: "verifier", iteration },
        );
        journal.emit(
          {
            type: "verification_result",
            score: verdict.score,
            verdicts: verdict.verdicts,
          },
          { iteration },
        );
        run.lastVerdict = verdict;

        // ── Completion decision ──────────────────────────────────────
        if (verdict.ok) {
          journal.emit(
            {
              type: "completion_decision",
              action: "complete",
              reason: "all acceptance criteria verified by the independent judge",
            },
            { iteration },
          );
          run.status = "complete";
          break;
        }

        const sameGaps =
          previousGaps.length > 0 &&
          verdict.gaps.length === previousGaps.length &&
          verdict.gaps.every((g, i) => normalizeGap(g) === normalizeGap(previousGaps[i]));

        if (sameGaps) {
          escalate = true;
          journal.emit(
            {
              type: "completion_decision",
              action: "escalate",
              reason: `the same gaps remain for a second iteration (${verdict.gaps.join("; ")}) — a new approach is mandated`,
            },
            { iteration },
          );
        } else {
          journal.emit(
            {
              type: "completion_decision",
              action: "continue",
              reason: `verification not satisfied — fix the named gaps: ${verdict.gaps.join("; ")}`,
            },
            { iteration },
          );
        }
        previousGaps = verdict.gaps;
      }
    } finally {
      unsubTools();
    }

    // Aborted mid-flight?
    if (run.status === "running") {
      run.status = "incomplete";
      if (run.abortRequested) {
        try {
          await session.abort();
        } catch {
          /* already idle */
        }
      }
    }

    // ── Completion report ────────────────────────────────────────────
    const verdict = run.lastVerdict;
    run.finishedAt = Date.now();
    const durationMs = run.finishedAt - run.startedAt;
    const remainingIssues =
      run.status === "complete"
        ? []
        : [
            ...(run.abortRequested ? ["run aborted by user"] : []),
            ...(verdict?.gaps ?? run.acceptance.map((a) => `${a} (not verified within the iteration budget)`)),
          ];

    run.report = {
      goalId: run.goalId,
      runId: run.runId,
      status: run.status,
      summary:
        run.status === "complete"
          ? run.lastChiefReport.slice(0, 2000) || "All acceptance criteria verified."
          : `Incomplete after ${run.iteration} iteration(s). ${verdict?.summary ?? ""}`.trim(),
      verificationScore: verdict?.score ?? 0,
      remainingIssues,
      iterations: run.iteration,
      durationMs,
      evidence: (run.evidence ?? []).slice(-12).reverse(),
    };

    journal.emit(
      {
        type: "run_finished",
        status: run.status,
        summary: run.report.summary.slice(0, 1500),
        verificationScore: run.report.verificationScore,
        iterations: run.report.iterations,
        durationMs: run.report.durationMs,
        remainingIssues: run.report.remainingIssues,
      },
      {},
    );
    journal.close();

    try {
      session.dispose();
    } catch {
      /* best effort */
    }
  }
}

/** First chief prompt: the contract. */
function buildFirstPrompt(run) {
  return [
    "You are the chief agent of a Forgvi 2.0 run. You operate inside the engine's workspace:",
    "every file you create is a real artifact on disk, and every command you run is real.",
    "",
    "OBJECTIVE:",
    run.objective,
    "",
    "ACCEPTANCE CRITERIA — an independent judge will verify each of these exactly as written:",
    ...run.acceptance.map((a, i) => `${i + 1}. ${a}`),
    "",
    `You have at most ${run.budgets.maxIterations} iterations. Claims are not proof: the judge`,
    "scores only what your tool evidence demonstrates. Work in this workspace, build the",
    "artifacts, verify your own work with commands before you claim it, then end with a short",
    "report: what you built, where it lives, and how each criterion is demonstrated.",
  ].join("\n");
}

/** Follow-up chief prompt: the gaps, and the escalation mandate. */
function buildFollowUpPrompt({ run, gaps, escalate, iteration }) {
  const lines = [
    `Iteration ${iteration}. The independent judge scored your previous work and found these gaps:`,
    ...gaps.map((g, i) => `${i + 1}. ${g}`),
    "",
  ];
  if (escalate) {
    lines.push(
      "ESCALATION: the exact same gaps remain from the previous iteration. Your previous approach",
      "is not working. Change the approach fundamentally — do not repeat the same commands or",
      "the same reasoning that failed twice. If a criterion is genuinely impossible, say so",
      "explicitly with the exact blocker instead of claiming success.",
      "",
    );
  } else {
    lines.push(
      "Close each named gap. Verify with real commands before claiming anything.",
      "",
    );
  }
  lines.push(
    `Acceptance criteria (unchanged, the judge re-checks every one):`,
    ...run.acceptance.map((a, i) => `${i + 1}. ${a}`),
    "",
    `Iterations remaining including this one: ${run.budgets.maxIterations - iteration + 1}.`,
  );
  return lines.join("\n");
}

function summarizeArgs(args) {
  if (!args) return "";
  try {
    const obj = typeof args === "string" ? JSON.parse(args) : args;
    // Bash tool args: {command}; edit tool args: {path, ...} — show the
    // most useful single field.
    const cmd = obj?.command ?? obj?.path ?? obj?.file_path ?? obj;
    const str = typeof cmd === "string" ? cmd : JSON.stringify(obj);
    return str.replace(/\s+/g, " ").slice(0, 160);
  } catch {
    return String(args).replace(/\s+/g, " ").slice(0, 160);
  }
}

/** Best-effort extraction of a tool result's textual output. */
function summarizeResult(result) {
  if (result == null) return "";
  try {
    if (typeof result === "string") return result.slice(0, 400);
    if (Array.isArray(result)) {
      return result
        .map((block) =>
          typeof block === "string"
            ? block
            : block?.type === "text"
              ? (block.text ?? "")
              : "",
        )
        .join("\n")
        .slice(0, 400);
    }
    if (typeof result === "object") {
      if (typeof result.output === "string") return result.output.slice(0, 400);
      if (Array.isArray(result.content)) {
        return result.content
          .map((c) => (c?.type === "text" ? (c.text ?? "") : ""))
          .join("\n")
          .slice(0, 400);
      }
      return JSON.stringify(result).slice(0, 400);
    }
    return String(result).slice(0, 400);
  } catch {
    return "";
  }
}

function normalizeGap(gap) {
  return String(gap ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}
