// 2.0.3: every engine binary and third-party loader in engine/ has its sha256 in engine/NOTICE.txt (2.0.2 missed the
// threaded Stockfish build). ChessVision's own wrappers (aggro-worker.js, sf-worker.js) are named there but not hashed.
'use strict';
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runner, ROOT } = require('./_load');
const { test, run } = runner('notice');

test('engine/NOTICE.txt lists the sha256 of every shipped engine file', () => {
  const dir = path.join(ROOT, 'engine');
  const notice = fs.readFileSync(path.join(dir, 'NOTICE.txt'), 'utf8');
  const own = new Set(['aggro-worker.js', 'sf-worker.js', 'NOTICE.txt']);
  const files = fs.readdirSync(dir).filter((f) => !own.has(f));
  assert.ok(files.length >= 9, files.join(' '));
  const missing = files.filter((f) => !notice.includes(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')));
  assert.deepStrictEqual(missing, [], 'no sha256 in NOTICE.txt for: ' + missing.join(', '));
  for (const f of own) if (f !== 'NOTICE.txt') assert.ok(notice.includes('engine/' + f), f + ' is named in NOTICE.txt');
});

run();
