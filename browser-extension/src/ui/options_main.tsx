import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExtensionApp } from './App';

const container = document.getElementById('root')!;
createRoot(container).render(
  <React.StrictMode>
    <ExtensionApp surface="options" />
  </React.StrictMode>,
);
