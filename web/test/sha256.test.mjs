import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// engine.js imports browser-only modules at the top; load just the function source.
const src = readFileSync(new URL("../js/engine.js", import.meta.url), "utf8");
const body = src.slice(src.indexOf("export function sha256Bytes"));
const sha256Bytes = new Function(`${body.replace("export ", "")}; return sha256Bytes;`)();
const hex = (b) => Buffer.from(b).toString("hex");

test("built-in SHA-256 matches node:crypto", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 123457]) {
    const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
    assert.equal(hex(sha256Bytes(data)), createHash("sha256").update(data).digest("hex"), `length ${n}`);
  }
});
