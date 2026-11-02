// Tiny static server for web/ (WASM and web workers need http, not file://). Local only.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 8790);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
  ".gz": "application/octet-stream", // tesseract.js gunzips language files itself: no Content-Encoding
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, path);
  if (!file.startsWith(root) || /[/\\](node_modules|test|tools)[/\\]/.test(file.slice(root.length))) { res.writeHead(404).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    let body = await readFile(file);
    if (file === join(root, "index.html")) {
      // index.html is written for the Artifact host, which adds the document skeleton: add it here too.
      body = Buffer.concat([Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}</style></head><body>'), body, Buffer.from("</body></html>")]);
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Receipt Flow (browser version) at http://127.0.0.1:${port}/`));
