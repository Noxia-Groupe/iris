import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre
// une session dans un rôle autre que super administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Lot (a), décision de Nelson du 13-10-2026 : Administration > Journal indique qui a changé quoi,
// avant et après, filtrable et exportable en CSV ; un simple administrateur n'y voit pas
// l'historique des clés d'intégration, réservé au super administrateur (14-10-2026).
test('un administrateur consulte, filtre et exporte le journal, sans les entrées réservées au super administrateur', async ({ browser, request, session }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const suffixe = Date.now();
  const creation = await request.post(`${api}/users`, { headers, data: { email: `journal.e2e.${suffixe}@iris.test`, name: `Admin journal ${suffixe}`, role: 'ADMIN' } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  const admin = await creation.json() as { id: string; name: string; email: string; role: string };
  const adminHeaders = { Authorization: `Bearer ${jetonPour(admin.id)}` };
  const avant = await (await request.get(`${api}/parametres`, { headers })).json() as { joursSansSaisie: number | null };
  const jours = avant.joursSansSaisie === 17 ? 18 : 17;
  const cle = await request.post(`${api}/admin/api-keys`, { headers, data: { nom: `Clé journal ${suffixe}`, scopes: ['clients:read'] } });
  expect(cle.ok(), await cle.text()).toBeTruthy();
  const { key } = await cle.json() as { key: { id: string } };
  const contexte = await browser.newContext({ acceptDownloads: true });
  try {
    const reglage = await request.put(`${api}/parametres`, { headers: adminHeaders, data: { joursSansSaisie: jours } });
    expect(reglage.ok(), await reglage.text()).toBeTruthy();

    const page = await contexte.newPage();
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(admin.id), JSON.stringify({ ...admin, permissions: [] })]);
    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    const tableau = page.getByRole('table', { name: 'Entrées du journal' });
    const ligne = tableau.locator('tr', { hasText: `Admin journal ${suffixe}` }).filter({ hasText: 'Jours sans saisie' }).first();
    await expect(ligne).toContainText('Paramètres (marge, acompte, alertes, destinataires)');
    await expect(ligne).toContainText(`Jours sans saisie : ${avant.joursSansSaisie ?? '—'}`);
    await expect(ligne).toContainText(`Jours sans saisie : ${jours}`);
    await expect(ligne.locator('td').first()).toHaveText(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/);
    // La création du compte de l'administrateur par le super administrateur lui reste visible :
    // elle ne concerne pas un compte super administrateur.
    await expect(tableau).toContainText(`Admin journal ${suffixe} (journal.e2e.${suffixe}@iris.test)`);
    // Historique des clés d'intégration : ni dans le tableau, ni proposé au filtre.
    await expect(page.getByText(`Clé journal ${suffixe}`)).toHaveCount(0);
    const filtres = page.getByRole('form', { name: 'Filtres du journal' });
    await expect(filtres.getByLabel('Type').locator('option', { hasText: 'Clés d’intégration' })).toHaveCount(0);
    // Pas de réglage de la conservation pour un simple administrateur.
    await expect(page.getByRole('form', { name: 'Conservation du journal' })).toHaveCount(0);

    // Filtre par auteur et par type.
    await filtres.getByLabel('Auteur').selectOption({ label: `Admin journal ${suffixe}` });
    await filtres.getByLabel('Type').selectOption({ label: 'Paramètres (marge, acompte, alertes, destinataires)' });
    await filtres.getByRole('button', { name: 'Filtrer' }).click();
    await expect(tableau.locator('tbody tr')).toHaveCount(1);
    await expect(tableau.locator('tbody tr')).toContainText(`Jours sans saisie : ${jours}`);
    await expect(page.getByText('1 entrée', { exact: true })).toBeVisible();

    // Export CSV des entrées filtrées.
    const telechargement = page.waitForEvent('download');
    await filtres.getByRole('button', { name: 'Exporter en CSV' }).click();
    const fichier = await telechargement;
    expect(fichier.suggestedFilename()).toMatch(/^journal-parametres-droits-\d{2}-\d{2}-\d{4}\.csv$/);
    const contenu = await readFile(await fichier.path() as string, 'utf8');
    expect(contenu.startsWith('﻿Date;Heure;Auteur;Domaine;Type;Action;Cible;Avant;Après;Détail\n')).toBeTruthy();
    expect(contenu).toContain(`"Admin journal ${suffixe}";"REGLAGES";"PARAMETRES";"MODIFICATION"`);
    expect(contenu).toContain(`"joursSansSaisie : ${jours}"`);

    // Export sans filtre : toujours aucune entrée de clé d'intégration.
    await filtres.getByLabel('Auteur').selectOption({ label: 'Tous' });
    await filtres.getByLabel('Type').selectOption({ label: 'Tous' });
    await filtres.getByRole('button', { name: 'Filtrer' }).click();
    await expect(tableau.locator('tbody tr').nth(1)).toBeVisible();
    const telechargementComplet = page.waitForEvent('download');
    await filtres.getByRole('button', { name: 'Exporter en CSV' }).click();
    const complet = await readFile(await (await telechargementComplet).path() as string, 'utf8');
    expect(complet).toContain(`Admin journal ${suffixe} (journal.e2e.${suffixe}@iris.test)`);
    expect(complet).not.toContain(`Clé journal ${suffixe}`);
    expect(complet).not.toContain('"CLE_INTEGRATION"');
  } finally {
    await contexte.close();
    await request.put(`${api}/parametres`, { headers, data: { joursSansSaisie: avant.joursSansSaisie } });
    await request.post(`${api}/admin/api-keys/${key.id}/revoke`, { headers });
  }
});

test('le super administrateur voit l’historique des clés d’intégration et règle la conservation', async ({ allerSurPageAdmin, request, session }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const suffixe = Date.now();
  const cle = await request.post(`${api}/admin/api-keys`, { headers, data: { nom: `Clé super ${suffixe}`, scopes: ['clients:read'] } });
  expect(cle.ok(), await cle.text()).toBeTruthy();
  const { key } = await cle.json() as { key: { id: string } };
  try {
    const page = await allerSurPageAdmin('/admin');
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    const ligne = page.getByRole('table', { name: 'Entrées du journal' }).locator('tr', { hasText: `Clé super ${suffixe}` });
    await expect(ligne).toContainText('Clés d’intégration');
    await expect(ligne).toContainText('Création');
    await expect(ligne).toContainText('scopes : clients:read');
    const conservation = page.getByRole('form', { name: 'Conservation du journal' });
    await conservation.getByLabel(/Durée de conservation/).fill('60');
    await conservation.getByRole('button', { name: 'Enregistrer la durée' }).click();
    await expect(page.getByRole('status')).toHaveText('Durée de conservation : 60 jours.');
    await expect(page.getByText('Les entrées sont conservées 60 jours.')).toBeVisible();
  } finally {
    await request.put(`${api}/journal-administration/conservation`, { headers, data: { jours: 90 } });
    await request.post(`${api}/admin/api-keys/${key.id}/revoke`, { headers });
  }
});
