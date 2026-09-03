/**
 * Forgvi Engine — orchestrator utils (Vube spec pillars 3 + 4).
 *
 * `spawnSpecialistAgent` is the spec's Step B helper, exactly:
 *
 *   def spawn_specialist_agent(persona_key, specific_task):
 *       system_prompt = G.prompts.get(persona_key, "You are an expert AI software agent.")
 *       return rlm(composed_prompt)
 *
 * …in the JS kernel: persona system prompt from `.prime/prompts/` (loaded
 * into G), composed with the assigned task, executed by a fresh tool-less
 * prime-agent session (the rlm subagent equivalent). The CHIEF decides the
 * graph at runtime — `dispatchParallel` is the asyncio.gather equivalent
 * (Promise.all) that spawns tracks concurrently with zero hardcoded edges.
 *
 * Specialists are ADVISORS by design: they return specs/code/checklists;
 * the chief applies them through bash/edit so every artifact carries tool
 * evidence the judge can verify, and concurrent sessions never race the
 * shared workspace.
 */

import { composeSpecialistPrompt, getPersona, listPersonas } from "./personas.js";
import { createSpecialistSession } from "./kernel.js";

const DEFAULT_TRACK_TIMEOUT_MS = 240_000; // 4 min per specialist

/**
 * Spawn ONE specialist subagent (persona key + task) and await its report.
 * @returns {Promise<{ok: boolean, persona: string, report: string, durationMs: number, error?: string}>}
 */
export async function spawnSpecialistAgent(personaKey, specificTask, { signal } = {}) {
  const started = Date.now();
  const persona = getPersona(personaKey);
  const prompt = composeSpecialistPrompt(personaKey, specificTask);
  let session = null;
  try {
    const built = await createSpecialistSession();
    session = built.session;
    await session.prompt(prompt);
    const report = built.lastAssistantText();
    return {
      ok: true,
      persona: persona?.key ?? String(personaKey),
      personaName: persona?.name ?? String(personaKey),
      report: String(report ?? "").trim(),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      persona: String(personaKey),
      personaName: persona?.name ?? String(personaKey),
      report: "",
      error: String(error?.message ?? error),
      durationMs: Date.now() - started,
    };
  } finally {
    try {
      session?.dispose();
    } catch {
      /* best effort */
    }
  }
}

/**
 * The dynamic multi-agent dispatch (the Replit pattern's
 * asyncio.gather(*[asyncio.to_thread(rlm, prompt)])).
 *
 * tracks: [{persona, task}] — spawned CONCURRENTLY; results return
 * together. Journals role_spawned/role_finished per track through the
 * mailbox-aware caller (the orchestrate tool wires the journal in).
 */
export async function dispatchParallel(tracks, { journal, mailbox, iteration, timeoutMs = DEFAULT_TRACK_TIMEOUT_MS } = {}) {
  const valid = [];
  const invalid = [];
  const roster = new Map(listPersonas().map((p) => [p.key, p]));
  for (const t of tracks ?? []) {
    const key = String(t?.persona ?? "").trim();
    const task = String(t?.task ?? "").trim();
    if (!key || !task) {
      invalid.push({ persona: key || "(missing)", error: "track needs `persona` + `task`" });
      continue;
    }
    if (!roster.has(key)) {
      invalid.push({ persona: key, error: `unknown persona — available: ${[...roster.keys()].filter((k) => k !== "chief_orchestrator").join(", ")}` });
      continue;
    }
    valid.push({ persona: key, task });
  }

  const results = await Promise.all(
    valid.map(async (track) => {
      mailbox?.registerMember(track.persona);
      journal?.emit({ type: "role_spawned", role: track.persona }, { role: track.persona, iteration });
      // Timeout guard: a stuck specialist must not hang the whole dispatch.
      const timeout = new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, persona: track.persona, report: "", error: `track timed out after ${Math.round(timeoutMs / 1000)}s` }), timeoutMs),
      );
      const run = spawnSpecialistAgent(track.persona, track.task);
      const result = await Promise.race([run, timeout]);
      journal?.emit(
        {
          type: "role_finished",
          role: track.persona,
          ok: Boolean(result.ok),
          summary: result.ok
            ? `${result.personaName ?? track.persona} delivered a report (${Math.round((result.durationMs ?? 0) / 1000)}s)`
            : String(result.error ?? "failed"),
        },
        { role: track.persona, iteration },
      );
      mailbox?.send({
        from: track.persona,
        to: "chief",
        kind: "report",
        text: (result.report ?? result.error ?? "").slice(0, 4000),
      });
      return result;
    }),
  );

  return { results, invalid };
}
