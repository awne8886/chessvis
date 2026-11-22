// Test helper: loads the pure modules the way the extension does (each attaches itself to globalThis.CV).
// chessmini.js first: settings.js and boardstate.js use CV.chess at call time.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
function load(...files) {
  for (const f of ['chessmini.js', 'settings.js', ...files]) require(path.join(ROOT, f));
  return globalThis.CV;
}
// A tiny runner: test('name', fn) collects, run() executes in order (async allowed) and exits non-zero on a failure.
function runner(title) {
  const tests = [];
  return {
    test: (name, fn) => tests.push({ name, fn }),
    async run() {
      let pass = 0;
      for (const t of tests) {
        try { await t.fn(); pass++; }
        catch (e) { console.error('FAIL ' + title + ' > ' + t.name + '\n', e); process.exitCode = 1; }
      }
      console.log(title + ': ' + pass + '/' + tests.length + ' passed');
      if (pass !== tests.length) process.exit(1);
    },
  };
}
module.exports = { load, runner, ROOT };
