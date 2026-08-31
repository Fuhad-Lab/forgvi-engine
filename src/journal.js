/**
 * Forgvi Engine — the event journal.
 *
 * Every run journals its events (the engine never loses history), and
 * every SSE subscriber gets: full replay from seq 0 (or ?since=N), then
 * live events, then the terminal envelope and a clean close.
 *
 * Envelope shape — the contract the Forge frontend consumes:
 * {
 *   seq, ts, id, runId, sessionId, goalId?, iteration?, role?,
 *   event: { type: string } & Record<string, unknown>
 * }
 */

import { randomUUID } from "node:crypto";

export class Journal {
  constructor(runId, sessionId, goalId) {
    this.runId = runId;
    this.sessionId = sessionId;
    this.goalId = goalId;
    this.seq = 0;
    /** @type {Array<any>} */
    this.entries = [];
    /** @type {Set<any>} SSE writer set */
    this.subscribers = new Set();
    this.closed = false;
  }

  /**
   * Append an event to the journal and broadcast to live subscribers.
   * Returns the envelope.
   */
  emit(event, meta = {}) {
    if (this.closed) return null;
    const envelope = {
      seq: ++this.seq,
      ts: Date.now(),
      id: randomUUID(),
      runId: this.runId,
      sessionId: this.sessionId,
      goalId: this.goalId,
      iteration: meta.iteration ?? undefined,
      role: meta.role ?? undefined,
      event,
    };
    this.entries.push(envelope);
    const frame = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const sub of this.subscribers) sub(frame);
    return envelope;
  }

  /**
   * Attach an SSE writer. Sends replay (from `since`), then live frames.
   * Returns a detach function.
   */
  attach(writer, since = 0) {
    for (const envelope of this.entries) {
      if (envelope.seq > since) writer(`data: ${JSON.stringify(envelope)}\n\n`);
    }
    if (this.closed) {
      writer("event: forge-close\ndata: closed\n\n");
      return () => {};
    }
    this.subscribers.add(writer);
    return () => this.subscribers.delete(writer);
  }

  /** Terminal: mark closed, drop subscribers (they each got the replay). */
  close() {
    this.closed = true;
    for (const sub of this.subscribers) sub("event: forge-close\ndata: closed\n\n");
    this.subscribers.clear();
  }
}
