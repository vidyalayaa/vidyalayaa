import { defineConfig, type Plugin } from 'vite';
import { createServer, connect, type Server, type Socket } from 'node:net';
import react from '@vitejs/plugin-react';
// Serve both loopback families without exposing the development server to the LAN.
function loopbackAliases(): Plugin {
  return {
    name: 'loopback-aliases',
    configureServer(vite) {
      let alias: Server | undefined;
      const connections = new Set<Socket>();
      vite.httpServer?.once('listening', () => {
        const address = vite.httpServer?.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1') return;
        alias = createServer((incoming) => {
          const upstream = connect({ host: '127.0.0.1', port: address.port });
          for (const socket of [incoming, upstream]) {
            connections.add(socket);
            socket.once('close', () => connections.delete(socket));
          }
          incoming.on('error', () => upstream.destroy());
          upstream.on('error', () => incoming.destroy());
          incoming.once('close', () => upstream.destroy());
          upstream.once('close', () => incoming.destroy());
          incoming.pipe(upstream).pipe(incoming);
        });
        alias.on('error', (error: NodeJS.ErrnoException) => {
          if (!['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code || ''))
            vite.config.logger.warn(`IPv6 loopback alias unavailable: ${error.code}`);
        });
        alias.listen(address.port, '::1');
      });
      vite.httpServer?.once('close', () => {
        for (const socket of connections) socket.destroy();
        alias?.close();
      });
    },
  };
}
export default defineConfig({
  plugins: [react(), loopbackAliases()],
  // Use fresh dependency URLs for browsers that cached the old optimized React graph.
  cacheDir: 'node_modules/.vite-vidyalayaa',
  resolve: { dedupe: ['react', 'react-dom'] },
  // Keep the development dependency graph fixed while tabs are open. Discovering a
  // dependency on a lazy route can otherwise rebuild the shared React chunk mid-session.
  optimizeDeps: {
    noDiscovery: true,
    include: [
      '@firebase/app',
      '@firebase/messaging',
      '@hookform/resolvers/zod',
      '@radix-ui/react-dialog',
      '@radix-ui/react-slot',
      '@sentry/react',
      '@supabase/supabase-js',
      '@tanstack/react-query',
      'class-variance-authority',
      'clsx',
      'lucide-react',
      'react',
      'react-dom',
      'react-dom/client',
      'react-hook-form',
      'react-router-dom',
      'react/jsx-dev-runtime',
      'react/jsx-runtime',
      'recharts',
      'tailwind-merge',
      'zod',
    ],
  },
  server: {
    port: 5173,
    headers: { 'Cache-Control': 'no-store' },
    proxy: { '/api': 'http://127.0.0.1:4000' },
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom'], charts: ['recharts'],identity:['@supabase/supabase-js'],forms:['react-hook-form','@hookform/resolvers/zod','zod'] },
      },
    },
  },
});
