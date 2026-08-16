import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端 :5173，开发时代理 /api 到后端 :3000（同源策略，避免 CORS）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
