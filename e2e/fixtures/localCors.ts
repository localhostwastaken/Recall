import type { Page } from '@playwright/test';

const ALLOW = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

/**
 * The local Arkiv devnet (arkiv-reth-dev on :8545) sends no CORS headers, so a page on
 * :5173 cannot read from it, while the real Rabdi RPC and the Bee nodes can be read from a
 * browser. This adds the missing headers to the browser's requests to the local node (a
 * stand-in for a devnet with `--http.corsdomain`), so the app runs unchanged against it.
 * It forwards every request to the real node; nothing is faked.
 */
export async function allowLocalArkiv(page: Page): Promise<void> {
  await page.route(/^http:\/\/localhost:8545\//, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: ALLOW });
      return;
    }
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), ...ALLOW } });
  });
}
