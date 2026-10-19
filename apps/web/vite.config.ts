import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4000' } },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom'], charts: ['recharts'],identity:['@supabase/supabase-js'],forms:['react-hook-form','@hookform/resolvers/zod','zod'] },
      },
    },
  },
});
