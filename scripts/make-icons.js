#!/usr/bin/env node
'use strict';
/**
 * The panel's own mark, and every size a platform asks for.
 *
 * The three SVGs in web/icons/ are generated from here so the geometry has one
 * home: the N is three strokes rather than one outline, and the diagonal's
 * thickness is solved for rather than eyeballed - it has to come out equal to
 * the stems' width or the letter looks wrong the moment it is small.
 *
 * The PNGs beside them are rasterised from those SVGs with a headless browser.
 * Nothing here uses an SVG filter, only gradients, so what a rasteriser
 * produces is exactly what a browser would have drawn from the SVG anyway.
 *
 *   node scripts/make-icons.js      # rewrite the SVGs
 *
 * Re-rasterising the PNGs needs Playwright, which is not a dependency of the
 * panel; the committed PNGs are what ships.
 */
/*
 * The N, built as three strokes rather than one outline, so the diagonal can
 * be lit differently from the stems. Geometry is derived, not eyeballed: the
 * diagonal's perpendicular thickness has to match the stems' width or the
 * letter looks wrong at small sizes, and that is a trigonometry problem.
 */
function mark({ x0 = 128, x1 = 384, y0 = 122, y1 = 390, w = 54, gap = 0 } = {}) {
  const lx1 = x0 + w;            // inner edge of the left stem
  const rx0 = x1 - w;            // inner edge of the right stem
  const span = rx0 - lx1;        // the gap the diagonal crosses
  const H = y1 - y0;

  // vertical offset between the diagonal's two parallel edges, chosen so its
  // PERPENDICULAR thickness comes out equal to the stem width
  let V = w;
  for (let i = 0; i < 40; i++) {
    const rise = H - V;
    const theta = Math.atan2(rise, span);
    V = w / Math.cos(theta);     // converges in a handful of rounds
  }
  const slope = (H - V) / span;

  // the diagonal can be pulled in from the stems, leaving a hairline of ground
  const dx0 = lx1 + gap;
  const dx1 = rx0 - gap;
  const topAt = (x) => y0 + (x - lx1) * slope;

  const p = (n) => Number(n.toFixed(2));
  return {
    left: `M${x0} ${y0}H${lx1}V${y1}H${x0}Z`,
    right: `M${rx0} ${y0}H${x1}V${y1}H${rx0}Z`,
    diagonal: `M${p(dx0)} ${p(topAt(dx0))}L${p(dx1)} ${p(topAt(dx1))}`
      + `V${p(topAt(dx1) + V)}L${p(dx0)} ${p(topAt(dx0) + V)}Z`,
    info: { V: p(V), slope: p(slope), angle: p(Math.atan2(H - V, span) * 180 / Math.PI),
            perpendicular: p(V * Math.cos(Math.atan2(H - V, span))) }
  };
}

/*
 * One ground, and glass on it - the same idea the panel itself is built on,
 * at 512px. Nothing here uses an SVG filter: filters rasterise differently
 * between engines and this file has to come out identical wherever it is
 * turned into a PNG. Every soft edge is a gradient stop instead.
 */
function icon({ scale = 1, radius = 112, bleed = false, gap = 6, dots = true, s1 = 0.30, s2 = 0.15, edge = 0.22 } = {}) {
  const S = 512;
  const c = S / 2;
  // the mark, scaled about the centre - a maskable icon needs it well inside
  const box = { x0: 128, x1: 384, y0: 122, y1: 390, w: 54, gap };
  const k = (v) => c + (v - c) * scale;
  const m = mark({ x0: k(box.x0), x1: k(box.x1), y0: k(box.y0), y1: k(box.y1), w: box.w * scale, gap: gap * scale });

  const shape = bleed
    ? `<rect width="${S}" height="${S}"/>`
    : `<rect width="${S}" height="${S}" rx="${radius}" ry="${radius}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="NexV">
  <title>NexV</title>
  <defs>
    <!-- graphite, never black: black leaves nothing for the glass to catch -->
    <linearGradient id="ground" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#26282f"/>
      <stop offset="0.55" stop-color="#1b1c21"/>
      <stop offset="1" stop-color="#131419"/>
    </linearGradient>

    <!-- the one light that drifts across the panel's own background, held still -->
    <radialGradient id="glow" cx="0.28" cy="0.2" r="0.78">
      <stop offset="0" stop-color="#dfe3ec" stop-opacity="0.30"/>
      <stop offset="0.45" stop-color="#dfe3ec" stop-opacity="0.09"/>
      <stop offset="1" stop-color="#dfe3ec" stop-opacity="0"/>
    </radialGradient>

    <!-- a second, cooler light low on the right, so the ground is not lit flat -->
    <radialGradient id="glow2" cx="0.82" cy="0.88" r="0.6">
      <stop offset="0" stop-color="#aeb4c2" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#aeb4c2" stop-opacity="0"/>
    </radialGradient>

    <!-- the stems: glass, lit from the top left -->
    <linearGradient id="stem" x1="0.1" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${s1}"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="${s2}"/>
    </linearGradient>

    <!-- the diagonal: the one solid, bright element, so the letter has a spine -->
    <linearGradient id="blade" x1="0.05" y1="0" x2="0.95" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.45" stop-color="#e2e6ee"/>
      <stop offset="1" stop-color="#9aa0ac"/>
    </linearGradient>

    <!-- the highlight along the top of a pane, which is what sells it as glass -->
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>

    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="13" cy="13" r="1.5" fill="#ffffff" opacity="0.07"/>
    </pattern>

    <clipPath id="clip">${shape}</clipPath>
  </defs>

  <g clip-path="url(#clip)">
    ${shape.replace('<rect', '<rect fill="url(#ground)"')}
    ${dots ? `<rect width="${S}" height="${S}" fill="url(#dots)"/>` : ''}
    <rect width="${S}" height="${S}" fill="url(#glow)"/>
    <rect width="${S}" height="${S}" fill="url(#glow2)"/>
    <rect width="${S}" height="${S / 2}" fill="url(#sheen)"/>

    <!-- the letter, sitting on the ground rather than cut out of it -->
    <g>
      <path d="${m.left}" fill="url(#stem)"/>
      <path d="${m.right}" fill="url(#stem)"/>
      <path d="${m.left}" fill="none" stroke="#ffffff" stroke-opacity="${edge}" stroke-width="${(2 * scale).toFixed(2)}"/>
      <path d="${m.right}" fill="none" stroke="#ffffff" stroke-opacity="${edge}" stroke-width="${(2 * scale).toFixed(2)}"/>
      <path d="${m.diagonal}" fill="url(#blade)"/>
    </g>
  </g>
${bleed ? '' : `
  <!-- a hairline you can actually see, just inside the edge -->
  <rect x="1.25" y="1.25" width="${S - 2.5}" height="${S - 2.5}" rx="${radius - 1.25}" ry="${radius - 1.25}"
        fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="2.5"/>`}
</svg>
`;
}

/** One flat path of the whole letter, for a pinned tab and anywhere else that wants a stencil. */
function mono() {
  const m = mark({ gap: 0 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>NexV</title>
  <path d="${m.left} ${m.right} ${m.diagonal}" fill="black"/>
</svg>
`;
}

/* Written to web/icons/. The PNGs are rasterised by Chromium via Playwright -
   see the header of this file - and the SVGs are the source of truth. */
const OPTS = { s1: 0.62, s2: 0.40, edge: 0.38 };
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'web', 'icons');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.svg'), icon(OPTS));
  fs.writeFileSync(path.join(dir, 'icon-maskable.svg'), icon({ ...OPTS, scale: 0.70, bleed: true }));
  fs.writeFileSync(path.join(dir, 'icon-mono.svg'), mono());
  console.log('wrote the three SVGs to web/icons/');
  console.log('the PNGs beside them are rasterised from icon.svg and icon-maskable.svg');
}

module.exports = { icon, mono, mark, OPTS };
