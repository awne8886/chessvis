// Wrapper worker for the UNMODIFIED Stockfish.js loader (stockfish-19-lite-single.js, byte-identical to the npm package).
// background.js compiles the .wasm once and posts the WebAssembly.Module here as the first message; this file then loads the
// loader with importScripts and makes the loader's own wasm step use that Module instead of fetching and compiling again.
//
// How, without touching the loader: it fetches "<wasm url>" (the URL comes from this worker's "#<url>,worker" hash, read by
// the loader itself) and passes the Response to WebAssembly.instantiateStreaming(response, imports). For the duration of that
// one call this file (1) answers fetch(<wasm url>) with an empty Response and (2) answers instantiateStreaming with
// WebAssembly.instantiate(module, imports). Both patches are removed again right away. If the Module cannot be used, the
// real wasm is fetched and the original instantiateStreaming runs, so the worst case is the old behaviour.
//
// First message: { type: 'sfinit', module: WebAssembly.Module | null, loader: 'stockfish-19-lite-single.js' }.
// Everything after it goes to the loader's own onmessage handler (plain UCI strings).
// License: GPL-3.0, as the rest of ChessVision.
'use strict';
(function () {
  let started = false;
  const early = [];
  self.onmessage = function (e) {
    const m = e.data;
    if (!started && m && typeof m === 'object' && m.type === 'sfinit') { started = true; start(m); return; }
    early.push(m);              // UCI before sfinit does not happen (background.js sends sfinit first); kept only so nothing is lost
  };
  function start(init) {
    self.onmessage = null;      // the loader installs its own handler only if there is none
    const wasmUrl = decodeURIComponent((self.location.hash || '#').slice(1).split(',')[0] || '');
    const module = init.module && typeof WebAssembly !== 'undefined' && init.module instanceof WebAssembly.Module ? init.module : null;
    const say = (t) => { try { postMessage('info string sf-worker: ' + t); } catch (e) { /* ignore */ } };
    if (module) {
      const origFetch = self.fetch, origInst = WebAssembly.instantiateStreaming;
      const restore = () => { self.fetch = origFetch; WebAssembly.instantiateStreaming = origInst; };
      self.fetch = function (u) {
        if (String(u) === wasmUrl && typeof Response === 'function') return Promise.resolve(new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'application/wasm' } }));
        return origFetch.apply(self, arguments);
      };
      WebAssembly.instantiateStreaming = function (response, imports) {
        restore();              // only this one call is intercepted
        return WebAssembly.instantiate(module, imports).then(
          (instance) => { say('wasm via shared module'); return { instance, module }; },
          (err) => {            // the Module could not be instantiated here: the normal way, with the real file
            say('wasm via fetch (module failed: ' + ((err && err.message) || err) + ')');
            return origFetch(wasmUrl).then((r) => origInst.call(WebAssembly, r, imports));
          });
      };
    }
    try { importScripts(init.loader || 'stockfish-19-lite-single.js'); }
    catch (err) { say('could not load the engine: ' + ((err && err.message) || err)); throw err; }
    if (!module) say('wasm via fetch (no module offered)');
    for (const m of early.splice(0)) { try { if (typeof self.onmessage === 'function') self.onmessage({ data: m }); } catch (e) { /* ignore */ } }
  }
})();
