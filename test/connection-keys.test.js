import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { start } from "../src/index.js";
import { newKey, touchKey, verifyKey, loadKeys, listKeys } from "../src/lib/keys.js";
import { SUBPROTOCOL } from "../src/lib/ext-lane.js";
import { INSTANCE_CAPABILITY } from "../src/lib/endpoint.js";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DAY = 86_400_000;

function tempKeysFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "br-keys-"));
  const file = path.join(dir, "keys.json");
  const saved = process.env.BROWSER_REMOTE_KEYS_FILE;
  process.env.BROWSER_REMOTE_KEYS_FILE = file;
  t.after(() => {
    if (saved === undefined) delete process.env.BROWSER_REMOTE_KEYS_FILE;
    else process.env.BROWSER_REMOTE_KEYS_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return file;
}

async function relayFor(t) {
  const relay = await start({ extPort: 0, agentPort: 0, monitor: true, onRequest: async () => ({ ok: true }) });
  t.after(() => relay.close());
  return relay;
}

// Resolves to {ready} or {closed: code}; a 401 at upgrade resolves {rejected}.
function dial(relay, key, browserId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.ext.server.address().port}/ext`, [SUBPROTOCOL, `key.${key}`]);
    ws.on("unexpected-response", () => resolve({ rejected: true }));
    ws.on("open", () => ws.send(JSON.stringify({
      type: "hello", version: "fixture", browserId, capabilities: ["agent-loop-v1", INSTANCE_CAPABILITY],
    })));
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw);
      if (frame.type === "ready") resolve({ ready: true, ws });
    });
    ws.on("close", (code) => resolve({ closed: code }));
    ws.on("error", () => {});
  });
}

test("single-browser key binds the first instance and refuses others", async (t) => {
  const file = tempKeysFile(t);
  const relay = await relayFor(t);
  const { key, keyId } = newKey({ connectionId: "conn-1", singleBrowser: true, file });

  const first = await dial(relay, key, A);
  assert.ok(first.ready);
  assert.equal(loadKeys(file)[keyId].boundBrowserId, A);

  const second = await dial(relay, key, B);
  assert.equal(second.closed, 4003);

  // The bound instance may still reconnect (e.g. after a service-worker restart).
  first.ws.close();
  await once(first.ws, "close");
  const again = await dial(relay, key, A);
  assert.ok(again.ready);
  again.ws.close();
});

test("ordinary keys keep allowing several browser instances", async (t) => {
  const file = tempKeysFile(t);
  const relay = await relayFor(t);
  const { key, keyId } = newKey({ label: "manual", file });
  const a = await dial(relay, key, A);
  const b = await dial(relay, key, B);
  assert.ok(a.ready && b.ready);
  assert.equal(loadKeys(file)[keyId].boundBrowserId, undefined);
  a.ws.close();
  b.ws.close();
});

test("an expired key is refused at upgrade and closed by the heartbeat", async (t) => {
  const file = tempKeysFile(t);
  const relay = await relayFor(t);
  const { key, keyId } = newKey({ ttlMs: DAY, file });
  assert.ok((await dial(relay, key, A)).ready);

  const keys = loadKeys(file);
  keys[keyId].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(keys));
  assert.equal(verifyKey(key, loadKeys(file)), null);
  assert.ok((await dial(relay, key, B)).rejected);
  assert.equal(listKeys(file)[0].expired, true);

  const closed = new Promise((resolve) => {
    for (const conn of relay.ext.conns.values()) conn.ws.on("close", resolve);
  });
  relay.ext._beat();
  assert.equal(await closed, 4004);
});

test("touchKey renews a sliding expiry at most once per hour", (t) => {
  const file = tempKeysFile(t);
  const now = Date.now();
  const { keyId, expiresAt } = newKey({ ttlMs: 30 * DAY, file });
  assert.deepEqual(touchKey(keyId, A, { file, now: now + 10 * 60_000 }), { ok: true });
  assert.equal(loadKeys(file)[keyId].expiresAt, expiresAt);
  touchKey(keyId, A, { file, now: now + 2 * DAY });
  assert.equal(Date.parse(loadKeys(file)[keyId].expiresAt), now + 32 * DAY);
  assert.deepEqual(touchKey(keyId, A, { file, now: now + 70 * DAY }), { ok: false, reason: "expired" });
});

test("touchKey refuses a single-browser key without an instance id", (t) => {
  const file = tempKeysFile(t);
  const { keyId } = newKey({ singleBrowser: true, file });
  assert.deepEqual(touchKey(keyId, null, { file }), { ok: false, reason: "bound" });
  assert.deepEqual(touchKey(keyId, A, { file }), { ok: true });
  assert.deepEqual(touchKey(keyId, B, { file }), { ok: false, reason: "bound" });
});
