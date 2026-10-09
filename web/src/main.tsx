import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    return this.state.failed ? <main className="panel"><h1>O painel precisa ser recarregado.</h1><p>Consulte a wallet antes de criar outra operação.</p><button type="button" onClick={() => window.location.reload()}>Recarregar painel</button></main> : this.props.children;
  }
}
const client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5000, refetchOnWindowFocus: false }, mutations: { retry: false } } });
const root = document.getElementById('root');
if (!root) throw new Error('Root element unavailable');
createRoot(root).render(<StrictMode><ErrorBoundary><QueryClientProvider client={client}><App /></QueryClientProvider></ErrorBoundary></StrictMode>);
