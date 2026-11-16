const api = typeof browser !== 'undefined' ? browser : chrome;
const DEFAULTS = { enabled: false, engine: 'aggro', depth: 10, thinkMs: 1000, minDelay: 300, maxDelay: 800 };
const $ = (id) => document.getElementById(id);

function render(s) {
  $('enabled').checked = s.enabled;
  $('engine').value = s.engine;
  $('thinkRow').classList.toggle('hidden', s.engine !== 'aggro');
  $('depthRow').classList.toggle('hidden', s.engine !== 'stockfish');
  $('thinkMs').value = s.thinkMs;   $('thinkVal').textContent = (s.thinkMs / 1000).toFixed(1) + ' s';
  $('depth').value = s.depth;       $('depthVal').textContent = s.depth;
  $('minDelay').value = s.minDelay; $('minVal').textContent = s.minDelay + ' ms';
  $('maxDelay').value = s.maxDelay; $('maxVal').textContent = s.maxDelay + ' ms';
}

(async () => {
  const s = await api.storage.local.get(DEFAULTS);
  render(s);

  $('enabled').addEventListener('change', (e) =>
    api.storage.local.set({ enabled: e.target.checked }));

  $('engine').addEventListener('change', (e) => {
    s.engine = e.target.value; render(s);
    api.storage.local.set({ engine: s.engine });
  });

  $('thinkMs').addEventListener('input', (e) => {
    s.thinkMs = +e.target.value; render(s);
    api.storage.local.set({ thinkMs: s.thinkMs });
  });

  $('depth').addEventListener('input', (e) => {
    s.depth = +e.target.value; render(s);
    api.storage.local.set({ depth: s.depth });
  });

  $('minDelay').addEventListener('input', (e) => {
    s.minDelay = +e.target.value;
    if (s.minDelay > s.maxDelay) s.maxDelay = s.minDelay;
    render(s);
    api.storage.local.set({ minDelay: s.minDelay, maxDelay: s.maxDelay });
  });

  $('maxDelay').addEventListener('input', (e) => {
    s.maxDelay = +e.target.value;
    if (s.maxDelay < s.minDelay) s.minDelay = s.maxDelay;
    render(s);
    api.storage.local.set({ minDelay: s.minDelay, maxDelay: s.maxDelay });
  });
})();
