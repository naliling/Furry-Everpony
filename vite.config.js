import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/* 构建时压缩，运行时直接发送产物，避免每个访客都在源站重新压缩。 */
function compressedWebAssets() {
  return {
    name: 'everony-compressed-web-assets',
    apply: 'build',
    async writeBundle({ dir }, bundle) {
      if (!dir) return;
      const writes = [];
      for (const [name, asset] of Object.entries(bundle)) {
        if (!/\.(?:html|css|m?js)$/.test(name)) continue;
        const bytes = Buffer.from(asset.type === 'chunk' ? asset.code : asset.source);
        if (bytes.length < 1024) continue;
        const br = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 7 } });
        const gzip = gzipSync(bytes, { level: 9 });
        if (br.length < bytes.length) writes.push(writeFile(join(dir, name + '.br'), br));
        if (gzip.length < bytes.length) writes.push(writeFile(join(dir, name + '.gz'), gzip));
      }
      await Promise.all(writes);
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), compressedWebAssets()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7788',
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
