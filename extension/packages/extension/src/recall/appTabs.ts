// The web app's publish tab for a pending capture: one tab per capture. If one is open already it
// is brought to the front instead of opening a second (two tabs for one capture could each buy
// storage or publish).

/** Focuses the open tab whose address contains `#/approve/<captureId>`, else opens `url`. */
export async function focusOrOpenApproveTab(url: string, captureId: string): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const open = tabs.find((t) => typeof t.url === 'string' && t.url.includes(`#/approve/${captureId}`));
  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { active: true });
    if (open.windowId !== undefined) await chrome.windows.update(open.windowId, { focused: true }).catch(() => undefined);
    return;
  }
  await chrome.tabs.create({ url });
}
