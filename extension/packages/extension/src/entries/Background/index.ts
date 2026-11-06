// Recall fork: the upstream page-facing plugin API (content-script `window.tlsn`
// bridge, EXEC_CODE, confirmation popup, managed windows, plugin overlays, request
// interception and the page relay) was removed. Captures start only from the popup.
import browser from 'webextension-polyfill';
import { logger } from '@tlsn/common';
import { getStoredLogLevel } from '../../utils/logLevelStorage';
import type { BackgroundMessage } from '../../types/messages';
import { initRecallBackground } from '../../recall/background';

// Initialize logger with stored log level
getStoredLogLevel().then((level) => {
  logger.init(level);
  logger.info('Background script loaded');
});

// Settings, the capture job and the offscreen prover document.
initRecallBackground();

// Handle extension install/update
browser.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed/updated:', details.reason);
});

// Messages from the extension's own pages (no content scripts, so never from web pages).
browser.runtime.onMessage.addListener((msg: unknown) => {
  const request = msg as BackgroundMessage;
  if (request.type === 'PING') {
    return Promise.resolve({ type: 'PONG' });
  }
  // Recall messages are handled in recall/background.ts.
  return;
});

export {};
