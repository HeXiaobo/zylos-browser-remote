import { AttachmentScope } from "../../scripts/attachments.js";
import { replyCommands } from "../../scripts/reply-route.js";
import { controlLossReceipt } from "./control-loss.js";

// Generic request/response exchange. No action names, page rules or decisions
// are interpreted here. One response can carry the client's next request.
const TERMINAL_KINDS = ["done", "blocked"];

class AgentExchange {
  constructor(ext) {
    this.ext = ext;
    this.states = new Map();
    ext.on("disconnected", (key) => this.disconnected(key));
    ext.on("agent-turn-end", (event) => this.ended(event));
  }
  ingest(message) {
    const { endpointId, chatId, request } = message;
    let state = this.states.get(endpointId);
    if (!state || state.taskId !== chatId) {
      state?.attachments.close();
      if (state?.waiter) {
        state.waiter.resolve({
          ok: false,
          code: "STALE_DECISION",
          message: "Turn was replaced",
        });
      }
      state = {
        taskId: chatId,
        mode: false,
        receipts: new Map(),
        attachments: new AttachmentScope(),
      };
      this.states.set(endpointId, state);
    }
    state.next = {
      ...request,
      endpointId,
      replyCommands: replyCommands(endpointId, request.id),
    };
    if (!state.mode) return false; // First delivery uses the existing C4 adapter.
    if (!state.waiter && state.orphan) {
      // The caller gave up; keep the result so a retry of that request gets it.
      state.waiter = { id: state.orphan, resolve: () => {} };
      state.orphan = undefined;
    }
    if (state.waiter) this.deliver(state);
    return true;
  }
  attachmentsFor({ endpointId, chatId }) {
    const state = this.states.get(endpointId);
    return state?.taskId === chatId ? state.attachments : undefined;
  }
  deliver(state) {
    const waiter = state.waiter;
    if (!waiter) return;
    let response;
    try {
      response = state.terminal
        ? { ok: true, accepted: true, finished: true, status: state.terminal,
            ...(state.interruption ? { interruption: state.interruption } : {}) }
        : {
            ok: true,
            accepted: true,
            next: state.attachments.materialize(state.next),
          };
      if (!state.terminal) state.next = response.next;
    } catch {
      response = {
        ok: false,
        code: "ATTACHMENT_FAILED",
        message:
          "Agent attachment could not be saved; browser input must not be repeated",
      };
    }
    state.receipts.set(waiter.id, response);
    while (state.receipts.size > 32)
      state.receipts.delete(state.receipts.keys().next().value);
    this.release(state);
    waiter.resolve(response);
  }
  release(state) {
    state.waiter = null;
  }
  // The caller stopped waiting (its HTTP client closed). Ask the
  // extension to cancel the in-flight execution; later results stay receiptable.
  abandon(endpointId, id, reason = "caller-closed", waiter = this.states.get(endpointId)?.waiter) {
    const state = this.states.get(endpointId);
    if (!waiter || state?.waiter !== waiter || waiter.id !== id) return undefined;
    this.release(state);
    state.orphan = id;
    this.ext.request(endpointId, { method: "agent-cancel", params: { id, reason }, timeoutMs: 10000 })
      .catch(() => {}); // Older extensions reject it; the release above still holds.
    return waiter;
  }
  async respond(endpointId, id, decision, inputId) {
    const state = this.states.get(endpointId);
    if (!state)
      return {
        ok: false,
        code: "STALE_DECISION",
        message: "No active request on this connection",
      };
    if (state.next?.id !== id && !state.receipts.has(id))
      return {
        ok: false,
        code: "STALE_DECISION",
        message: "Request does not belong to the current exchange",
      };
    // A recovery judgment that arrived after terminal expiry must never send
    // another attach attempt. Prior action receipts keep their existing path.
    if (state.terminal && state.next?.id === id && state.next.execution?.mode === "recovery")
      return { ok: false, code: "RECOVERY_CLOSED", finished: true, status: state.terminal,
        ...(state.interruption ? { interruption: state.interruption } : {}),
        message: "Recovery judgment expired or ended; no action was sent" };
    if (state.waiter && TERMINAL_KINDS.includes(decision?.kind) && state.waiter.id === id) {
      // done/blocked must always reach the extension so the task can close.
      // Release only: a cancel would make the extension move on to a new
      // request before this final decision arrives.
      const replaced = state.waiter;
      this.release(state);
      replaced.resolve({
        ok: false,
        code: "DECISION_SUPERSEDED",
        message: "A done/blocked reply replaced this decision; its actions may have partly run",
      });
    }
    if (state.waiter)
      return {
        ok: false,
        code: "DECISION_BUSY",
        message:
          "A decision is still executing; do not submit concurrent decisions",
      };
    // Arm before forwarding: a very fast client may return its next request
    // before acknowledging receipt of this response.
    state.mode = true;
    let mine;
    const next = new Promise((resolve) => {
      // One waiter per endpoint, released by the next request, task end,
      // replacement, disconnect or the caller leaving. Execution itself has
      // no wall-clock deadline here.
      state.orphan = undefined;
      state.waiter = mine = { id, resolve };
    });
    const previous = state.receipts.get(id);
    try {
      // Client validates both the schema and idempotent contents, including
      // retries whose earlier browser actions have already happened.
      await this.ext.request(endpointId, {
        method: "agent-decision",
        params: { id, decision, ...(inputId ? { inputId } : {}) },
        timeoutMs: 10000,
      });
      if (previous && (!state.terminal || previous.finished) && state.waiter === mine) {
        this.release(state);
        mine.resolve({ ...previous, replayed: true });
      } else if (state.waiter && (state.terminal || state.next?.id !== id))
        this.deliver(state);
    } catch (error) {
      // Compare the object: a later retry of the same ID owns its own waiter.
      if (state.waiter === mine) {
        this.release(state);
        mine.resolve({
          ok: false,
          code: error.code || "EXT_ERROR",
          message: error.message,
          details: error.details,
        });
      }
    }
    return next;
  }
  ended({ endpointId, taskId, status, interruption }) {
    const state = this.states.get(endpointId);
    if (!state || state.taskId !== taskId) return;
    state.terminal = status;
    state.interruption = status === "interrupted" || (status === "stopped" && interruption?.recoveryRemoval !== undefined)
      ? controlLossReceipt(interruption) : undefined;
    state.attachments.close();
    if (state.waiter) this.deliver(state);
  }
  disconnected(endpointId) {
    const state = this.states.get(endpointId);
    this.states.delete(endpointId);
    state?.attachments.close();
    if (state?.waiter) {
      state.waiter.resolve({
        ok: false,
        code: "EXT_OFFLINE",
        message:
          "Browser disconnected; do not replay actions after reconnecting",
      });
    }
  }
  close() {
    for (const key of this.states.keys()) this.disconnected(key);
  }
}
export { AgentExchange };
