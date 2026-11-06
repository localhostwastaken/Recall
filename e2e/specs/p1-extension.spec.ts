import { expect, test } from '@playwright/test';
import { launchWithExtension, NOTICE_HOST, tabIdFor } from '../fixtures/extension';

test('@p1 extension loads and popup shows active tab URL', async () => {
  const { context, extensionId, serviceWorker } = await launchWithExtension({ dev: true });
  try {
    expect(extensionId).toMatch(/^[a-p]{32}$/);

    const page = await context.newPage();
    await page.goto(`https://${NOTICE_HOST}/notice`);
    await expect(page.locator('#deadline')).toContainText('Deadline:');
    const tabId = await tabIdFor(serviceWorker, `https://${NOTICE_HOST}/notice`);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    await expect(popup.getByRole('heading', { name: 'Recall' })).toBeVisible();
    await expect(popup.getByText(`${NOTICE_HOST}/notice`)).toBeVisible();

    // Settings plumbing: a dev build defaults to the local devnet, whose witness is up.
    await expect(popup.getByText('Witness online')).toBeVisible();
    const state = await serviceWorker.evaluate(async () => {
      const g = globalThis as unknown as {
        chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } };
        recall?: { build: { dev: boolean; devCa: boolean } };
      };
      return {
        settings: (await g.chrome.storage.local.get('recall.settings'))['recall.settings'],
        build: g.recall?.build,
      };
    });
    expect(state.build).toEqual({ dev: true, devCa: true });
    expect(state.settings).toEqual({
      net: 'local',
      witnessUrl: 'http://localhost:7047',
      pinnedWitnesses: [],
      appUrl: 'http://localhost:5173',
      arkivRpcUrl: 'http://localhost:8545',
      arkivAccessKey: '',
      uploadUrl: 'http://localhost:1633',
      uploadMode: 'stamped',
    });
  } finally {
    await context.close();
  }
});
