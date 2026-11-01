import { defineConfig, devices } from '@playwright/test';

// Ces parcours lancent la vraie SPA via Vite et le backend compilé : une saisie de
// « 12,50 » doit être testée dans Chromium, pas seulement via jsdom ou l'API.
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5199';
const apiPort = process.env.E2E_API_PORT || '3001';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // La base est partagée et les numéros de facture sont chronologiques.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    locale: 'fr-FR',
    // Playwright attend exactement `timezoneId` (z minuscule) : `timeZoneId` est ignoré
    // silencieusement. Le parcours New York vérifie aussi le fuseau réellement appliqué.
    timezoneId: 'Europe/Paris',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node dist/index.js',
      cwd: '../server',
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env: {
        NODE_ENV: 'development',
        PORT: apiPort,
        DATABASE_URL: process.env.E2E_DATABASE_URL || '',
        JWT_SECRET: 'secret-e2e-uniquement',
        BREAK_GLASS_EMAIL: 'secours@iris.test',
        BREAK_GLASS_TOKEN: 'jeton-de-secours-e2e-au-moins-32-caracteres',
        SUPERADMIN_EMAILS: 'secours@iris.test',
        // Aucun passage quotidien de la génération des visites pendant les tests, même à minuit :
        // les visites ne se créent que par les actions des tests.
        GENERATION_VISITES_AUTOMATIQUE: '0',
        // Connexion Microsoft non configurée, même si `server/.env` la configure : dotenv ne remplace pas
        // une variable déjà posée, même vide. Les parcours de l'envoi par Microsoft 365 (lot 6b-2, N4 du
        // contrôle du cadrage) supposent la configuration de la CI, et simulent le reste dans le navigateur.
        AZURE_TENANT_ID: '',
        AZURE_CLIENT_ID: '',
      },
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npx vite --port ${new URL(baseURL).port} --host 127.0.0.1 --strictPort`,
      url: baseURL,
      env: { VITE_DEV_API_TARGET: `http://127.0.0.1:${apiPort}` },
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
