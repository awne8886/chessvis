const api = typeof browser !== 'undefined' ? browser : chrome;

(async () => {
  const box = document.getElementById('enabled');
  const { enabled } = await api.storage.local.get({ enabled: CV.DEFAULTS.enabled });
  box.checked = !!enabled;
  box.addEventListener('change', () => api.storage.local.set({ enabled: box.checked }));
  api.storage.onChanged.addListener((c) => { if (c.enabled) box.checked = !!c.enabled.newValue; });
})();
