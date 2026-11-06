/**
 * Type definitions for extension message passing.
 *
 * Recall fork: only messages between the extension's own contexts remain; the
 * upstream page-facing plugin messages (EXEC_CODE, windows, overlays, relay) were
 * removed. Recall's capture messages are in src/recall/messages.ts.
 */

/** Messages handled by the Background service worker */
export type BackgroundMessage = { type: 'PING' };
