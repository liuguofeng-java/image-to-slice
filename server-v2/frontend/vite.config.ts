import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  build: { chunkSizeWarningLimit: 1300 },
  test: { include: ['tests/unit/**/*.test.ts'] },
} as any);
