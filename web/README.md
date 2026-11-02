# Receipt Flow — browser version

The same tool as the Python app, running entirely in the browser: photos are never uploaded.
Tesseract (Greek + English), zxing (QR/barcodes) and OpenCV run as WebAssembly from `vendor/`; nothing is
fetched from a CDN.

## Host it on a server

`web/deploy/deploy.sh user@host` builds `web/dist/` (a self-contained static site), copies it to
`/opt/receiptflow/www` and installs the systemd service `receiptflow` (`deploy/server.py`: a small Python static
server on port 8095, `DynamicUser`, read-only, 128 MB cap). Over plain http the page brings its own SHA-256 for
duplicate detection. Remove: `systemctl disable --now receiptflow && rm -rf /opt/receiptflow
/etc/systemd/system/receiptflow.service`. Any other static web server works too: serve `web/dist/`.

## Run locally

```sh
cd web
npm install && npm run vendor   # once: libraries + Greek/English language data into vendor/ (TESSDATA=dir if not Homebrew's)
node tools/serve.mjs          # http://127.0.0.1:8790/  (WebAssembly and workers need http, not file://)
```

The `web/` folder is static: it can be served by any web server.
The first visit downloads about 20 MB (OpenCV 13 MB, one Tesseract core 4 MB, language files 2.6 MB), then the
browser caches it.

## Layout

| File | What |
|---|---|
| `js/parse.js` | QR and OCR text → date, time, amount (port of `receiptflow/parse.py`) |
| `js/detect.js` | find, turn, straighten and read receipts in a photo (port of `detect.py`); runs in browser and Node |
| `js/pipeline.js` | duplicates, months, PDF names |
| `js/pdf.js` | the numbered A4 month page and a minimal PDF writer |
| `js/engine.js` | browser glue: loads the libraries, decodes photos (HEIC via bundled libheif), builds PDFs |
| `js/app.js`, `index.html` | the page |
| `vendor/` | bundled libraries and language data, built by `npm install && npm run vendor` (not in git) |

## Tests

```sh
npm install                   # once: libraries for the tests and tools/vendor.mjs
node --test test/             # parser, duplicates, months, PDF writer (+ corpus tests when built)
node tools/scan.mjs photo.jpg # the browser code on a photo, from the command line
```

Comparing with the Python version on your own photos (from the project root):

```sh
.venv/bin/python web/tools/make_corpus.py    # real OCR texts + QR codes with Python's answers
.venv/bin/python web/tools/py_reference.py   # Python results per photo
node web/tools/compare.mjs                   # JS results against them
```

These write `web/test/corpus/`, which holds text from your receipts: it is git-ignored.

Differences from the Python app: photos larger than 4200 px on the long side are scaled down on load (phone
browsers run out of memory otherwise), and there is no output folder: each month's PDF is downloaded.
