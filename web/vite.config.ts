import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /api covers image delivery too (/api/images/:id). /mcp is proxied so the
// MCP endpoint can be exercised from the dev origin as well.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7878',
      '/mcp': 'http://127.0.0.1:7878',
    },
  },
});
