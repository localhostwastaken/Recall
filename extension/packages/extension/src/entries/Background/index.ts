// Recall fork: the upstream page-facing plugin API (content-script `window.tlsn`
// bridge, EXEC_CODE, confirmation popup, managed windows, plugin overlays, request
// interception and the page relay) was removed. Captures start only from the popup.
import browser from 'webextension-polyfill';
import { logger } from '@tlsn/common';
import { getStoredLogLevel } from '../../utils/logLevelStorage';
import type { BackgroundMessage } from '../../types/messages';
import { initRecallBackground } from '../../recall/background';

const chrome = (global as typeof globalThis).chrome;

// Initialize logger with stored log level
getStoredLogLevel().then((level) => {
  logger.init(level);
  logger.info('Background script loaded');
});

initRecallBackground();

// Handle extension install/update
browser.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed/updated:', details.reason);
});

// Messages from the extension's own pages (no content scripts, so never from web pages).
browser.runtime.onMessage.addListener((msg: unknown) => {
  const request = msg as BackgroundMessage;
  logger.debug('Message received:', request.type);

  if (request.type === 'PING') {
    return Promise.resolve({ type: 'PONG' });
  }

  // Unknown message type - no response needed
  return;
});

// Mutex for offscreen document creation to prevent race conditions
let offscreenDocumentCreationPromise: Promise<void> | null = null;

// Create offscreen document if needed (Chrome 109+)
// Uses mutex to prevent race conditions when multiple callers try to create simultaneously
async function createOffscreenDocument(): Promise<void> {
  // If creation is already in progress, wait for it
  if (offscreenDocumentCreationPromise) {
    return offscreenDocumentCreationPromise;
  }

  // Create the promise and store it for other callers to wait on
  offscreenDocumentCreationPromise = (async () => {
    try {
      // Check if we're in a Chrome environment that supports offscreen documents
      if (!chrome?.offscreen) {
        logger.debug('Offscreen API not available');
        return;
      }

      const offscreenUrl = browser.runtime.getURL('offscreen.html');

      // Check if offscreen document already exists
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl],
      });

      if (existingContexts.length > 0) {
        logger.debug('Offscreen document already exists');
        return;
      }

      // Create offscreen document
      logger.debug('Creating offscreen document...');
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run the TLS prover in a worker context',
      });
      logger.debug('Offscreen document created successfully');
    } finally {
      // Clear the promise so future calls can create if needed
      offscreenDocumentCreationPromise = null;
    }
  })();

  return offscreenDocumentCreationPromise;
}

// Initialize offscreen document
createOffscreenDocument().catch((err) => logger.error('Offscreen document error:', err));

export {};
