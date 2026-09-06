import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Transitional component bundle. The legacy shell is removed only once every
// workflow has a Vue owner; never import or execute app.js from a Vue component.
export default defineConfig({
  plugins: [vue()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    emptyOutDir: false,
    outDir: 'dist',
    lib: { entry: 'src/ui/migration/slice-list-bridge.ts', name: 'ImageToSliceVue', formats: ['iife'], fileName: () => 'vue-ui.js' }
  }
});
