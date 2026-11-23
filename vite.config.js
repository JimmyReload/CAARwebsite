import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  // 只监听本机：vite dev 的依赖与源码可被同网段任意设备读取，默认不暴露到局域网。
  // 需要手机调试时临时改成 '0.0.0.0'，或启动时加 --host。
  server: { host: '127.0.0.1', port: 5173 },
})