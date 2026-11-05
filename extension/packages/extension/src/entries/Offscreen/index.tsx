import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import browser from 'webextension-polyfill';
import { SessionManager } from '../../offscreen/SessionManager';
import { logger } from '@tlsn/common';
import { getStoredLogLevel } from '../../utils/logLevelStorage';
import type { OffscreenMessage } from '../../types/messages';

const OffscreenApp: React.FC = () => {
  useEffect(() => {
    // Initialize logger with stored log level
    getStoredLogLevel().then((level) => {
      logger.init(level);
      logger.info('Offscreen document loaded');
    });

    // Initialize SessionManager (owns the ProveManager and the tlsn-wasm worker)
    const sessionManager = new SessionManager();
    logger.debug('SessionManager initialized in Offscreen');
    void sessionManager;

    // Listen for messages from background script
    browser.runtime.onMessage.addListener((msg: unknown) => {
      const request = msg as OffscreenMessage;
      // Example message handling
      if (request.type === 'PROCESS_DATA') {
        return Promise.resolve({
          success: true,
          data: 'Processed in offscreen',
        });
      }

      // Recall fork: the upstream plugin handlers (EXEC_CODE_OFFSCREEN,
      // GET_PLUGIN_STATS_OFFSCREEN, RELAY_DELIVER*) were removed with the page API.
    });
  }, []);

  return (
    <div className="offscreen-container">
      <h1>Offscreen Document</h1>
      <p>This document runs in the background for processing tasks.</p>
    </div>
  );
};

const container = document.getElementById('app-container');
if (container) {
  const root = createRoot(container);
  root.render(<OffscreenApp />);
}
