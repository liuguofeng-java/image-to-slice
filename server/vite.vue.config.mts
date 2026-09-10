import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const apiTarget = `http://127.0.0.1:${process.env.PORT || 18787}`;
const proxy = { '/api': apiTarget, '/health': apiTarget };
export default defineConfig({
  plugins: [vue()],
  server: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  build: { outDir: 'dist', emptyOutDir: true }
});
