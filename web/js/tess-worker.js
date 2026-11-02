// Tesseract.js worker wrapper. Some hosts (claude.ai Artifacts) serve only common file types, so the
// language files ship as base64 text: answer Tesseract's request for "<lang>.traineddata.gz" from
// "<lang>.traineddata.gz.txt", then run the real worker unchanged.
const realFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (/\.traineddata\.gz$/.test(url)) {
    const res = await realFetch(`${url}.txt`, init);
    if (!res.ok) return res;
    const bin = atob((await res.text()).trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { status: 200 });
  }
  return realFetch(input, init);
};
importScripts(new URL("../vendor/tesseract/worker.min.js", self.location.href).href);
