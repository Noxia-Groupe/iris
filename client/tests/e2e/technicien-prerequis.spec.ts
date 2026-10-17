import { createHmac } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { test, expect } from './fixtures';

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

// Lot pilote 3a : l'administration relie le compte du technicien à sa fiche intervenant, place
// une intervention curative depuis la file du planning, et le technicien la retrouve, avec un
// planning en consultation seule et sans l'Administration.
test('le technicien relié à sa fiche reçoit une curative placée depuis la file, et consulte le planning sans le modifier', async ({ allerSurPageAdmin, session, request, creerClient, browser }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const technicien: Compte = await envoyer('post', '/users', { email: `pilote3.technicien.${suffixe}@iris.test`, name: `Technicien pilote3 ${suffixe}`, role: 'TECHNICIEN' });
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche pilote3 ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 38 });
  const client = await creerClient('pilote3-curative');
  const curative = await envoyer('post', '/interventions', { clientId: client.id, titre: `Panne alarme pilote3 ${suffixe}`, dateSouhaitee: '15-12-2099' });

  // 1. Administration > Intervenants : relier le compte à la fiche.
  const admin = await allerSurPageAdmin('/admin');
  await admin.getByRole('button', { name: 'Intervenants', exact: true }).click();
  const selecteur = admin.getByLabel(`Compte technicien de ${fiche.nom}`);
  await expect(selecteur).toHaveValue('');
  const lien = admin.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/intervenants/${fiche.id}/compte`));
  await selecteur.selectOption(technicien.id);
  expect((await lien).ok()).toBeTruthy();
  await expect(selecteur).toHaveValue(technicien.id);

  // 2. Planning : la curative est dans la file, sans contrat, avec sa date souhaitée et une durée proposée.
  await admin.goto('/planning', { waitUntil: 'networkidle' });
  const ligne = admin.getByRole('row', { name: new RegExp(curative.reference) });
  await expect(ligne).toContainText('SAV hors contrat');
  await expect(ligne.getByRole('cell').first()).toHaveText('15-12-2099');
  await ligne.getByRole('button', { name: 'Placer' }).click();
  const dialogue = admin.getByRole('dialog', { name: new RegExp(curative.reference) });
  await expect(dialogue.getByLabel('Jour')).toHaveValue('15-12-2099');
  await expect(dialogue.getByLabel('Durée (minutes)')).toHaveValue('60');
  await dialogue.getByLabel('Technicien').selectOption(fiche.id);
  await dialogue.getByLabel('Heure de début').fill('08:30');
  await dialogue.getByRole('button', { name: 'Confirmer le placement' }).click();
  await expect(dialogue).not.toBeVisible();
  await expect(ligne).not.toBeVisible();

  // 3. Le technicien retrouve sa curative ; planning en consultation seule, sans Administration.
  const vue = await pageDe(browser, technicien);
  try {
    await vue.goto('/interventions', { waitUntil: 'networkidle' });
    await expect(vue.getByText(`Panne alarme pilote3 ${suffixe}`)).toBeVisible();
    await expect(vue.getByRole('link', { name: 'Administration' })).toHaveCount(0);
    await vue.goto('/planning', { waitUntil: 'networkidle' });
    await expect(vue.getByText('Consultation seule')).toBeVisible();
    await expect(vue.getByRole('button', { name: /Affectation/ })).toHaveCount(0);
    await expect(vue.getByRole('button', { name: /Types d'événements/ })).toHaveCount(0);
    await expect(vue.getByRole('region', { name: 'Interventions à planifier' })).toHaveCount(0);
    await vue.goto('/admin', { waitUntil: 'networkidle' });
    await expect(vue).toHaveURL(/\/$/);
  } finally {
    await vue.context().close();
  }
});
