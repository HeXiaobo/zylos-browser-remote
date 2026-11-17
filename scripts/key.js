#!/usr/bin/env node
'use strict';
/*
 * Extension key management. The plaintext is printed ONCE at `new`; only the
 * sha256 digest is kept in keys.json. Hand the owner `relayUrl + key`; the
 * keyId identifies the credential; browser reply endpoints also include the instance ID.
 *
 *   node scripts/key.js new --label bobo-mac
 *   node scripts/key.js list
 *   node scripts/key.js revoke <keyId>
 *
 * Workspace connections (driven by the openmax plugin) add:
 *   new --connection <id> --ttl-days <n> --single-browser
 * and --json on any command for a single machine-readable line on stdout.
 */

import { newKey, listKeys, revokeKey, keysFile } from "../src/lib/keys.js";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
}
const json = rest.includes('--json');
const out = (obj) => console.log(JSON.stringify(obj));
function fail(message) {
  if (json) out({ ok: false, error: message });
  else console.error(message);
  process.exit(2);
}

switch (cmd) {
  case 'new': {
    const label = flag('--label') || '';
    const connectionId = flag('--connection');
    const ttlDays = flag('--ttl-days');
    let ttlMs;
    if (ttlDays !== undefined) {
      const n = Number(ttlDays);
      if (!Number.isFinite(n) || n <= 0) fail('--ttl-days must be a positive number');
      ttlMs = Math.round(n * 86_400_000);
    }
    const singleBrowser = rest.includes('--single-browser');
    const created = newKey({ label, connectionId, ttlMs, singleBrowser });
    if (json) {
      out({ ok: true, ...created, singleBrowser });
      break;
    }
    const { key, keyId } = created;
    console.log(`keyId:  ${keyId}${label ? `  (${label})` : ''}`);
    console.log(`key:    ${key}`);
    console.log(`stored: ${keysFile()}  (digest only -- this is the only time the key is shown)`);
    break;
  }
  case 'list': {
    const keys = listKeys();
    if (json) {
      out({ ok: true, keys });
      break;
    }
    if (!keys.length) console.log(`no keys in ${keysFile()}`);
    for (const k of keys) console.log(`${k.keyId}  ${k.label || '-'}  ${k.createdAt || ''}`);
    break;
  }
  case 'revoke': {
    const id = rest[0];
    if (!id || id.startsWith('--')) fail('usage: key.js revoke <keyId>');
    const revoked = revokeKey(id);
    // Revoking an absent key is success for --json callers: the goal state
    // (key unusable) holds, which keeps retried revokes idempotent.
    if (json) out({ ok: true, keyId: id, revoked });
    else console.log(revoked ? `revoked ${id}` : `no such key ${id}`);
    break;
  }
  default:
    fail('usage: key.js new [--label <who>] [--connection <id>] [--ttl-days <n>] [--single-browser] | list | revoke <keyId>  [--json]');
}
