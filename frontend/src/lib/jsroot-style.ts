/**
 * One look for every JSROOT plot, in the style of the rest of the site.
 *
 * JSROOT draws like desktop ROOT: Arial at a fraction of the pad height (huge
 * in a tall pad, tiny in a small one), thick ticks, a title box, a tool bar
 * square in the corner, and margins that are fractions of the pad too. Here:
 *
 * - text in the site's font (CSS, globals.css) at fixed pixel sizes — ROOT
 *   fonts of precision 3 (code 43) take their size in pixels;
 * - margins in pixels, worked out from the size of the element drawn into;
 * - short light ticks, a faint grid, no title box, no tool bar, and numbers
 *   written out (40000, not 4×10⁴) up to six digits.
 *
 * It is applied at draw time, by wrapping JSROOT.draw/redraw once JSROOT is
 * loaded, so every page gets it without each component styling its objects:
 * the histograms, waveforms, PSD, tuner, SIS3316, coincidence and calibration
 * plots alike. Colours are left as each page sets them, except that every
 * plot is drawn on the card's own background (no white or black box), and the
 * series colour and 2D palette are compensated for JSROOT's dark mode — see
 * seriesOption() and plotHex().
 */

const FONT = 43              // Helvetica-like, size in pixels (precision 3)
const LABEL_PX = 11
const TITLE_PX = 12
// Right and top leave room for the "×10³" JSROOT writes past the end of an
// axis whose numbers it shortens: at 14 and 12 px it was cut off.
const MARGIN_PX = { left: 58, right: 30, top: 22, bottom: 40, rightWithPalette: 72 }

type AnyObj = Record<string, any>

const TICK_PX = 5
const CENTER_TITLE = 1 << 12           // TAxis kCenterTitle

/** Tick lengths are a fraction of the frame across the axis: 5 px whatever its size. */
type Frame = { w: number; h: number }

function styleAxis(axis: AnyObj | undefined, kind: 'x' | 'y' | 'z', frame: Frame) {
  if (!axis) return
  axis.fLabelFont = FONT
  axis.fLabelSize = LABEL_PX
  axis.fTitleFont = FONT
  axis.fTitleSize = TITLE_PX
  axis.fTickLength = kind === 'x' ? TICK_PX / frame.h : TICK_PX / frame.w
  axis.fLabelOffset = 0.008
  // A y title at 0 is placed by JSROOT just outside the widest number, so a
  // "12000" no longer runs into it; a fixed offset only fitted short numbers.
  axis.fTitleOffset = kind === 'x' ? 1.25 : kind === 'y' ? 0 : 1.2
  // As many labels as fit: about one per 70 px across, one per 35 px up.
  // Too many and JSROOT shrinks them all until they no longer read.
  const length = kind === 'x' ? frame.w : frame.h
  const primary = Math.max(2, Math.min(10, Math.floor(length / (kind === 'x' ? 70 : 35))))
  axis.fNdivisions = 500 + primary
  if (kind !== 'z') axis.fBits = (axis.fBits ?? 0) | CENTER_TITLE
}

/** Axes, title and statistics of one drawable object, whatever its type. */
function styleObject(obj: AnyObj | null | undefined, frame: Frame) {
  if (!obj || typeof obj !== 'object') return
  const type: string = obj._typename ?? ''
  if (type.startsWith('TH1') || type.startsWith('TH2') || type.startsWith('TProfile')) {
    styleAxis(obj.fXaxis, 'x', frame)
    styleAxis(obj.fYaxis, 'y', frame)
    styleAxis(obj.fZaxis, 'z', frame)
    // Bit 9 of fBits (kNoTitle) hides the title box; the cards have headers.
    obj.fBits = (obj.fBits ?? 0) | (1 << 9)
  } else if (type.startsWith('TGraph') || type === 'TMultiGraph' || type === 'THStack') {
    if (obj.fHistogram) styleObject(obj.fHistogram, frame)
  }
}

function sizeOf(el: Element | null) {
  return {
    w: Math.max(200, (el as HTMLElement | null)?.clientWidth || 600),
    h: Math.max(120, (el as HTMLElement | null)?.clientHeight || 300),
  }
}

function frameOf(el: Element | null, palette = false): Frame {
  const { w, h } = sizeOf(el)
  return {
    w: Math.max(50, w - MARGIN_PX.left - (palette ? MARGIN_PX.rightWithPalette : MARGIN_PX.right)),
    h: Math.max(50, h - MARGIN_PX.top - MARGIN_PX.bottom),
  }
}

/** Per drawing: what depends on the element's size and on the theme. */
function setStyleFor(el: Element | null, palette = false) {
  const g = (window as any).JSROOT?.gStyle
  if (!g) return
  const { w, h } = sizeOf(el)
  const frame = frameOf(el, palette)
  g.fPadLeftMargin = MARGIN_PX.left / w
  g.fPadRightMargin = (palette ? MARGIN_PX.rightWithPalette : MARGIN_PX.right) / w
  g.fPadTopMargin = MARGIN_PX.top / h
  g.fPadBottomMargin = MARGIN_PX.bottom / h
  // Objects whose axes are made at draw time (graphs) take them from gStyle.
  g.fLabelSize = LABEL_PX
  g.fTitleSize = TITLE_PX
  g.fTickLength = TICK_PX / Math.min(frame.w, frame.h)
  // A grid that is there without being seen first. JSROOT inverts the greys in
  // dark mode, so this light grey becomes a dark one there.
  g.fGridColor = 18
  // No background of its own: the card's colour shows through, in both themes.
  // Style 4000 is ROOT's fully transparent fill. A frame with no fill at all
  // is painted white by JSROOT (black once dark mode inverts it); a colour
  // index other than 0 makes it take the transparent one instead.
  g.fFrameFillColor = 1
  g.fFrameFillStyle = 4000
  g.fPadColor = 0
  // The 2D palette, pre-inverted in dark mode so it shows as itself.
  const J = (window as any).JSROOT
  if (J?.settings) J.settings.Palette = J.settings.DarkMode ? invertedPalette(J) : PALETTE
}

function paletteIn(canvas: AnyObj): boolean {
  const opts: string[] = canvas?.fPrimitives?.opt ?? []
  return opts.some((o) => /colz/i.test(String(o ?? '')))
}

function styleCanvas(canvas: AnyObj, el: Element | null) {
  const palette = paletteIn(canvas)
  const { w, h } = sizeOf(el)
  setStyleFor(el, palette)
  canvas.fLeftMargin = MARGIN_PX.left / w
  canvas.fRightMargin = (palette ? MARGIN_PX.rightWithPalette : MARGIN_PX.right) / w
  canvas.fTopMargin = MARGIN_PX.top / h
  canvas.fBottomMargin = MARGIN_PX.bottom / h
  // On a log axis only the decades get a grid line (see drawGrids below).
  canvas.fGridx = 1
  canvas.fGridy = 1
  canvas.fFillStyle = 4000
  canvas.fFrameFillColor = 1
  canvas.fFrameFillStyle = 4000
  canvas.fTickx = 0
  canvas.fTicky = 0
  canvas.fFrameLineWidth = 1
  const frame = frameOf(el, palette)
  for (const prim of canvas.fPrimitives?.arr ?? []) styleObject(prim, frame)
}

function styleForDraw(dom: any, obj: AnyObj) {
  const el: Element | null = typeof dom === 'string' ? document.getElementById(dom) : dom
  if (obj?._typename === 'TCanvas' || obj?._typename === 'TPad') {
    styleCanvas(obj, el)
  } else {
    setStyleFor(el)
    styleObject(obj, frameOf(el))
  }
}

// ───────────────────────────────────────────── colours under dark mode

const PALETTE = 57                     // kBird
const INVERTED_PALETTE = 1057          // our own id for kBird, inverted
let invertedReady = false

/** JSROOT's dark mode inverts the whole SVG: a colour inverted first shows as itself. */
function invertHex(hex: string): string {
  const v = parseInt(hex, 16)
  return (0xffffff ^ v).toString(16).padStart(6, '0')
}

function invertCss(c: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(c)
  if (hex) return `#${invertHex(hex[1])}`
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c)
  if (rgb) return `rgb(${255 - Number(rgb[1])},${255 - Number(rgb[2])},${255 - Number(rgb[3])})`
  return c
}

function invertedPalette(J: any): number {
  if (!invertedReady) {
    try {
      const colors: string[] | undefined = J.getColorPalette?.(PALETTE)?.palette
      if (colors?.length && J.setColorPalette?.(INVERTED_PALETTE, colors.map(invertCss))) invertedReady = true
    } catch { /* keep the plain palette */ }
  }
  return invertedReady ? INVERTED_PALETTE : PALETTE
}

function darkMode(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).JSROOT?.settings?.DarkMode)
}

/**
 * A colour as JSROOT should be given it ("rrggbb", for draw options such as
 * line_rrggbb) so that it shows as `hex` in both themes. Read DarkMode after
 * it has been set for the drawing.
 */
export function plotHex(hex: string): string {
  const h = hex.replace(/^#/, '').toLowerCase()
  return darkMode() ? invertHex(h) : h
}

/** The theme's series colour (--chart-1) as "rrggbb", or null when unreadable. */
function seriesHex(): string | null {
  if (typeof window === 'undefined') return null
  const v = getComputedStyle(document.documentElement).getPropertyValue('--chart-1').trim()
  const m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/)
  if (!m) return null
  const h = Number(m[1]) / 360, sat = Number(m[2]) / 100, l = Number(m[3]) / 100
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = sat * Math.min(l, 1 - l)
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0')
  }
  return `${f(0)}${f(8)}${f(4)}`
}

/**
 * The draw option of a spectrum: `base` in the theme's series colour, a
 * translucent fill under a solid line — the same blue on every page and in
 * both themes. Call after JSROOT.settings.DarkMode is set for the drawing.
 */
export function seriesOption(base = 'hist nostat', fill = true): string {
  const s = seriesHex()
  if (!s) return base
  const c = plotHex(s)
  return fill ? `${base} fill_${c}55 line_${c}` : `${base} line_${c}`
}

// ───────────────────────────────────────────── after a drawing

/**
 * A plot JSROOT drew from a bare histogram (no TCanvas of ours) got a white
 * canvas of its own: make it transparent too, now and for its redraws.
 */
function clearBackground(painter: any) {
  const pp = painter?.getPadPainter?.() ?? painter
  const pad = pp?.getRootPad?.(true)
  if (!pad || pad.fFillStyle === 4000) return
  pad.fFillStyle = 4000
  pad.fFrameFillColor = 1
  pad.fFrameFillStyle = 4000
  try {
    pp.getCanvSvg?.()?.selectAll?.('.canvas_fillrect')?.style?.('fill', 'none')
    const fp = pp.getFramePainter?.()
    fp?.fillatt?.setOpacity?.(0)
    fp?.getFrameSvg?.()?.select?.('.main_layer')?.select?.('path')?.style?.('fill', 'none')
  } catch { /* looks only */ }
}

/**
 * The frame draws a grid line at each major tick, and on a log axis spanning
 * few decades JSROOT makes every 2…9 × 10ⁿ a major tick: a fence of lines.
 * Only the decades keep theirs. The frame painter's class is not exported, so
 * its drawGrids is wrapped on the first frame seen.
 *
 * JSROOT also puts the grid at the end of the axis layer, above the data: a
 * line at x = 0 hid the Δt coincidence peak and covered the axis lines. The
 * grid is moved under the histograms (to the start of the main layer),
 * lines on the frame's edges are dropped, and in dark mode it gets a grey
 * that stays visible on the dark card.
 */
let gridsPatched = false
function patchGrids(painter: any) {
  if (gridsPatched) return
  const fp = painter?.getFramePainter?.()
  const proto = fp && Object.getPrototypeOf(fp)
  if (!proto || typeof proto.drawGrids !== 'function') return
  gridsPatched = true
  const original = proto.drawGrids
  proto.drawGrids = function (this: any, ...args: unknown[]) {
    const saved: [any, number[]][] = []
    for (const handle of [this.x_handle, this.y_handle]) {
      if (!handle?.log || !Array.isArray(handle.ticks) || typeof handle.func?.invert !== 'function') continue
      saved.push([handle, handle.ticks])
      handle.ticks = handle.ticks.filter((pos: number) => {
        const decade = Math.log10(Number(handle.func.invert(pos)))
        return Number.isFinite(decade) && Math.abs(decade - Math.round(decade)) < 0.02
      })
    }
    // Lines on the frame's border would sit on the axis lines.
    const w = Number(this.getFrameWidth?.()) || 0
    const h = Number(this.getFrameHeight?.()) || 0
    for (const [handle, extent] of [[this.x_handle, w], [this.y_handle, h]] as [any, number][]) {
      if (!Array.isArray(handle?.ticks) || !extent) continue
      if (!saved.some(([s]) => s === handle)) saved.push([handle, handle.ticks])
      handle.ticks = handle.ticks.filter((pos: number) => pos > 1 && pos < extent - 1)
    }
    let result
    try {
      this.getFrameSvg?.()?.selectChild?.('.main_layer')?.selectAll?.('.xgrid,.ygrid')?.remove?.()
      result = original.apply(this, args)
    } finally {
      for (const [handle, ticks] of saved) handle.ticks = ticks
    }
    try { lowerGrids(this) } catch { /* looks only */ }
    try { clearYTitle(this) } catch { /* looks only */ }
    return result
  }
  // The frame just drawn still has the fence.
  try { fp.drawGrids(true) } catch { /* next redraw */ }
}

/** Grid paths go from the top of the axis layer to the bottom of the main layer. */
function lowerGrids(fp: any) {
  const frame = fp.getFrameSvg?.()
  const main = frame?.selectChild?.('.main_layer')?.node?.() as Element | undefined
  const axis = frame?.selectChild?.('.axis_layer')?.node?.() as Element | undefined
  if (!main || !axis) return
  // In dark mode the whole plot is inverted: this light grey shows as a dark one
  // that is still seen on the card (the default grey vanished into it).
  const dark = darkMode()
  for (const grid of Array.from(axis.querySelectorAll(':scope > .xgrid, :scope > .ygrid'))) {
    if (dark) (grid as SVGElement).style.stroke = '#c4c4c4'
    // The frame's background is a sibling before the main layer, so the
    // layer's first place is above it and under every histogram.
    main.insertBefore(grid, main.firstChild)
  }
}

/**
 * JSROOT puts a y title at offset 0 just past the widest number, measured to
 * the title's baseline: the rotated letters still touched six-digit labels
 * ("Counts / bin" over "300000"). Move it left until there is a gap. The axes
 * are drawn by the time the grid is, so this runs from drawGrids too.
 */
function clearYTitle(fp: any) {
  const axis = fp.getFrameSvg?.()?.selectChild?.('.axis_layer')?.node?.() as Element | undefined
  if (!axis) return
  const frameLeft = axis.getBoundingClientRect().left
  for (const title of Array.from(axis.querySelectorAll('.axis_title'))) {
    const t = title.getBoundingClientRect()
    if (!t.height || t.height <= t.width) continue          // the x title
    const labels = title.parentElement?.querySelector(':scope > .axis_labels')?.getBoundingClientRect()
    // Only a title left of the frame (the usual y axis), with labels beside it.
    if (!labels?.width || t.left >= frameLeft) continue
    const overlap = t.right + 3 - labels.left
    if (overlap <= 0) continue
    // JSROOT writes translate(x,y), or translate(x) when y is 0.
    const m = /translate\(\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?\s*\)/.exec(title.getAttribute('transform') ?? '')
    if (!m) continue
    const x = Number(m[1]) - Math.ceil(overlap)
    title.setAttribute('transform', `translate(${x},${m[2] ?? 0})`)
  }
}

function afterDraw(painter: any) {
  try {
    patchGrids(painter)
    clearBackground(painter)
  } catch { /* never stop a plot over its looks */ }
  return painter
}

let installed = false

/** Called once, right after JSROOT is loaded. */
export function installPlotStyle(J: any) {
  if (installed || !J) return
  installed = true

  if (J.settings) {
    J.settings.ToolBar = false          // the square in the corner
    J.settings.OptStat = 0
    J.settings.OptTitle = 0
  }
  const g = J.gStyle
  if (g) {
    g.fOptStat = 0
    g.fOptTitle = 0
    g.fAxisMaxDigits = 6               // 40000, not 4×10⁴
    g.fGridStyle = 1
    g.fGridWidth = 1
    g.fFrameLineWidth = 1
    g.fPadGridX = true
    g.fPadGridY = true
    g.fTextFont = FONT
    g.fLabelFont = FONT
    g.fTitleFont = FONT
    g.fLegendFont = FONT
    g.fStatFont = FONT
  }

  for (const name of ['draw', 'redraw'] as const) {
    const original = J[name]
    if (typeof original !== 'function') continue
    J[name] = function (dom: any, obj: any, opt?: any) {
      try { styleForDraw(dom, obj) } catch { /* never stop a plot over its looks */ }
      const result = original.call(this, dom, obj, opt)
      return result && typeof result.then === 'function' ? result.then(afterDraw) : result
    }
  }
}
