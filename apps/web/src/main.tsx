import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './settings';
import './ui/fonts.css';
import './ui/tokens.css';
import './ui/base.css';
import './ui/web.css';
import './ui/product.css';

applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
