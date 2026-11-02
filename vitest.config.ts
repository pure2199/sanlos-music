import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 单元测试配置。e2e/ 目录由 Playwright 负责，不纳入 Vitest。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    // 尚无测试文件时也算通过（exit 0）。
    passWithNoTests: true,
  },
})
