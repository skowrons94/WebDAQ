let jsrootPromise: Promise<void> | null = null;

export function loadJSROOT(): Promise<void> {
  if (!jsrootPromise) {
    jsrootPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://root.cern/js/latest/build/jsroot.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load JSROOT'));
      document.head.appendChild(script);
    });
  }
  return jsrootPromise;
}

declare global {
  interface Window {
    JSROOT: any;
  }
}