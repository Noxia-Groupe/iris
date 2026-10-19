import { createHmac } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

type Compte = { id: string; name: string; email: string; role: string };

async function pageDe(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: ['chantiers:read', 'clients:read'] })]);
  return page;
}

// Lot pilote 3b (décision de Nelson du 17-10-2026) : le technicien saisit ses heures sur une
// intervention SAV hors contrat. L'administration en voit le coût de main-d'œuvre (décision du
// 19-10-2026) ; aucun matériel ne se saisit hors contrat.
test('le technicien saisit ses heures sur une curative hors contrat ; l’administration en voit le coût, sans saisie de matériel', async ({ allerSurPageAdmin, session, request, creerClient, browser }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const technicien: Compte = await envoyer('post', '/users', { email: `heures.curative.${suffixe}@iris.test`, name: `Technicien heures ${suffixe}`, role: 'TECHNICIEN' });
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche heures ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const client = await creerClient('heures-curative');
  const titre = `Dépannage hors contrat ${suffixe}`;
  const curative = await envoyer('post', '/interventions', { clientId: client.id, titre });
  const jour = dateDuJour().split('-').reverse().join('-');
  await envoyer('put', `/interventions/${curative.id}/planning`, { dateDebut: jour, creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30', intervenantIds: [fiche.id] });

  // 1. Le technicien saisit ses heures sur sa curative ; aucun formulaire de matériel.
  const vue = await pageDe(browser, technicien);
  try {
    await vue.goto('/interventions', { waitUntil: 'networkidle' });
    const carte = vue.locator('article', { hasText: titre });
    const enregistrer = carte.getByRole('button', { name: 'Enregistrer mes heures' });
    await expect(enregistrer, 'formulaire d’heures proposé sur la curative').toBeVisible();
    await carte.getByPlaceholder('Date (JJ-MM-AAAA)').fill(dateDuJour());
    await carte.getByPlaceholder('Heures').fill('1,5');
    await carte.getByPlaceholder('Commentaire').fill('Remplacement du détecteur');
    const saisie = vue.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interventions/${curative.id}/couts/heures`));
    await enregistrer.click();
    expect((await saisie).status()).toBe(201);
    await expect(carte.getByText(`${dateDuJour()} — 1.5 h — Remplacement du détecteur`)).toBeVisible();
    await expect(carte.getByRole('button', { name: 'Enregistrer l’achat matériel' })).toHaveCount(0);
  } finally {
    await vue.context().close();
  }

  // 2. L'administration voit le coût de main-d'œuvre (1,5 h × 40 €), sans formulaire de matériel.
  const admin = await allerSurPageAdmin('/interventions');
  const carteAdmin = admin.locator('article', { hasText: titre });
  await expect(carteAdmin.getByText(/Coût réel cumulé : 60,00\s€ HT/)).toBeVisible();
  await expect(carteAdmin.getByRole('button', { name: 'Enregistrer l’achat matériel' })).toHaveCount(0);
});
