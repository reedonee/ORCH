import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { setupBridge } from './lib/orch-bridge';

// Initialise the ORCH bridge for MCP server access
setupBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
