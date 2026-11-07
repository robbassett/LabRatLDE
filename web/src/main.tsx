import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts, Latin subset only (SPEC-025-R05): served from the binary, no CDN.
import '@fontsource/outfit/latin-500.css';
import '@fontsource/outfit/latin-600.css';
import '@fontsource/fira-sans/latin-400.css';
import '@fontsource/fira-sans/latin-500.css';
import '@fontsource/fira-sans/latin-600.css';
import '@fontsource/fira-code/latin-400.css';
import './tokens.css';
import './components.css';
import './styles.css';
import App from './App';
import { applyStoredTheme } from './theme';

// Apply the saved theme before the first paint, so there is no flash (SPEC-025-R02).
applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
