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
 * plots alike. Colours are left as each page sets them.
 */

const FONT = 43              // Helvetica-like, size in pixels (precision 3)
const LABEL_PX = 11
const TITLE_PX = 12
const MARGIN_PX = { left: 58, right: 14, top: 12, bottom: 40, rightWithPalette: 72 }

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
  axis.fTitleOffset = kind === 'x' ? 1.25 : kind === 'y' ? 1.6 : 1.2
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
  g.fFrameFillStyle = 0
  g.fPadColor = 0
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
  // On a log axis the grid would follow every minor tick: horizontal lines only.
  canvas.fGridx = canvas.fLogx ? 0 : 1
  canvas.fGridy = 1
  canvas.fFillStyle = 0
  canvas.fFrameFillStyle = 0
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
      return original.call(this, dom, obj, opt)
    }
  }
}
