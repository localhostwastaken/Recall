import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getAttachment, putAttachment } from '../../src/recall/attachmentStore';
import { PENDING_PREFIX, newCaptureId, prunePending, type PendingArea } from '../../src/recall/pending';

function memArea(data: Record<string, unknown>): PendingArea {
  return {
    get: async () => ({ ...data }),
    set: async (items: Record<string, unknown>) => void Object.assign(data, items),
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  } as unknown as PendingArea;
}

describe('repository snapshots in IndexedDB (R46)', () => {
  it('pruning pending records drops the snapshots no live pending record names', async () => {
    const now = 10 * 86_400_000;
    const [live, old, orphan] = [newCaptureId(), newCaptureId(), newCaptureId()];
    const snap = { bytes: new Uint8Array([1, 2, 3]), sha256: 'ab', at: 1 };
    for (const id of [live, old, orphan]) await putAttachment(id, snap);
    const area = memArea({
      [PENDING_PREFIX + live]: JSON.stringify({ captureId: live, createdAt: now - 1_000 }),
      [PENDING_PREFIX + old]: JSON.stringify({ captureId: old, createdAt: now - 8 * 86_400_000 }),
    });
    await prunePending(area, now);
    expect(await getAttachment(live)).not.toBeNull();
    expect(await getAttachment(old)).toBeNull();
    expect(await getAttachment(orphan)).toBeNull();
  });
});
