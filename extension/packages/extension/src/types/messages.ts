/**
 * Type definitions for extension message passing.
 *
 * Recall fork: only messages between the extension's own contexts remain; the
 * upstream page-facing plugin messages (EXEC_CODE, windows, overlays, relay) were removed.
 */

/** Messages handled by the Background service worker */
export type BackgroundMessage = { type: 'PING' };

/** Messages handled by the Offscreen document */
export type OffscreenMessage = { type: 'PROCESS_DATA' };
