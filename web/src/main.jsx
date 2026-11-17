import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './ui/ErrorBoundary.jsx';
import { installBackHandler } from './ui/primitives.jsx';
import './styles.css';
import './theme.css';
import './aurora.css';
import './layout.css';
import './chat.css';
import './pages.css';
import './effects.css';

installBackHandler();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
