import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, mkdirSync, existsSync } from 'fs'

// Plugin to copy SQL migration files to output
function copyMigrations() {
  return {
    name: 'copy-migrations',
    closeBundle() {
      const srcDir = resolve('src/main/db/migrations')
      const destDir = resolve('out/main/migrations')
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      if (existsSync(resolve(srcDir, '001_initial.sql'))) {
        copyFileSync(resolve(srcDir, '001_initial.sql'), resolve(destDir, '001_initial.sql'))
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMigrations()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    css: {
      postcss: resolve(__dirname, 'postcss.config.js')
    }
  }
})
