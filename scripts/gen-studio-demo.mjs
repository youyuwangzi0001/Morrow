/**
 * 生成创作台随包样例画面（原创 SVG 插画 → PNG）。
 * 仅开发期使用；运行需要 Playwright 的 Chromium。
 *
 * 用法：node scripts/gen-studio-demo.mjs
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const outDir = join(root, 'resources', 'studio-demo')
mkdirSync(outDir, { recursive: true })

const W = 1792
const H = 1024

let seed = 20261026
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0xffffffff
}

function rain({ count = 260, color = 'rgba(200,220,230,.22)', width = 1, angle = 14, y1 = 0, y2 = H, opacity = 1 } = {}) {
  let out = `<g opacity="${opacity}" transform="rotate(${angle} ${W / 2} ${H / 2})">`
  for (let i = 0; i < count; i += 1) {
    const x = rnd() * (W + 500) - 200
    const y = y1 + rnd() * (y2 - y1)
    const len = 18 + rnd() * 70
    out += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x - len * 0.16).toFixed(1)}" y2="${(y + len).toFixed(1)}" stroke="${color}" stroke-width="${(width * (0.5 + rnd())).toFixed(2)}"/>`
  }
  return `${out}</g>`
}

function upwardRain({ count = 180, color = 'rgba(228,206,158,.30)' } = {}) {
  let out = '<g>'
  for (let i = 0; i < count; i += 1) {
    const x = rnd() * W
    const y = rnd() * H
    const len = 24 + rnd() * 90
    out += `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + len * 0.12).toFixed(1)}" y2="${(y - len).toFixed(1)}" stroke="${color}" stroke-width="${(0.6 + rnd()).toFixed(2)}"/>`
  }
  return `${out}</g>`
}

function bokeh({ count = 26, color = 'rgba(228,206,158,.22)', min = 8, max = 68, blur = 12 } = {}) {
  let out = `<g filter="url(#blur-${blur})">`
  for (let i = 0; i < count; i += 1) {
    out += `<circle cx="${(rnd() * W).toFixed(0)}" cy="${(rnd() * H * 0.7).toFixed(0)}" r="${(min + rnd() * (max - min)).toFixed(0)}" fill="${color}" opacity="${(0.12 + rnd() * 0.4).toFixed(2)}"/>`
  }
  return `${out}</g>`
}

function grain(opacity = 0.32) {
  return `<rect width="${W}" height="${H}" filter="url(#grain)" opacity="${opacity}" style="mix-blend-mode:overlay"/>`
}

function vignette(strength = 0.8) {
  return `<rect width="${W}" height="${H}" fill="url(#vignette)" opacity="${strength}"/>`
}

function lamp(x, y, rx = 220, ry = 300, color = '#e7c681') {
  return `<g filter="url(#blur-40)"><ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${color}" opacity=".2"/><ellipse cx="${x}" cy="${y}" rx="${rx * 0.5}" ry="${ry * 0.55}" fill="${color}" opacity=".3"/></g>`
}

function umbrella({ x, y, scale = 1, rotate = 0, open = true, fill = '#0b0f12', stroke = '#c8ae7d', opacity = 1, glow = 0 } = {}) {
  const canopy = open
    ? `<path d="M -240 0 C -230 -170 -130 -260 0 -262 C 130 -260 230 -170 240 0 C 200 -34 168 -34 132 0 C 96 -34 64 -34 28 0 C -8 -34 -40 -34 -76 0 C -112 -34 -144 -34 -180 0 C -208 -28 -224 -28 -240 0 Z" fill="${fill}" stroke="${stroke}" stroke-width="2.4"/>`
    : `<path d="M -34 -14 C -44 -140 -32 -242 -18 -288 L 18 -288 C 32 -242 44 -140 34 -14 C 20 18 -20 18 -34 -14 Z" fill="${fill}" stroke="${stroke}" stroke-width="2.2"/>`
  const ribs = open
    ? `<g stroke="${stroke}" stroke-width="1" opacity=".38">
        <path d="M0 -254 L0 0"/><path d="M-72 -246 L-124 0"/><path d="M72 -246 L124 0"/>
        <path d="M-142 -212 L-206 0"/><path d="M142 -212 L206 0"/>
      </g>`
    : `<g stroke="${stroke}" stroke-width=".8" opacity=".3">
        <path d="M-12 -280 L-8 0"/><path d="M0 -286 L0 0"/><path d="M12 -280 L8 0"/>
      </g>`
  const handle = open
    ? `<path d="M0 0 L0 150 C0 182 24 196 46 178" fill="none" stroke="${stroke}" stroke-width="4" opacity=".7"/>`
    : `<path d="M0 18 L0 200 C0 230 28 240 48 220" fill="none" stroke="${stroke}" stroke-width="4" opacity=".8"/>`
  const glowEl = glow ? `<ellipse cx="0" cy="-110" rx="250" ry="190" fill="${stroke}" opacity="${glow}" filter="url(#blur-40)"/>` : ''
  return `<g transform="translate(${x} ${y}) rotate(${rotate}) scale(${scale})" opacity="${opacity}">${glowEl}${canopy}${ribs}${handle}</g>`
}

function woman({ x, y, scale = 1, rim = '#c8ae7d', rimOpacity = 0.6, facing = 1, coat = '#090c0f' } = {}) {
  return `<g transform="translate(${x} ${y}) scale(${scale * facing} ${scale})">
    <path d="M -44 -210 C -58 -178 -54 -138 -28 -118 C -48 -106 -60 -86 -62 -60 C -74 -20 -78 44 -70 130 L 82 130 C 78 62 70 -6 48 -48 C 34 -80 20 -102 0 -116 C 28 -138 38 -174 20 -204 C 8 -226 -22 -234 -44 -210 Z" fill="${coat}"/>
    <path d="M -40 -213 C -30 -242 12 -246 26 -218 C 38 -192 26 -144 0 -120 C -26 -138 -48 -174 -40 -213 Z" fill="#0d1115"/>
    <path d="M -36 -208 C -26 -232 8 -236 22 -210" fill="none" stroke="${rim}" stroke-width="2" opacity="${rimOpacity}"/>
    <path d="M 20 -190 C 30 -164 28 -138 2 -118" fill="none" stroke="${rim}" stroke-width="1.8" opacity="${rimOpacity * 0.7}"/>
    <path d="M 48 -48 C 58 -4 66 60 74 126" fill="none" stroke="${rim}" stroke-width="2" opacity="${rimOpacity * 0.8}"/>
    <path d="M -58 10 C -50 -24 -24 -46 0 -52 L 8 130 L -66 130 C -72 96 -70 48 -58 10 Z" fill="#12171a"/>
    <path d="M 36 -52 L 18 10 L 50 122" fill="none" stroke="#b99a61" stroke-width="1.4" opacity=".4"/>
  </g>`
}

function man({ x, y, scale = 1, rim = '#7fa292', facing = -1 } = {}) {
  return `<g transform="translate(${x} ${y}) scale(${scale * facing} ${scale})">
    <path d="M -40 -238 C -54 -206 -48 -160 -18 -140 C -30 -116 -26 -82 -12 -58 C -52 -20 -68 54 -62 142 L 72 142 C 70 62 56 -12 24 -44 C 8 -88 4 -116 10 -142 C 38 -168 40 -216 18 -240 C 2 -258 -24 -256 -40 -238 Z" fill="#080b0d"/>
    <path d="M -36 -236 C -14 -254 18 -250 26 -224" fill="none" stroke="${rim}" stroke-width="1.6" opacity=".5"/>
    <path d="M 22 -142 C 32 -110 26 -70 6 -44" fill="none" stroke="${rim}" stroke-width="1.4" opacity=".5"/>
    <path d="M 26 -40 C 48 -8 60 56 68 138" fill="none" stroke="${rim}" stroke-width="1.8" opacity=".45"/>
    <path d="M -32 -70 L 0 -52 L 18 138 L -54 138 C -62 52 -52 -18 -32 -70 Z" fill="#0f1316"/>
  </g>`
}

function grandmother({ x, y, scale = 1 } = {}) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" opacity=".78" filter="url(#blur-2)">
    <ellipse cx="0" cy="-180" rx="52" ry="62" fill="#1a1712"/>
    <path d="M -58 -196 C -74 -250 -20 -286 26 -262 C 66 -242 62 -190 44 -170 C 28 -198 -14 -214 -58 -196 Z" fill="#201b13"/>
    <circle cx="48" cy="-232" r="26" fill="#201b13"/>
    <path d="M -84 -132 C -54 -166 50 -170 82 -128 C 106 -96 108 10 96 148 L -98 148 C -112 20 -108 -98 -84 -132 Z" fill="#17130e"/>
    <path d="M -72 -120 C -40 -142 40 -144 70 -118" fill="none" stroke="#c8ae7d" stroke-width="2" opacity=".55"/>
  </g>`
}

function crane(x, y, scale = 1, color = '#e4ce9e', opacity = 0.9) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" opacity="${opacity}">
    <path d="M0 0 L68 -34 L54 18 L20 28 L58 58 L4 42 L-34 78 L-22 32 L-62 18 Z" fill="${color}" opacity=".9"/>
    <path d="M0 0 L54 18 L20 28 L58 58" fill="none" stroke="#f4efe4" stroke-width="1" opacity=".5"/>
    <path d="M-34 78 L-58 102 L-26 54" fill="none" stroke="${color}" stroke-width="2"/>
  </g>`
}

function room({ warm = '#e7c681', dark = '#0b0d10' } = {}) {
  return `<g>
    <rect width="${W}" height="${H}" fill="#080b0e"/>
    <path d="M0 700 LW 610 L${W} 1024 L0 1024 Z" fill="#0b0f12"/>
    <path d="M0 610 L${W} 500 L${W} 660 L0 770 Z" fill="#10151a" opacity=".5"/>
    <path d="M250 0 L250 700 M1540 0 L1540 610" stroke="#c8ae7d" stroke-width="1" opacity=".12"/>
    <path d="M0 760 L${W} 660" stroke="#c8ae7d" stroke-width="1" opacity=".08"/>
    ${lamp(1390, 220, 300, 380, warm)}
  </g>`.replaceAll('LW', String(W))
}

function windowWall({ x = 260, y = 120, w = 700, h = 600 }) {
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#05080b" stroke="#c8ae7d" stroke-width="3" opacity=".9"/>
    <rect x="${x + 12}" y="${y + 12}" width="${w - 24}" height="${h - 24}" fill="url(#windowSky)"/>
    <g clip-path="url(#windowClip)">
      ${rain({ count: 180, color: 'rgba(200,220,230,.22)' })}
      ${bokeh({ count: 14, color: 'rgba(200,174,125,.26)', max: 46 })}
    </g>
    <path d="M${x + w / 2} ${y} L${x + w / 2} ${y + h} M${x} ${y + h / 2} L${x + w} ${y + h / 2}" stroke="#c8ae7d" stroke-width="3" opacity=".55"/>
  </g>`
}

function shopShelves({ x = 1380, y = 110 } = {}) {
  let out = `<g opacity=".8">`
  for (let i = 0; i < 4; i += 1) {
    out += `<path d="M${x} ${y + i * 122} L${W - 70} ${y + i * 122 - 12}" stroke="#c8ae7d" stroke-width="1" opacity=".25"/>`
    for (let j = 0; j < 6; j += 1) {
      out += `<path d="M${x + 34 + j * 56} ${y + i * 122 - 6} l-5 -62 q3 -10 10 0 l5 62" fill="#090c0f" stroke="#c8ae7d" stroke-width=".8" opacity=".55"/>`
    }
  }
  return `${out}</g>`
}

function defs(w = W, h = H) {
  return `<defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a1016"/><stop offset=".55" stop-color="#101b20"/><stop offset="1" stop-color="#080b0e"/>
    </linearGradient>
    <linearGradient id="windowSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#132a30"/><stop offset=".6" stop-color="#0d171c"/><stop offset="1" stop-color="#090d10"/>
    </linearGradient>
    <radialGradient id="vignette" cx=".5" cy=".48" r=".75">
      <stop offset=".42" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".72"/>
    </radialGradient>
    <radialGradient id="warmGlow" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#e4ce9e" stop-opacity=".55"/><stop offset="1" stop-color="#e4ce9e" stop-opacity="0"/>
    </radialGradient>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".5"/></feComponentTransfer></filter>
    <filter id="blur-2"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="blur-6"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="blur-12"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="blur-40"><feGaussianBlur stdDeviation="40"/></filter>
    <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="windowClip"><rect x="272" y="132" width="676" height="576" rx="1"/></clipPath>
    <linearGradient id="thread" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c2795f"/><stop offset=".5" stop-color="#e4ce9e"/><stop offset="1" stop-color="#c2795f"/></linearGradient>
  </defs>`
}

function frame(content, w = W, h = H, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#080b0e;width:${w}px;height:${h}px;overflow:hidden}
    svg{display:block;width:${w}px;height:${h}px}
  </style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs(w, h)}${content}${extra}</svg></body></html>`
}

const scenes = {}

/* 01 雨夜伞铺 */
scenes['drama-01'] = frame(`
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${bokeh({ count: 34, color: 'rgba(200,220,230,.12)', max: 38, blur: 12 })}
  <path d="M0 600 C420 540 1180 560 1792 520 L1792 1024 L0 1024 Z" fill="#080b0e"/>
  <rect x="470" y="270" width="880" height="570" fill="#14120d" stroke="#c8ae7d" stroke-width="2" opacity=".95"/>
  ${windowWall({ x: 520, y: 320, w: 700, h: 430 })}
  <path d="M520 780 L1220 780 L1270 1024 L470 1024 Z" fill="#0c0f11"/>
  <rect x="1238" y="150" width="320" height="760" fill="#0d1114" opacity=".92"/>
  ${shopShelves({ x: 1290, y: 220 })}
  ${lamp(1010, 590, 330, 260)}
  ${woman({ x: 840, y: 700, scale: 1.35, rimOpacity: 0.55, facing: -1 })}
  ${umbrella({ x: 690, y: 430, scale: 1.15, rotate: -14, open: false, fill: '#070a0c', stroke: '#b99a61', glow: 0.08 })}
  ${rain({ count: 260, color: 'rgba(200,220,230,.18)' })}
  ${rain({ count: 60, color: 'rgba(228,206,158,.16)', width: 1.5 })}
  ${vignette(0.7)}${grain(0.28)}
`)

/* 02 伞骨倒转 */
scenes['drama-02'] = frame(`
  <rect width="${W}" height="${H}" fill="#06080a"/>
  ${lamp(1280, 240, 420, 420)}
  <g transform="translate(900 540) rotate(-10)">
    ${umbrella({ x: 0, y: 0, scale: 2.9, rotate: 0, open: true, fill: '#11100d', stroke: '#c8ae7d', opacity: 0.9, glow: 0.1 })}
    <g stroke="#e4ce9e" stroke-width="1" opacity=".22">
      <path d="M-490 -14 L-340 -300"/><path d="M-280 -10 L-180 -340"/><path d="M-80 -8 L-20 -350"/>
      <path d="M120 -10 L160 -335"/><path d="M330 -16 L380 -300"/>
    </g>
    <path d="M-500 20 C -300 90 260 20 470 -50" fill="none" stroke="url(#thread)" stroke-width="3.4" filter="url(#glow)" opacity=".9"/>
  </g>
  <g fill="#0a0d0f">
    <path d="M180 700 C 300 560 430 520 540 610 C 620 680 640 820 560 940 L180 1024 Z"/>
  </g>
  <path d="M250 690 C 330 620 390 610 455 650" fill="none" stroke="#c8ae7d" stroke-width="2" opacity=".35"/>
  <rect width="${W}" height="${H}" fill="url(#vignette)" opacity=".6"/>
  ${bokeh({ count: 20, color: 'rgba(228,206,158,.2)', max: 26, blur: 6 })}
  ${rain({ count: 90, color: 'rgba(228,206,158,.12)', width: 1.2 })}
  ${grain(0.34)}
`)

/* 03 少年出现 */
scenes['drama-03'] = frame(`
  <rect width="${W}" height="${H}" fill="#070a0c"/>
  <rect x="0" y="0" width="740" height="${H}" fill="#1a140c"/>
  ${lamp(330, 420, 420, 520)}
  <rect x="700" y="120" width="1092" height="790" fill="#06090b" stroke="#c8ae7d" stroke-width="2"/>
  ${windowWall({ x: 760, y: 150, w: 900, h: 690 })}
  <path d="M700 910 L1792 890 L1792 1024 L700 1024 Z" fill="#080b0d"/>
  ${woman({ x: 540, y: 690, scale: 1.25, facing: 1, rimOpacity: 0.5 })}
  ${man({ x: 1180, y: 650, scale: 1.4, facing: -1, rim: '#c8ae7d' })}
  ${umbrella({ x: 1160, y: 420, scale: 1.05, rotate: 12, open: true, fill: '#050708', stroke: '#c8ae7d', glow: 0.06 })}
  ${rain({ count: 230, color: 'rgba(200,220,230,.16)' })}
  ${bokeh({ count: 18, color: 'rgba(228,206,158,.18)', max: 34 })}
  ${vignette(0.66)}${grain(0.3)}
`)

/* 04 第一次修伞 */
scenes['drama-04'] = frame(`
  <rect width="${W}" height="${H}" fill="#0a0b0b"/>
  ${lamp(980, 210, 560, 470)}
  <path d="M0 760 C 500 700 1300 720 1792 680 L1792 1024 L0 1024 Z" fill="#15110c"/>
  <path d="M0 780 L1792 700" stroke="#c8ae7d" stroke-width="1" opacity=".18"/>
  <g transform="translate(1020 630) rotate(-12)">
    ${umbrella({ x: 0, y: 0, scale: 1.8, open: true, fill: '#0a0c0d', stroke: '#c8ae7d', opacity: 0.92 })}
    <g stroke="#7fa292" stroke-width="2" opacity=".35">
      <path d="M-260 10 L-180 130"/><path d="M-80 18 L-40 150"/><path d="M120 10 L90 140"/>
    </g>
    <path d="M-300 -30 C -180 -80 200 -80 340 -10" fill="none" stroke="url(#thread)" stroke-width="2.2" opacity=".7"/>
  </g>
  <g fill="#090b0c">
    <path d="M260 760 C 400 620 520 600 620 680 C 710 750 720 880 660 1024 L260 1024 Z"/>
    <path d="M720 660 C 810 590 930 620 980 720 C 1020 800 960 940 880 1024 L700 1024 Z"/>
  </g>
  <g stroke="#c8ae7d" stroke-width="1.6" opacity=".35" fill="none">
    <path d="M340 760 C 420 700 470 680 520 700"/><path d="M900 710 C 850 760 820 830 840 900"/>
  </g>
  <g fill="#c8ae7d" opacity=".55">
    <circle cx="700" cy="800" r="3"/><circle cx="730" cy="830" r="2"/><circle cx="760" cy="785" r="2.4"/>
    <path d="M780 900 l30 -16 -10 34 z"/>
  </g>
  ${bokeh({ count: 22, color: 'rgba(228,206,158,.2)', max: 30 })}
  ${vignette(0.6)}${grain(0.3)}
`)

/* 05 红线 */
scenes['drama-05'] = frame(`
  <rect width="${W}" height="${H}" fill="#07090b"/>
  ${lamp(1300, 310, 480, 450)}
  <g transform="translate(870 520) rotate(-16)">
    <path d="M-620 -140 C -460 -400 460 -420 620 -120 C 430 30 280 70 100 90 C -120 100 -430 20 -620 -140 Z" fill="#10100d" stroke="#c8ae7d" stroke-width="1.6" opacity=".95"/>
    <g stroke="#c8ae7d" stroke-width=".8" opacity=".2">
      <path d="M-580 -120 L-100 80"/><path d="M-340 -300 L-40 80"/><path d="M0 -390 L20 82"/><path d="M360 -330 L70 82"/><path d="M580 -150 L120 86"/>
    </g>
    <path d="M-570 -60 C -330 20 220 -10 540 -120" fill="none" stroke="url(#thread)" stroke-width="4" filter="url(#glow)" opacity=".95"/>
    <path d="M-240 30 C -80 90 140 70 330 -10" fill="none" stroke="#c2795f" stroke-width="1.6" opacity=".65"/>
  </g>
  <g fill="#080a0c">
    <path d="M250 750 C 360 610 470 580 560 660 C 640 730 650 880 600 1024 L250 1024 Z"/>
    <path d="M600 700 C 650 630 730 620 780 690 C 810 760 790 880 750 1024 L580 1024 Z"/>
  </g>
  <path d="M510 780 C 560 730 590 710 630 700" stroke="#c8ae7d" stroke-width="2" opacity=".3" fill="none"/>
  ${bokeh({ count: 16, color: 'rgba(194,121,95,.22)', max: 22, blur: 6 })}
  ${vignette(0.65)}${grain(0.32)}
`)

/* 06 外婆的声音 */
scenes['drama-06'] = frame(`
  <rect width="${W}" height="${H}" fill="#0a0907"/>
  <ellipse cx="900" cy="430" rx="620" ry="480" fill="url(#warmGlow)" opacity=".65"/>
  <g filter="url(#blur-6)" opacity=".8">
    ${grandmother({ x: 1080, y: 640, scale: 1.55 })}
  </g>
  ${lamp(1110, 400, 440, 380, '#e4ce9e')}
  <path d="M0 820 C 420 760 1200 780 1792 720 L1792 1024 L0 1024 Z" fill="#0e0c08"/>
  <g transform="translate(740 560) rotate(8)">
    <path d="M-420 -40 C -300 -280 360 -300 460 -20 C 300 100 40 120 -420 -40 Z" fill="#0d0c09" opacity=".5" stroke="#c8ae7d" stroke-width="1" />
    <path d="M-380 0 C -260 50 240 30 410 -40" fill="none" stroke="#e4ce9e" stroke-width="2" opacity=".25"/>
  </g>
  ${umbrella({ x: 620, y: 500, scale: 1.35, rotate: -22, open: false, fill: '#080a09', stroke: '#c8ae7d', opacity: 0.55, glow: 0.08 })}
  ${woman({ x: 760, y: 900, scale: 1.15, facing: 1, rimOpacity: 0.3 })}
  ${crane(430, 520, 1.1, '#e4ce9e', 0.55)}
  ${crane(1340, 610, 0.8, '#e4ce9e', 0.4)}
  ${upwardRain({ count: 60, color: 'rgba(228,206,158,.16)' })}
  ${bokeh({ count: 30, color: 'rgba(228,206,158,.2)', max: 22, blur: 6 })}
  ${vignette(0.62)}${grain(0.3)}
`)

/* 07 雨中的纸鹤 / 时间倒流 */
scenes['drama-07'] = frame(`
  <rect width="${W}" height="${H}" fill="#071016"/>
  <ellipse cx="900" cy="300" rx="700" ry="430" fill="#0d2b31" opacity=".8"/>
  ${bokeh({ count: 30, color: 'rgba(127,162,146,.26)', max: 46 })}
  <g transform="translate(900 470) rotate(0)">
    <circle cx="0" cy="0" r="300" fill="none" stroke="#e4ce9e" stroke-width="1.4" opacity=".3"/>
    <circle cx="0" cy="0" r="248" fill="none" stroke="#e4ce9e" stroke-width=".8" opacity=".18" stroke-dasharray="3 14"/>
    <g stroke="#e4ce9e" stroke-width="1.4" opacity=".35">
      <path d="M0 -300 L0 -280"/><path d="M300 0 L280 0"/><path d="M0 300 L0 280"/><path d="M-300 0 L-280 0"/>
    </g>
  </g>
  ${upwardRain({ count: 220, color: 'rgba(228,206,158,.3)' })}
  ${woman({ x: 780, y: 830, scale: 1.5, facing: -1, rimOpacity: 0.55 })}
  ${crane(1120, 240, 2.3, '#e4ce9e', 0.9)}
  ${umbrella({ x: 990, y: 540, scale: 1.1, rotate: 16, open: true, fill: '#061012', stroke: '#7fa292', opacity: 0.6, glow: 0.08 })}
  <path d="M0 880 C 500 820 1200 850 1792 800 L1792 1024 L0 1024 Z" fill="#070b0d"/>
  ${vignette(0.66)}${grain(0.28)}
`)

/* 08 每周三的秘密 */
scenes['drama-08'] = frame(`
  <rect width="${W}" height="${H}" fill="#080b0d"/>
  ${lamp(450, 320, 420, 460)}
  ${lamp(1320, 280, 320, 380, '#7fa292')}
  <rect x="0" y="0" width="760" height="${H}" fill="#14110c" opacity=".7"/>
  <rect x="760" y="120" width="1032" height="690" fill="#05090b" stroke="#c8ae7d" stroke-width="1.5" opacity=".9"/>
  ${windowWall({ x: 810, y: 160, w: 900, h: 610 })}
  <path d="M760 910 L1792 870 L1792 1024 L760 1024 Z" fill="#070a0c"/>
  ${woman({ x: 600, y: 730, scale: 1.3, facing: 1, rimOpacity: 0.55 })}
  ${man({ x: 1040, y: 700, scale: 1.36, facing: -1, rim: '#c8ae7d' })}
  ${umbrella({ x: 1060, y: 490, scale: 0.9, rotate: 10, open: true, fill: '#050708', stroke: '#c8ae7d', opacity: 0.55 })}
  <path d="M710 850 L930 800" stroke="#c8ae7d" stroke-width="1" opacity=".2" stroke-dasharray="3 8"/>
  ${rain({ count: 160, color: 'rgba(200,220,230,.12)' })}
  ${bokeh({ count: 18, color: 'rgba(127,162,146,.2)', max: 26 })}
  ${vignette(0.66)}${grain(0.3)}
`)

/* 09 记忆变暗 */
const portrait9 = `
  <rect width="${W}" height="${H}" fill="#07080a"/>
  <ellipse cx="820" cy="480" rx="430" ry="520" fill="#16130d" opacity=".9"/>
  <g transform="translate(880 980) scale(4.4)" opacity=".9">
    <path d="M -44 -210 C -58 -178 -54 -138 -28 -118 C -48 -106 -60 -86 -62 -60 C -74 -20 -78 44 -70 130 L 82 130 C 78 62 70 -6 48 -48 C 34 -80 20 -102 0 -116 C 28 -138 38 -174 20 -204 C 8 -226 -22 -234 -44 -210 Z" fill="#0c0e10"/>
    <path d="M -40 -213 C -30 -242 12 -246 26 -218 C 38 -192 26 -144 0 -120 C -26 -138 -48 -174 -40 -213 Z" fill="#101316"/>
    <path d="M -36 -208 C -26 -232 8 -236 22 -210" fill="none" stroke="#c8ae7d" stroke-width=".6" opacity=".65"/>
    <path d="M 20 -190 C 30 -164 28 -138 2 -118" fill="none" stroke="#c8ae7d" stroke-width=".5" opacity=".45"/>
  </g>
  <g transform="translate(1010 470)">
    <path d="M-46 0 C -34 -18 26 -22 48 0 C 32 10 -30 12 -46 0 Z" fill="#1b1711"/>
    <circle cx="4" cy="-2" r="11" fill="#0a0c0d"/>
    <circle cx="2" cy="-3" r="3.4" fill="#c8ae7d" opacity=".8"/>
    <path d="M-40 26 C -10 42 28 36 46 20" stroke="#c8ae7d" stroke-width="2" opacity=".35" fill="none"/>
  </g>
  ${umbrella({ x: 870, y: 170, scale: 0.8, rotate: -6, open: true, fill: '#080a0c', stroke: '#7fa292', opacity: 0.22 })}
  ${rain({ count: 100, color: 'rgba(200,220,230,.1)' })}
  ${bokeh({ count: 26, color: 'rgba(194,121,95,.18)', max: 30 })}
  <path d="M400 820 C 700 760 1050 780 1400 720" stroke="#c2795f" stroke-width="2" opacity=".35" fill="none" filter="url(#glow)"/>
  ${vignette(0.7)}${grain(0.34)}
`
scenes['drama-09'] = frame(portrait9)

/* 10 时间退回一步 */
scenes['drama-10'] = frame(`
  <rect width="${W}" height="${H}" fill="#071014"/>
  <ellipse cx="900" cy="420" rx="800" ry="420" fill="#0d272d" opacity=".8"/>
  ${bokeh({ count: 36, color: 'rgba(127,162,146,.22)', max: 40 })}
  <path d="M0 700 C 430 640 1260 650 1792 590 L1792 1024 L0 1024 Z" fill="#080c0e"/>
  <path d="M0 760 L1792 690" stroke="#c8ae7d" stroke-width="1" opacity=".16"/>
  <g opacity=".5">
    ${woman({ x: 680, y: 820, scale: 1.1, facing: 1, rimOpacity: 0.4 })}
    ${man({ x: 1180, y: 800, scale: 1.1, facing: -1, rim: '#7fa292' })}
  </g>
  ${umbrella({ x: 560, y: 480, scale: 0.85, rotate: -20, open: true, fill: '#05090b', stroke: '#c8ae7d', opacity: 0.32 })}
  ${umbrella({ x: 1250, y: 470, scale: 0.8, rotate: 18, open: true, fill: '#05090b', stroke: '#7fa292', opacity: 0.26 })}
  <g fill="none" stroke="#e4ce9e" opacity=".2">
    <circle cx="900" cy="360" r="240" stroke-width="1"/>
    <circle cx="900" cy="360" r="190" stroke-width=".6" stroke-dasharray="2 16"/>
    <path d="M900 360 L900 210 M900 360 L1020 430" stroke-width="2"/>
  </g>
  ${upwardRain({ count: 90, color: 'rgba(127,162,146,.22)' })}
  ${vignette(0.7)}${grain(0.3)}
`)

/* 11 放手 */
scenes['drama-11'] = frame(`
  <rect width="${W}" height="${H}" fill="#080b0d"/>
  ${lamp(480, 300, 400, 420)}
  ${lamp(1320, 250, 330, 380, '#7fa292')}
  <path d="M0 760 C 500 700 1250 720 1792 660 L1792 1024 L0 1024 Z" fill="#0c0f11"/>
  ${woman({ x: 560, y: 730, scale: 1.35, facing: 1, rimOpacity: 0.55 })}
  ${man({ x: 1200, y: 720, scale: 1.3, facing: -1, rim: '#c8ae7d' })}
  <g transform="translate(860 500) rotate(-7)">
    ${umbrella({ x: 0, y: 0, scale: 1.1, open: false, fill: '#080b0c', stroke: '#e4ce9e', opacity: 0.85, glow: 0.12 })}
    <path d="M-46 30 C -20 80 80 90 140 30" fill="none" stroke="#c8ae7d" stroke-width="2" opacity=".6"/>
  </g>
  <path d="M700 660 C 780 630 830 620 900 620" fill="none" stroke="#c8ae7d" stroke-width="2" opacity=".25"/>
  ${bokeh({ count: 24, color: 'rgba(228,206,158,.18)', max: 28 })}
  ${rain({ count: 80, color: 'rgba(200,220,230,.08)' })}
  ${vignette(0.65)}${grain(0.3)}
`)

/* 12 雨停之后 */
scenes['drama-12'] = frame(`
  <defs>
    <linearGradient id="dawn" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f6f70"/><stop offset=".5" stop-color="#1d3538"/><stop offset="1" stop-color="#0b1214"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#dawn)"/>
  <ellipse cx="900" cy="620" rx="900" ry="360" fill="#e4ce9e" opacity=".08"/>
  <path d="M0 640 C 400 590 1250 620 1792 560 L1792 1024 L0 1024 Z" fill="#0b0f10"/>
  <rect x="500" y="220" width="800" height="560" fill="#0d1113" stroke="#c8ae7d" stroke-width="1.5" opacity=".85"/>
  <rect x="540" y="260" width="720" height="470" fill="#11150f" opacity=".9"/>
  <path d="M540 260 L1260 260" stroke="#c8ae7d" stroke-width="1" opacity=".25"/>
  ${lamp(900, 460, 480, 280, '#e4ce9e')}
  ${umbrella({ x: 830, y: 570, scale: 1.25, rotate: 7, open: true, fill: '#0d0f0f', stroke: '#c8ae7d', opacity: 0.75 })}
  ${crane(880, 420, 1.5, '#e4ce9e', 0.95)}
  <path d="M900 590 C 1050 560 1120 600 1180 660" fill="none" stroke="#e4ce9e" stroke-width="2" opacity=".35"/>
  <path d="M0 830 L1792 780" stroke="#e4ce9e" stroke-width="1" opacity=".1"/>
  ${bokeh({ count: 20, color: 'rgba(228,206,158,.15)', max: 22 })}
  ${rain({ count: 26, color: 'rgba(200,220,230,.06)' })}
  ${vignette(0.55)}${grain(0.26)}
`)

/* 角色参考 */
function portrait({ title, hair, rim, bg1, bg2, coat, bun = false }) {
  return frame(`
    <defs>
      <linearGradient id="pb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient>
      <radialGradient id="pg" cx=".5" cy=".4" r=".6"><stop offset="0" stop-color="${rim}" stop-opacity=".18"/><stop offset="1" stop-color="${rim}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="768" height="1024" fill="url(#pb)"/>
    <rect width="768" height="1024" fill="url(#pg)"/>
    <g transform="translate(384 660) scale(2.05)">
      <path d="M -70 -150 C -94 -96 -82 -22 -40 20 C -70 50 -84 92 -90 156 L 96 156 C 94 76 78 20 44 -18 C 18 -52 12 -92 22 -142 C 38 -202 12 -252 -30 -252 C -78 -252 -92 -206 -70 -150 Z" fill="${coat}"/>
      <ellipse cx="0" cy="-180" rx="48" ry="60" fill="${hair}"/>
      <path d="${bun ? 'M -48 -214 C -36 -252 42 -258 52 -218 C 60 -188 38 -164 20 -158 C 26 -190 -10 -208 -48 -214 Z' : 'M -52 -196 C -64 -246 -14 -278 30 -254 C 64 -236 62 -190 46 -166 C 34 -200 -12 -218 -52 -196 Z'}" fill="${hair}"/>
      <path d="M -44 -200 C -18 -226 30 -228 48 -200" fill="none" stroke="${rim}" stroke-width="5" opacity=".5"/>
      <path d="M 40 -160 C 54 -128 44 -88 12 -60" fill="none" stroke="${rim}" stroke-width="4" opacity=".35"/>
      <path d="M 44 -10 C 64 36 74 92 78 150" fill="none" stroke="${rim}" stroke-width="4" opacity=".3"/>
      <path d="M -36 -180 C -28 -166 -14 -160 0 -164" fill="none" stroke="#d8c29a" stroke-width="3" opacity=".35"/>
      ${bun ? '<circle cx="58" cy="-238" r="28" fill="' + hair + '"/>' : ''}
    </g>
    ${bokeh({ count: 16, color: rim, max: 22 })}
    ${vignette(0.55)}${grain(0.22)}
  `, 768, 1024)
}

scenes['ref-linwan'] = portrait({ title: '林晚', hair: '#12100d', rim: '#c8ae7d', bg1: '#171b1c', bg2: '#080a0c', coat: '#141a1d' })
scenes['ref-boy'] = portrait({ title: '少年', hair: '#0e1214', rim: '#7fa292', bg1: '#131b1d', bg2: '#070b0d', coat: '#101518' })
scenes['ref-grandma'] = portrait({ title: '外婆', hair: '#2a241b', rim: '#e4ce9e', bg1: '#1a150f', bg2: '#0a0806', coat: '#1a1712', bun: true })

/* 封面：横向 / 纵向 */
scenes['drama-cover'] = frame(`
  <rect width="${W}" height="${H}" fill="#070a0c"/>
  <rect width="${W}" height="${H}" fill="url(#sky)" opacity=".5"/>
  ${bokeh({ count: 30, color: 'rgba(200,174,125,.2)', max: 46 })}
  <g opacity=".9" transform="translate(900 480)">${umbrella({ x: 0, y: 0, scale: 2.25, open: true, fill: '#080b0e', stroke: '#c8ae7d', glow: 0.08 })}</g>
  ${rain({ count: 220, color: 'rgba(200,220,230,.18)' })}
  <path d="M0 845 C 500 800 1200 820 1792 760 L1792 1024 L0 1024 Z" fill="#080b0d"/>
  ${crane(1240, 300, 1.4, '#e4ce9e', 0.8)}
  ${vignette(0.7)}${grain(0.3)}
`)

function bookCover({ kind, bg1, bg2, accent, motif }) {
  return frame(`
    <defs>
      <linearGradient id="bc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient>
      <radialGradient id="bg2g" cx=".5" cy=".28" r=".55"><stop offset="0" stop-color="${accent}" stop-opacity=".22"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="768" height="1024" fill="url(#bc)"/>
    <rect width="768" height="1024" fill="url(#bg2g)"/>
    <rect x="38" y="38" width="692" height="948" fill="none" stroke="${accent}" stroke-width="1.4" opacity=".45"/>
    ${motif}
    ${rain({ count: 90, color: 'rgba(200,220,230,.12)' })}
    ${bokeh({ count: 18, color: accent, max: 20 })}
    ${vignette(0.5)}${grain(0.26)}
  `, 768, 1024)
}

scenes['novel-cover'] = bookCover({
  kind: 'novel',
  bg1: '#18231f',
  bg2: '#090d0c',
  accent: '#c8ae7d',
  motif: `
    <g transform="translate(384 620) scale(1.22)">
      ${umbrella({ x: 0, y: 0, scale: 1.2, open: true, fill: '#0c1211', stroke: '#c8ae7d', glow: 0.07 })}
      ${umbrella({ x: -150, y: 120, scale: 0.7, rotate: -18, open: false, fill: '#0b0f0e', stroke: '#7fa292', opacity: 0.55 })}
      ${umbrella({ x: 160, y: 150, scale: 0.8, rotate: 14, open: false, fill: '#0b0f0e', stroke: '#c2795f', opacity: 0.5 })}
    </g>
    <path d="M384 720 L384 900" stroke="#c8ae7d" stroke-width="1.6" opacity=".28"/>
  `
})

scenes['short-cover'] = bookCover({
  kind: 'short',
  bg1: '#1d2626',
  bg2: '#080d0f',
  accent: '#7fa292',
  motif: `
    <g transform="translate(384 600) scale(1.15)">
      <path d="M-230 40 L210 20 L250 250 L-270 270 Z" fill="#14100b" stroke="#c8ae7d" stroke-width="1" opacity=".8"/>
      <path d="M-110 30 C -40 -110 180 -120 240 20 C 130 110 -20 120 -110 30 Z" fill="#0b0f0f" stroke="#7fa292" stroke-width="1.2" opacity=".75"/>
      ${umbrella({ x: 40, y: 140, scale: 0.6, rotate: -8, open: false, fill: '#080b0c', stroke: '#c8ae7d', opacity: 0.8 })}
      <path d="M-60 90 L140 30 L120 160 L-20 190 Z" fill="#f4efe4" opacity=".85"/>
      <path d="M-40 110 L100 65 M-30 135 L80 105 M-45 155 L70 125" stroke="#c8ae7d" stroke-width="1.2" opacity=".4"/>
    </g>
  `
})

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
for (const [name, html] of Object.entries(scenes)) {
  const isPortrait = name.startsWith('ref-') || name === 'novel-cover' || name === 'short-cover'
  await page.setViewportSize({ width: isPortrait ? 768 : W, height: isPortrait ? 1024 : H })
  await page.setContent(html, { waitUntil: 'load' })
  await page.waitForTimeout(160)
  await page.screenshot({ path: join(outDir, `${name}.png`), type: 'png' })
  console.log('generated', name)
}
// 成片海报/预览帧
await page.setViewportSize({ width: W, height: H })
await page.setContent(scenes['drama-12'], { waitUntil: 'load' })
await page.waitForTimeout(120)
await page.screenshot({ path: join(outDir, 'demo-draft-poster.jpg'), type: 'jpeg', quality: 88 })
await browser.close()
console.log('done', outDir)
