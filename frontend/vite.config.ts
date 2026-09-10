import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/sale': 'http://localhost:3000',
      '/purchase': 'http://localhost:3000',
      '/admin/sales': 'http://localhost:3000',
    },
  },
});
