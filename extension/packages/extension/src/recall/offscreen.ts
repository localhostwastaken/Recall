// The offscreen document that hosts the prover (service worker side).
const OFFSCREEN_PATH = 'offscreen.html';

let creating: Promise<void> | null = null;

/** Creates the offscreen document unless it exists. Concurrent callers share one creation. */
export async function ensureOffscreen(): Promise<void> {
  if (creating) return creating;
  creating = (async () => {
    try {
      const url = chrome.runtime.getURL(OFFSCREEN_PATH);
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
        documentUrls: [url],
      });
      if (existing.length > 0) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS' as chrome.offscreen.Reason],
        justification: 'Run the TLS prover in a worker context',
      });
    } finally {
      creating = null;
    }
  })();
  return creating;
}
