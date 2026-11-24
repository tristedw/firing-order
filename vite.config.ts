import { defineConfig } from 'vite';

// relative base so it works on GitHub Pages and inside a subfolder of the site
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
