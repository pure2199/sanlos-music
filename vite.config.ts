import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 渲染进程（React）构建配置。
// root 固定为仓库根，index.html 位于仓库根，产物输出到 dist/。
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
