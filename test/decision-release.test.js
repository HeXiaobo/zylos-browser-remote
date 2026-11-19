import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { AgentLane } from "../src/lib/agent-lane.js";
import { AgentExchange } from "../src/lib/agent-exchange.js";

const endpointId = "aaaaaaaaaaaa";

test("a /decision client that exits mid-wait releases the decision and cancels it in the extension", async (t) => {
  const ext = new EventEmitter();
  const sent = [];
  ext.resolve = () => ({ endpointId });
  ext.request = async (_endpoint, request) => { sent.push(request.method); return { accepted: true }; };
  const exchange = new AgentExchange(ext);
  const lane = new AgentLane({ extLane: ext, port: 0, exchange });
  await lane.listen();
  t.after(() => { lane.close(); exchange.close(); });
  exchange.ingest({ endpointId, chatId: "task", request: { id: "r1", taskId: "task", round: 1 } });

  const body = JSON.stringify({ endpoint: endpointId, id: "r1", decision: { kind: "actions" } });
  const req = http.request({ host: "127.0.0.1", port: lane.server.address().port, path: "/decision", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
  req.on("error", () => {});
  req.end(body);
  for (let i = 0; i < 100 && !exchange.states.get(endpointId)?.waiter; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(exchange.states.get(endpointId).waiter, "decision is executing");
  req.destroy(); // e.g. the agent's `timeout` killed decision.js
  for (let i = 0; i < 100 && exchange.states.get(endpointId).waiter; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(exchange.states.get(endpointId).waiter, null);
  assert.deepEqual(sent, ["agent-decision", "agent-cancel"]);
});

test("a rejected concurrent retry that closes does not release the executing decision", { timeout: 5000 }, async (t) => {
  const ext = new EventEmitter();
  ext.resolve = () => ({ endpointId });
  ext.request = async () => ({ accepted: true });
  const exchange = new AgentExchange(ext);
  const lane = new AgentLane({ extLane: ext, port: 0, exchange });
  await lane.listen();
  t.after(() => { lane.close(); exchange.close(); });
  exchange.ingest({ endpointId, chatId: "task", request: { id: "r1", taskId: "task", round: 1 } });
  const post = (agent) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ endpoint: endpointId, id: "r1", decision: { kind: "actions" } });
    const req = http.request({ host: "127.0.0.1", port: lane.server.address().port, path: "/decision", method: "POST", agent,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.end(body);
  });
  const executing = post(new http.Agent());
  executing.catch(() => {});
  for (let i = 0; i < 100 && !exchange.states.get(endpointId)?.waiter; i++) await new Promise((r) => setTimeout(r, 10));
  const waiter = exchange.states.get(endpointId).waiter;
  const keepAlive = new http.Agent({ keepAlive: false });
  assert.equal((await post(keepAlive)).code, "DECISION_BUSY");
  await new Promise((r) => setTimeout(r, 50)); // the rejected retry's connection closes
  assert.equal(exchange.states.get(endpointId).waiter, waiter);
});
