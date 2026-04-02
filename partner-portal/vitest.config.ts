import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    root: process.cwd(),
    environment: 'jsdom',
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts'
  }
}));