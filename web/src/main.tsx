import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Companion } from './Companion';
import './styles.css';

const view = new URLSearchParams(location.search).get('view');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{view === 'companion' ? <Companion /> : <App />}</StrictMode>,
);
