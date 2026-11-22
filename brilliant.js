// Best-effort count of chess.com "brilliant" moves per side from the post-game review/analysis popup.
// UNTESTED AGAINST THE REAL SITE: every selector, word and hint below is a CANDIDATE, not a confirmed fact.
// If detection does not work, fix this block first. The detection itself is pure (items in, counts out) so it is
// unit-tested on fake snippets; reading the live DOM is the thin collectItems()/lookup() part at the bottom.
//
// Layer a: text / alt / title / aria-label containing the word, with an adjacent number, per side.
// Layer b: classification icons (img, svg, CSS background) whose URL, file name or class contains "brilliant", per side.
// Layer c: classification icons that layers a/b cannot name are downloaded by the background page (the manifest
// has a host permission for chess.com's image domain), drawn on a canvas, and their dominant colour is compared
// with the brilliant colour (teal). The bytes come through the extension, so the canvas is never tainted.
(function (root) {
  'use strict';
  const CV = (root.CV = root.CV || {});

  // ======================= CANDIDATES (edit here) =======================
  const BRILLIANT_CANDIDATES = {
    // Where the post-game popup might live (first visible match wins; none found = "n/a", never a page-wide scan).
    popupSelectors: [
      '[class*="game-review"]', '[class*="review-preview"]', '[class*="analysis-preview"]',
      '[class*="post-game"]', '[class*="game-over-modal"]', '[class*="game-over"]', '[class*="move-classification"]',
    ],
    words: ['brilliant'],                          // matched case-insensitively in text, alt, title and aria-label
    iconParts: ['brilliant'],                      // matched in image URLs, file names and class names
    iconTags: ['img', 'svg', 'use', 'image'],
    // Hints that say which side an item belongs to (looked for in its own and its ancestors' classes / attributes).
    sideHints: {
      white: ['white'], black: ['black'],          // colour names
      mine: ['player-bottom', 'bottom'],           // position hints: the player at the bottom is the person using the board
      opp: ['player-top', 'top'],
    },
    maxElements: 800,                              // upper bound of elements inspected in the live page
    // Layer c. The colour is a CANDIDATE too: chess.com's brilliant icon is teal, roughly #1baca6.
    colour: { ref: [27, 172, 166], tolerance: 70, minPixels: 20, minSaturation: 0.35, minBrightness: 60, maxImages: 30 },
  };
  // ======================================================================

  const lc = (s) => String(s || '').toLowerCase();
  const hasAny = (s, list) => list.some((w) => lc(s).includes(w));

  // which side an item belongs to: 'mine' | 'opp' | null (never guessed)
  function sideOf(item, myColor) {
    const hay = lc(item.cls + ' ' + item.ctx);
    const H = BRILLIANT_CANDIDATES.sideHints;
    const w = hasAny(hay, H.white), b = hasAny(hay, H.black);
    if (w !== b) return (w ? 'w' : 'b') === myColor ? 'mine' : 'opp';        // exactly one colour named
    const m = hasAny(hay, H.mine), o = hasAny(hay, H.opp);
    if (m !== o) return m ? 'mine' : 'opp';
    return null;
  }

  // First count found next to the word, else a lone number in the neighbouring text, else null.
  function adjacentCount(item) {
    const own = [item.text, item.alt, item.title, item.aria].join(' ');
    let m = /(\d+)\s*(?:x|\u00d7)?\s*brilliant/i.exec(own) || /brilliant[^\d]{0,14}(\d+)/i.exec(own);
    if (m) return Number(m[1]);
    const near = String(item.near || '').match(/\d+/g);
    return near && near.length === 1 ? Number(near[0]) : null;
  }

  // Counts from items (see itemsFromHtml / collectItems for the shape). log(line) is optional.
  function countFromItems(items, myColor, log) {
    const say = log || (() => {});
    const layers = { a: { mine: null, opp: null, found: 0 }, b: { mine: null, opp: null, found: 0 } };
    const add = (layer, side, n) => { layer[side] = (layer[side] || 0) + n; };

    for (const it of items) {
      const words = BRILLIANT_CANDIDATES.words;
      if (hasAny([it.text, it.alt, it.title, it.aria].join(' '), words)) {
        layers.a.found++;
        const n = adjacentCount(it), side = sideOf(it, myColor);
        if (n !== null && side) add(layers.a, side, n);
        else say('layer a: found "' + lc(it.text || it.alt || it.title || it.aria).slice(0, 40) + '" but ' + (n === null ? 'no count' : 'no side'));
      }
      const iconish = BRILLIANT_CANDIDATES.iconTags.includes(lc(it.tag)) || /url\(/.test(it.bg || '');
      if (iconish && hasAny([it.src, it.cls, it.alt, it.title, it.bg].join(' '), BRILLIANT_CANDIDATES.iconParts)) {
        layers.b.found++;
        const side = sideOf(it, myColor);
        const n = adjacentCount({ ...it, text: '', alt: '', title: '', aria: '' });   // a number right next to the icon
        if (side) add(layers.b, side, n !== null ? n : 1);
        else say('layer b: icon found but no side');
      }
    }
    say('layer a: ' + (layers.a.found ? layers.a.found + ' item(s), mine=' + layers.a.mine + ' opp=' + layers.a.opp : 'nothing found'));
    say('layer b: ' + (layers.b.found ? layers.b.found + ' icon(s), mine=' + layers.b.mine + ' opp=' + layers.b.opp : 'nothing found'));
    const pick = (k) => (layers.a[k] !== null ? layers.a[k] : layers.b[k]);   // cheapest layer first, per side, independently
    return { mine: pick('mine'), opp: pick('opp'), layers };
  }


  // ---- layer c: dominant colour of an icon ----
  // rgba: Uint8ClampedArray / array of r,g,b,a. Returns [r,g,b] of the most common saturated, non-dark colour, or null.
  function dominantColour(rgba) {
    const K = BRILLIANT_CANDIDATES.colour;
    const buckets = new Map();
    for (let i = 0; i + 3 < rgba.length; i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
      if (a < 128) continue;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max < K.minBrightness || (max - min) / max < K.minSaturation) continue;   // transparent, dark, white and grey are ignored
      const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
      const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      buckets.set(key, e);
    }
    let best = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    return best && best.n >= K.minPixels ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : null;
  }
  const isBrilliantColour = (rgb) => !!rgb && Math.hypot(rgb[0] - BRILLIANT_CANDIDATES.colour.ref[0], rgb[1] - BRILLIANT_CANDIDATES.colour.ref[1], rgb[2] - BRILLIANT_CANDIDATES.colour.ref[2]) <= BRILLIANT_CANDIDATES.colour.tolerance;

  const urlOf = (it) => it.src || ((/url\(["']?([^"')]+)["']?\)/.exec(it.bg || '') || [])[1]) || '';
  // Icons that layers a/b did not already recognise by name and that belong to a known side.
  function colourCandidates(items, myColor) {
    const out = [];
    for (const it of items) {
      const url = urlOf(it);
      const iconish = BRILLIANT_CANDIDATES.iconTags.includes(lc(it.tag)) || /url\(/.test(it.bg || '');
      if (!iconish || !url || hasAny([url, it.cls, it.alt, it.title], BRILLIANT_CANDIDATES.iconParts)) continue;
      const side = sideOf(it, myColor);
      if (side) out.push({ it, url, side });
    }
    return out;
  }

  // Counts brilliant-coloured icons per side. getPixels(url) -> Promise<rgba | null> (supplied by the page).
  // A side with no matching icon stays null (unknown), never 0.
  async function colourLayer(items, myColor, getPixels, log) {
    const say = log || (() => {});
    const cands = colourCandidates(items, myColor);
    const verdict = new Map();
    const res = { mine: null, opp: null, found: 0 };
    for (const c of cands) {
      if (!verdict.has(c.url)) {
        if (verdict.size >= BRILLIANT_CANDIDATES.colour.maxImages) continue;
        let ok = false;
        try { const px = await getPixels(c.url); ok = isBrilliantColour(px ? dominantColour(px) : null); } catch (e) { say('layer c: could not read ' + c.url.slice(-40)); }
        verdict.set(c.url, ok);
      }
      if (!verdict.get(c.url)) continue;
      res.found++;
      const n = adjacentCount({ ...c.it, text: '', alt: '', title: '', aria: '' });
      res[c.side] = (res[c.side] || 0) + (n !== null ? n : 1);
    }
    say('layer c: ' + cands.length + ' icon(s) checked, ' + res.found + ' brilliant-coloured, mine=' + res.mine + ' opp=' + res.opp);
    return res;
  }

  // ---- items from an HTML string (tests, and outerHTML of a popup) ----
  const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'use', 'image', 'path', 'source']);
  function itemsFromHtml(html) {
    const root = { tag: '#root', attrs: {}, kids: [], text: '', parent: null };
    let cur = root;
    const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[5] !== undefined) { cur.text += m[5].replace(/\s+/g, ' '); continue; }
      const closing = m[1] === '/', tag = m[2].toLowerCase();
      if (closing) { if (cur.parent && cur.tag === tag) cur = cur.parent; continue; }
      const attrs = {};
      String(m[3] || '').replace(/([\w:-]+)\s*=\s*"([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; return ''; });
      const node = { tag, attrs, kids: [], text: '', parent: cur };
      cur.kids.push(node);
      if (!VOID.has(tag) && !m[4]) cur = node;
    }
    const out = [];
    const fullText = (n) => (n.text + ' ' + n.kids.map(fullText).join(' ')).replace(/\s+/g, ' ').trim();
    (function walk(n, chain) {
      n.kids.forEach((k, i) => {
        const ctx = chain.join(' ');
        const sib = [k.parent.kids[i - 1], k.parent.kids[i + 1]].filter(Boolean).map(fullText).join(' ');
        out.push({
          tag: k.tag, text: k.text.trim(), alt: k.attrs.alt || '', title: k.attrs.title || '', aria: k.attrs['aria-label'] || '',
          cls: k.attrs.class || '', src: k.attrs.src || k.attrs.href || k['attrs']['xlink:href'] || '', bg: k.attrs.style || '',
          ctx, near: sib,
        });
        walk(k, chain.concat([k.attrs.class || '', k.attrs['data-side'] || '']).slice(-6));
      });
    })(root, []);
    return out;
  }

  // ---- live DOM (browser only) ----
  function collectItems(rootEl) {
    const out = [];
    const els = [rootEl, ...rootEl.querySelectorAll('*')].slice(0, BRILLIANT_CANDIDATES.maxElements);
    const clsOf = (e) => (typeof e.className === 'string' ? e.className : (e.getAttribute && e.getAttribute('class')) || '');
    for (const e of els) {
      let own = '';
      for (const c of e.childNodes) if (c.nodeType === 3) own += c.nodeValue;
      const chain = [];
      for (let p = e.parentElement, d = 0; p && d < 6; p = p.parentElement, d++) chain.push(clsOf(p) + ' ' + (p.getAttribute('data-side') || ''));
      let bg = '';
      try { bg = /clas|icon|brill/i.test(clsOf(e)) ? getComputedStyle(e).backgroundImage || '' : ''; } catch (err) { /* ignore */ }
      const sib = [e.previousElementSibling, e.nextElementSibling].filter(Boolean).map((s) => (s.textContent || '').trim().slice(0, 30)).join(' ');
      out.push({
        tag: e.tagName.toLowerCase(), text: own.replace(/\s+/g, ' ').trim(), alt: e.getAttribute('alt') || '', title: e.getAttribute('title') || '',
        aria: e.getAttribute('aria-label') || '', cls: clsOf(e),
        src: e.currentSrc || e.getAttribute('src') || e.getAttribute('href') || e.getAttribute('xlink:href') || '', bg, ctx: chain.join(' '), near: sib,
      });
    }
    return out;
  }

  // The popup's items, or null when no popup candidate is on the page.
  function findItems(doc, say) {
    let roots = [];
    for (const sel of BRILLIANT_CANDIDATES.popupSelectors) {
      const hit = [...doc.querySelectorAll(sel)].filter((e) => e.getClientRects().length);
      if (hit.length) { roots = hit; say('popup candidate matched: ' + sel); break; }
    }
    if (!roots.length) { say('no post-game popup candidate found'); return null; }
    return roots.flatMap((r) => collectItems(r));
  }

  // Layers a and b only (synchronous). Never throws; { found, mine, opp } with null when unknown.
  function lookup(doc, myColor, log) {
    const say = log || (() => {});
    try {
      const items = findItems(doc, say);
      if (!items) return { found: false, mine: null, opp: null };
      const res = countFromItems(items, myColor, say);
      return { found: true, mine: res.mine, opp: res.opp };
    } catch (e) {
      say('brilliant lookup failed: ' + (e && e.message || e));
      return { found: false, mine: null, opp: null };
    }
  }

  // Layers a, b, then c for the sides still unknown. getPixels(url) -> Promise<rgba | null>. Never throws.
  async function lookupAsync(doc, myColor, log, getPixels) {
    const say = log || (() => {});
    try {
      const items = findItems(doc, say);
      if (!items) return { found: false, mine: null, opp: null };
      const res = countFromItems(items, myColor, say);
      let { mine, opp } = res;
      if ((mine === null || opp === null) && getPixels) {
        const c = await colourLayer(items, myColor, getPixels, say);
        if (mine === null) mine = c.mine;
        if (opp === null) opp = c.opp;
      }
      return { found: true, mine, opp };
    } catch (e) {
      say('brilliant lookup failed: ' + (e && e.message || e));
      return { found: false, mine: null, opp: null };
    }
  }

  CV.brilliant = { BRILLIANT_CANDIDATES, countFromItems, itemsFromHtml, collectItems, lookup, lookupAsync, dominantColour, isBrilliantColour, colourCandidates, colourLayer };
  if (typeof module !== 'undefined' && module.exports) module.exports = CV.brilliant;
})(typeof window !== 'undefined' ? window : globalThis);
