// Build web/dist/: a self-contained static site (any web server can serve it).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(web, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
// index.html is written for the claude.ai Artifact host, which adds the document skeleton.
const page = readFileSync(join(web, "index.html"), "utf8");
writeFileSync(join(dist, "index.html"),
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  "<style>body{margin:0}</style>\n</head>\n<body>\n" + page + "\n</body>\n</html>\n");
cpSync(join(web, "js"), join(dist, "js"), { recursive: true });
cpSync(join(web, "vendor"), join(dist, "vendor"), {
  recursive: true,
  filter: (src) => !src.endsWith(".traineddata.gz"), // the page uses the .gz.txt copies (js/tess-worker.js)
});
console.log("built", dist);
