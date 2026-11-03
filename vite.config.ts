import path from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 渲染进程（React）构建配置。
// root 固定为仓库根，index.html 位于仓库根，产物输出到 dist/。
//
// ⚠️ **多页应用**（Task 10）：主窗口（`index.html`）与**桌面悬浮歌词窗口**
//    （`lyric.html`）是两个独立的渲染进程入口，各自打包成一份 HTML。
//    - 主窗口：持有 `<audio>`，是真正的播放器；
//    - 悬浮窗：只负责显示，位置与尺寸由主进程管理。
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
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        lyric: path.resolve(__dirname, 'lyric.html'),
      },
    },
  },
})
