import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Cible du backend en développement (le proxy ci-dessous évite les soucis de CORS
// et permet d'utiliser le même chemin /api qu'en production).
const devApiTarget = process.env.VITE_DEV_API_TARGET || 'http://localhost:3001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: devApiTarget, changeOrigin: true },
      '/uploads': { target: devApiTarget, changeOrigin: true },
    },
  },
})
