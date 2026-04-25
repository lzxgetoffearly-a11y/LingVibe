import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  const liteLlmTarget = env.LITE_LLM_UPSTREAM_BASE_URL || 'https://api.minimaxi.com/v1';
  const liteLlmApiKey = env.LITE_LLM_API_KEY || env.VITE_LITE_LLM_API_KEY || '';

  return {
    plugins: [react(), tailwindcss()],
    envPrefix: ['VITE_', 'GEMINI_'],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api/lite': {
          target: liteLlmTarget,
          changeOrigin: true,
          headers: liteLlmApiKey ? {
            Authorization: `Bearer ${liteLlmApiKey}`,
          } : undefined,
          rewrite: (proxyPath) => proxyPath.replace(/^\/api\/lite/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (liteLlmApiKey) {
                proxyReq.setHeader('Authorization', `Bearer ${liteLlmApiKey}`);
              }
            });
          },
        },
      },
    },
  };
});
