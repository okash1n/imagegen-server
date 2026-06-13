import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('GUI の初期化に失敗しました: #root 要素が見つかりません');
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
