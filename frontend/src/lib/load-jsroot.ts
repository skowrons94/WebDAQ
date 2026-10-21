import { installPlotStyle } from './jsroot-style';

let jsrootPromise: Promise<void> | null = null;

// JSROOT is served by this web server (app/api/jsroot, from the version pinned
// in package.json). root.cern is only a fallback: it once began redirecting to
// the CERN single sign-on, and every plot stopped drawing.
const SOURCES = ['/api/jsroot', 'https://root.cern/js/latest/build/jsroot.js'];

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => (window.JSROOT ? resolve() : reject(new Error(`No JSROOT in ${src}`)));
    script.onerror = () => { script.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.appendChild(script);
  });
}

export function loadJSROOT(): Promise<void> {
  if (!jsrootPromise) {
    jsrootPromise = (async () => {
      for (const src of SOURCES) {
        try {
          await loadScript(src);
          installPlotStyle(window.JSROOT);
          return;
        } catch (e) {
          console.warn(String(e));
        }
      }
      jsrootPromise = null;   // let a later call try again
      throw new Error('Failed to load JSROOT');
    })();
  }
  return jsrootPromise;
}

declare global {
  interface Window {
    JSROOT: any;
  }
}
