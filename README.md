# Receipt Flow

> A browser version (no install, nothing uploaded) is in [`web/`](web/README.md).

Receipt photos → **one single-page PDF per month** plus, on the page, a **table of dates and amounts** to copy. Everything runs locally: Tesseract (Greek + English), OpenCV, zxing-cpp
for QR codes, a Flask page on `127.0.0.1`.

## Run

```sh
./receiptflow.sh                 # opens http://127.0.0.1:8780 in the browser
./receiptflow.sh photo1.jpg ...  # no UI: writes the PDFs and prints the tables (values not verified)
```

1. **Add photos** (JPEG, PNG, HEIC). One photo can hold several receipts, in any orientation.
2. **Check.** Each receipt is cut out and read. Receipts whose QR code gave the exact date and total are ticked
   *Verified* already; the rest say *Please check*: compare with the picture, fix or type in what is missing, tick
   *Verified*. A receipt the tool missed can be added by hand.
3. **Months** (appears once every receipt is verified). Per month: the PDF page (receipts numbered 1, 2, 3… in
   date order) and a table of No., date and amount. *Copy dates* and *Copy amounts* each copy one column, one value
   per line in receipt-number order, to paste wherever you want. Choose decimal comma or point for the amounts.
   *Save the PDFs* writes them to `output/`.

Step 3 asks for an optional name for the PDFs (remembered by your browser). With a name the files are
`expenses_<mon>_<year>_<surname>.pdf`, without one `expenses_<mon>_<year>.pdf`.

## Just the numbers: CLI, REST API, MCP server

Three front ends on one function (`receiptflow/extract.py`). No PDFs, no tables, nothing stored. For every receipt
in a photo they give exactly:

| field | meaning |
|---|---|
| `date` | `YYYY-MM-DD`, or `null` when it could not be read |
| `amount` | total in euro, or `null` |
| `from_code` | `true` = the amount came from the QR code / barcode (exact), `false` = from the printed text (OCR) |
| `confidence` | 0–1, how sure the tool is that date **and** amount are both right |

```sh
bin/receipt-read photo.jpg                # table
bin/receipt-read --json a.jpg b.heic      # [{"file", "receipts": [...], "error"?}], exit 1 if a photo failed

bin/receipt-api [--host 0.0.0.0] [--port 8781]
curl -F photo=@a.jpg -F photo=@b.jpg http://127.0.0.1:8781/v1/receipts
curl --data-binary @a.jpg -H "Content-Type: image/jpeg" http://127.0.0.1:8781/v1/receipts
#   -> {"results": [{"file": "a.jpg", "receipts": [{"date", "amount", "from_code", "confidence"}]}]}

bin/receipt-mcp                           # MCP server over stdio
claude mcp add receiptflow -- "$PWD/bin/receipt-mcp"     # Claude Code; Claude Desktop: same command in mcpServers
#   tools: read_receipts(paths), read_receipt_image(image_base64, filename)
```

The REST API has no login: keep it on `127.0.0.1` or a trusted network.

**Confidence** is rule-based (`detect._confidence`), not measured against a labelled set:

| how it was read | confidence |
|---|---|
| date or amount missing | 0.0 |
| date and amount from the code, one possible reading | 0.99 |
| amount from the code, date from the printed text | 0.70 |
| amount from the code, but the code allows several totals the print didn't settle | 0.50 (0.45 without a date in the code) |
| printed text, total confirmed by litres × price or net + VAT | 0.65 |
| printed text, total line only | 0.50 |
| printed text that also shows other plausible totals | −0.15 |

Treat anything below 0.99 as "check it". About 12 s per photo on a Mac (Tesseract is the slow part).

### Request ids, good/bad feedback, statistics

Every REST and MCP read answers with a `request_id` and is logged (file names and results only, never the
photos) in `output/requests.sqlite3` (or `$RECEIPTFLOW_DB`); the REST API and the MCP server share it. Each logged
request waits in the backlog until you rate it `good` or `bad` (with an optional note); rating again replaces it.

| | REST | MCP tool | terminal |
|---|---|---|---|
| backlog (unrated) | `GET /v1/requests` (`?all=1`, `?limit=`) | `list_requests` | `bin/receipt-feedback list` |
| one request | `GET /v1/requests/<id>` | | |
| rate | `POST /v1/requests/<id>/feedback` `{"rating": "good", "note": ""}` | `rate_request` | `bin/receipt-feedback rate ID bad wrong date` |
| success over last n | `GET /v1/summary?n=50` (no n: all) | `success_summary(n)` | `bin/receipt-feedback summary 50` |
| full statistics | `GET /v1/stats` | `request_stats` | `bin/receipt-feedback stats` |

The summary gives `verified`, `good`, `bad`, `success_pct` (good ÷ verified), `pending_in_window` (of the last n,
not rated yet) and `pending_total` (unrated overall). The statistics also split good/bad by interface and by the
request's lowest confidence, which is the data for calibrating the confidence numbers.

## Duplicates

Within one upload: an identical photo file is skipped (the page says which). A receipt whose QR code already
appeared is marked *Duplicate* and starts with *Use* unticked. Same date, time and amount without a QR match gets
a *Possible duplicate* warning and stays in, for you to decide. Earlier sessions are not checked.

## Which receipts it reads, and what it was tested on

Built for **Greek retail receipts** printed by cash registers and tax devices (ΦΗΜ). Since 1 November 2023 every
such receipt must carry an **AADE QR code**, and that code is what makes a reading exact.

| On the receipt | What the tool gets from it |
|---|---|
| **AADE signature QR**: link to `www1.aade.gr/tameiakes/...?SIG=` holding device id, counter, hash, optional date-time (YYMMDDHHMM) and the total | total always; date and time when the code has them (otherwise the date comes from the print) |
| **`;`-separated QR** (fuel pumps): type; serial; hash; `YYYY-MM-DD`; time; …; litres; price; total | date, time and total, exact |
| **e-invoice provider QR** (links to the issued document, e.g. `epsilondigital*.epsilonnet.gr`) | no values in the code: used only to spot duplicates; date and total come from the print |
| **numeric barcodes** (PDF417 / DataMatrix on some taximeters) | no values: the print is used |
| **no code** (older receipts, unreadable codes) | Tesseract on the printed text (Greek + English) |

Printed text: totals labelled ΣΥΝΟΛΟ, ΠΛΗΡΩΤΕΟ (amount payable), ΓΕΝΙΚΟ ΣΥΝΟΛΟ or TOTAL; VAT-rate lines and quantities
are ignored; fuel totals are cross-checked as litres × price per litre, others as net + VAT. Dates labelled ΗΜ/ΝΙΑ,
ΗΜΕΡΟΜΗΝΙΑ or DATE, and on taxi receipts ΕΝΑΡΞΗ ΔΙΑΔΡΟΜΗΣ (trip start) over ΛΗΞΗ (trip end). Amounts in euro.

**Tested on** 20 phone photos (2023–2026, several receipts each, upright, sideways, tilted and touching): 64
receipts, mostly **fuel stations** and **taxis**, plus cafés/restaurants and other shops. In those photos the
codes were 18 AADE signature QRs (7 with date-time), 5 fuel-pump `;` QRs, 6 e-invoice links and 3 numeric
barcodes. Results: 21 receipts got their total from the code, 12 of them fully exact (confidence 0.99); 41 of 64
got both a date and a total. The misses are mostly pre-November-2023 receipts without a QR, crumpled paper,
taximeter print, and receipts lying on top of each other. Those photos are personal and not in this repository:
the tests that use them skip themselves when `tests/fixtures/` is empty.

## How receipts are read

- **QR first.** Greek receipts carry the AADE signature (`...?SIG=` device, counter, hash, optional YYMMDDHHMM,
  total) or a `;`-separated record with date and total. These are exact.
- **Then Tesseract**, on a plain grayscale copy first, then with stamps removed, then contrast-stretched, until
  a date and total are found. Fuel receipts are cross-checked: litres × price per litre = total.
- **Finding receipts:** the photo is turned upright (QR orientation, else Tesseract), each receipt is
  straightened, and receipts are separated by grouping printed text lines into columns (paper edges, shadows and
  handwriting are ignored).

## Setup (once)

```sh
brew install tesseract tesseract-lang
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q
```

Put your own test photos in `samples/` and `tests/fixtures/` (both git-ignored: receipts are personal). Uploaded photos and crops sit in
`output/.jobs/` and are deleted after 7 days.
