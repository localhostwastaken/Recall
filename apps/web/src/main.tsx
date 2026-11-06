import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, getSettings } from './settings';
import { warmUpVerifier } from './verify/warmUp';
import './ui/tokens.css';
import './ui/base.css';
import './ui/web.css';

applyTheme(getSettings().theme);
void warmUpVerifier();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
