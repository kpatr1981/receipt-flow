// A small pool of Tesseract.js workers: OCR jobs run in parallel, each worker switches
// page-segmentation mode as needed. Works with the browser and the Node build of tesseract.js.

export async function createOcrPool(createWorker, { size = 2, langs = "ell+eng", options = {} } = {}) {
  const workers = [];
  for (let i = 0; i < size; i++) {
    const worker = await createWorker(langs, 1, options); // 1 = LSTM only, as the Python version
    workers.push({ worker, psm: null, busy: false });
  }
  const waiting = [];

  async function acquire() {
    const free = workers.find((w) => !w.busy);
    if (free) { free.busy = true; return free; }
    return new Promise((resolve) => waiting.push(resolve));
  }
  function release(w) {
    const next = waiting.shift();
    if (next) next(w);
    else w.busy = false;
  }

  /** @param {Uint8Array} image encoded image (BMP) @param {number} psm */
  async function ocr(image, psm) {
    const w = await acquire();
    try {
      if (w.psm !== psm) {
        await w.worker.setParameters({ tessedit_pageseg_mode: String(psm) });
        w.psm = psm;
      }
      const { data } = await w.worker.recognize(image);
      return data.text;
    } finally {
      release(w);
    }
  }

  async function close() {
    await Promise.all(workers.map((w) => w.worker.terminate()));
  }

  return { ocr, close, size };
}
