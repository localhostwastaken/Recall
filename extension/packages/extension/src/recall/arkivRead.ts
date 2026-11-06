// Offscreen document: reads one Arkiv record's indexed fields, so the service worker can
// check it against a pending capture before marking it published. Keeps the Arkiv SDK
// out of the service worker bundle.
import type { Hex } from 'viem';
import type { NetConfig } from '@recall/net/config';
import { CaptureSchema, ConfirmationSchema, arkivPublic } from '@recall/net/arkiv';
import type { EntitySummary } from './pending';

/** Offscreen request: answered with an EntitySummary or `{error}`. */
export type OffscreenReadEntity = {
  type: 'recall.offscreen.readEntity';
  entityKey: Hex;
  net: NetConfig;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/** The record under `entityKey`, read through the capture schema, else the confirmation one. */
export async function readEntitySummary(
  net: NetConfig,
  entityKey: Hex,
): Promise<EntitySummary | { error: string }> {
  const pub = arkivPublic(net);
  try {
    const e = await pub.getEntity(entityKey, CaptureSchema);
    return { kind: 'capture', bodySha256: e.bodySha256.value, evidenceRef: e.evidenceRef.value };
  } catch (asCapture) {
    try {
      const e = await pub.getEntity(entityKey, ConfirmationSchema);
      return {
        kind: 'confirmation',
        bodySha256: e.bodySha256.value,
        captureKey: e.captureKey.value,
      };
    } catch {
      return { error: message(asCapture) };
    }
  }
}
