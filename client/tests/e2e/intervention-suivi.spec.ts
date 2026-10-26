import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext, Browser } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Intervention de suivi liée, première PR (décisions de Nelson des 24 et 26-10-2026) : le technicien qui
// termine coche « Terminé » ou « À suivre » ; l'intervention terminée « à suivre » apparaît dans la file
// des interventions à planifier, d'où l'encadrement crée sa suite, une nouvelle intervention liée qui
// reprend le client, le site et le contact ; la marque disparaît alors, et les deux fiches portent le lien.

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre une
// session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

type Compte = { id: string; name: string; email: string; role: string };
type Intervention = { id: string; reference: string; titre: string };

async function pageTelephone(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: ['chantiers:read', 'clients:read'] })]);
  return page;
}

async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string) => Promise<{ id: string }>, libelle: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const envoyer = async (methode: 'get' | 'post' | 'put' | 'patch', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const technicien: Compte = await envoyer('post', '/users', { email: `${libelle}.${suffixe}@iris.test`, name: `Technicien ${libelle} ${suffixe}`, role: 'TECHNICIEN' });
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche ${libelle} ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const client = await creerClient(`${libelle} ${suffixe}`);
  const jour = dateDuJour().split('-').reverse().join('-');
  // Intervention en cours, affectée au technicien, avec un compte rendu : il ne reste qu'à la terminer.
  const enCours = async (titre: string): Promise<Intervention> => {
    const intervention = await envoyer('post', '/interventions', { clientId: client.id, titre: `${titre} ${suffixe}`, priorite: 'HAUTE' }) as Intervention;
    await envoyer('put', `/interventions/${intervention.id}/planning`, { dateDebut: jour, creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30', intervenantIds: [fiche.id] });
    await envoyer('patch', `/interventions/${intervention.id}/statut`, { statut: 'EN_COURS' });
    await envoyer('post', `/interventions/${intervention.id}/rapports`, { contenu: 'Pièce à commander, retour nécessaire.', cleEnvoi: randomUUID() });
    return intervention;
  };
  return { technicien, envoyer, enCours };
}

test('le technicien termine « à suivre » ; l’encadrement crée la suite depuis la file du planning ; la marque disparaît et les fiches portent le lien', async ({ session, request, creerClient, browser, allerSurPageAdmin }) => {
  const { technicien, envoyer, enCours } = await preparer(request, session.token, creerClient, 'suivi-file');
  const initiale = await enCours('Dépannage à suivre');

  // 1. Sur téléphone, le technicien termine sans signature, en cochant « À suivre ».
  const telephone = await pageTelephone(browser, technicien);
  await telephone.goto('/interventions', { waitUntil: 'networkidle' });
  const carte = telephone.locator('article', { hasText: initiale.titre });
  await carte.getByRole('button', { name: 'Terminer', exact: true }).click();
  const cloture = carte.getByRole('dialog', { name: 'Terminer l’intervention' });
  await cloture.getByRole('radio', { name: 'Client absent' }).check();
  // « Terminé » est proposé d'office.
  await expect(cloture.getByRole('radio', { name: 'Terminé', exact: true })).toBeChecked();
  await cloture.getByRole('radio', { name: 'À suivre : une autre intervention est nécessaire' }).check();
  const fin = telephone.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/interventions/${initiale.id}/statut`));
  await cloture.getByRole('button', { name: 'Terminer sans signature' }).click();
  expect(JSON.parse((await fin).request().postData() || '{}')).toMatchObject({ statut: 'TERMINEE', aSuivre: true, motifSansSignature: 'CLIENT_ABSENT' });
  await expect(cloture).toHaveCount(0);
  await expect(carte.getByText('À suivre', { exact: true })).toBeVisible();
  // Le technicien peut retirer la marque, pas la poser, ni créer la suite.
  await expect(carte.getByRole('button', { name: 'Retirer la marque « à suivre »' })).toBeVisible();
  await expect(carte.getByRole('button', { name: 'Créer la suite' })).toHaveCount(0);
  await telephone.context().close();

  // 2. L'encadrement la trouve dans la file du planning, marquée, et crée sa suite au lieu de la placer.
  const page = await allerSurPageAdmin('/planning');
  const file = page.getByRole('region', { name: 'Interventions à planifier' });
  const ligne = file.getByRole('row', { name: new RegExp(initiale.reference) });
  await expect(ligne).toContainText('À suivre');
  await expect(ligne.getByRole('button', { name: 'Placer' })).toHaveCount(0);
  await ligne.getByRole('button', { name: 'Créer la suite' }).click();
  const dialogue = page.getByRole('dialog', { name: `Créer la suite de ${initiale.reference}` });
  await expect(dialogue.getByLabel('Titre de la suite')).toHaveValue(`Suite — ${initiale.titre}`);
  await expect(dialogue.getByLabel('Priorité')).toHaveValue('HAUTE');
  await dialogue.getByLabel('Date souhaitée (JJ-MM-AAAA, facultative)').fill('15-03-2099');
  const creation = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interventions/${initiale.id}/suites`));
  await dialogue.getByRole('button', { name: 'Créer la suite' }).click();
  const reponse = await creation;
  expect(reponse.status()).toBe(201);
  const suite = await reponse.json() as Intervention;
  await expect(dialogue).toHaveCount(0);
  await expect(file.getByRole('status')).toHaveText(`Suite ${suite.reference} créée : elle est dans la file, à placer.`);
  // L'intervention initiale quitte la file ; la suite y entre, à placer.
  await expect(file.getByRole('row', { name: new RegExp(initiale.reference) })).toHaveCount(0);
  const ligneSuite = file.getByRole('row', { name: new RegExp(suite.reference) });
  await expect(ligneSuite.getByRole('button', { name: 'Placer' })).toBeVisible();
  await expect(ligneSuite).not.toContainText('À suivre');

  // 3. Côté serveur : marque retirée, lien posé, client repris.
  const ficheInitiale = await envoyer('get', `/interventions/${initiale.id}`) as { aSuivre: boolean; suites: Intervention[] };
  expect(ficheInitiale.aSuivre).toBe(false);
  expect(ficheInitiale.suites.map((lien) => lien.id)).toEqual([suite.id]);

  // 4. Les fiches portent le lien, dans les deux sens.
  await page.goto(`/interventions/${suite.id}`, { waitUntil: 'networkidle' });
  await expect(page.getByText(`Suite de ${initiale.reference}`)).toBeVisible();
  await page.getByRole('link', { name: initiale.reference }).click();
  await expect(page).toHaveURL(new RegExp(`/interventions/${initiale.id}$`));
  await expect(page.getByRole('link', { name: suite.reference })).toBeVisible();
});

test('depuis la fiche, l’encadrement marque « à suivre », crée la suite (un refus s’affiche dans le dialogue) et retire la marque', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, enCours } = await preparer(request, session.token, creerClient, 'suivi-fiche');
  const terminee = await enCours('Visite terminée');
  await envoyer('patch', `/interventions/${terminee.id}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });

  const page = await allerSurPageAdmin(`/interventions/${terminee.id}`);
  const carte = page.locator('article', { hasText: terminee.titre });
  await expect(carte.getByText('À suivre', { exact: true })).toHaveCount(0);
  await carte.getByRole('button', { name: 'Marquer « à suivre »' }).click();
  await expect(carte.getByText('À suivre', { exact: true })).toBeVisible();
  await expect(carte.getByRole('button', { name: 'Marquer « à suivre »' })).toHaveCount(0);

  // Un refus du serveur s'affiche dans le dialogue, qui reste ouvert avec la saisie.
  await carte.getByRole('button', { name: 'Créer la suite' }).click();
  const dialogue = page.getByRole('dialog', { name: `Créer la suite de ${terminee.reference}` });
  await dialogue.getByLabel('Titre de la suite').fill('Retour avec la pièce commandée');
  const chemin = `**/api/interventions/${terminee.id}/suites`;
  await page.route(chemin, async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Conflit concurrent : la suite n’a pas été créée.' }) });
    await page.unroute(chemin);
  });
  await dialogue.getByRole('button', { name: 'Créer la suite' }).click();
  await expect(dialogue.getByRole('alert')).toHaveText('Conflit concurrent : la suite n’a pas été créée.');
  await expect(dialogue.getByLabel('Titre de la suite')).toHaveValue('Retour avec la pièce commandée');
  // Date mal écrite : refusée à l'écran, sans requête.
  await dialogue.getByLabel('Date souhaitée (JJ-MM-AAAA, facultative)').fill('2099-03-15');
  let envois = 0;
  page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith(`/interventions/${terminee.id}/suites`)) envois++; });
  await dialogue.getByRole('button', { name: 'Créer la suite' }).click();
  await expect(dialogue.getByRole('alert')).toHaveText('La date souhaitée s’écrit au format JJ-MM-AAAA.');
  expect(envois).toBe(0);
  await dialogue.getByLabel('Date souhaitée (JJ-MM-AAAA, facultative)').fill('');
  await dialogue.getByRole('button', { name: 'Créer la suite' }).click();
  await expect(dialogue).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('créée : elle est dans la file des interventions à planifier.');
  // La marque a disparu avec la création de la suite ; la fiche cite la suite.
  await expect(carte.getByText('À suivre', { exact: true })).toHaveCount(0);
  await expect(carte).toContainText('Suite : ');

  // Marquée de nouveau puis retirée depuis la fiche.
  await carte.getByRole('button', { name: 'Marquer « à suivre »' }).click();
  await expect(carte.getByText('À suivre', { exact: true })).toBeVisible();
  await carte.getByRole('button', { name: 'Retirer la marque « à suivre »' }).click();
  await expect(carte.getByText('À suivre', { exact: true })).toHaveCount(0);
  const journal = await envoyer('get', `/interventions/${terminee.id}/journal-saisies`) as Array<{ action: string; motif: string | null }>;
  expect(journal.slice(0, 3).map((entree) => [entree.action, entree.motif])).toEqual([
    ['MARQUE_A_SUIVRE', 'Marque « à suivre » retirée'], ['MARQUE_A_SUIVRE', 'Marquée « à suivre »'], ['SUITE_CREEE', expect.stringMatching(/^Suite créée : I\d{2}-\d{4}$/)],
  ]);
});
