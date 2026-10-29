import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// 直接引用 core 源码，避免先构建
export default defineConfig({ plugins: [react()], resolve: { alias: { '@fucai/core': path.resolve(__dirname, '../packages/core/src/index.ts') } } });
