import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '');
  return {
    root: fileURLToPath(new URL('.', import.meta.url)), envDir: '..', plugins: [react(), tailwind()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: {
      '/api': { target: environment.API_PROXY_TARGET || 'http://127.0.0.1:3000', changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api(?=\/|$)/, '') },
    } },
    build: { outDir: '../dist/web', emptyOutDir: true },
  };
});
