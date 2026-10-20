import { createHmac } from 'node:crypto';
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test';
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

async function pageTelephone(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: ['chantiers:read', 'clients:read'] })]);
  return page;
}

async function dessinerSignature(page: Page, zone: Locator) {
  await zone.scrollIntoViewIfNeeded();
  const cadre = await zone.boundingBox();
  if (!cadre) throw new Error('zone de signature invisible');
  const points = [[0.1, 0.6], [0.22, 0.3], [0.34, 0.7], [0.48, 0.35], [0.62, 0.65], [0.8, 0.4]];
  const position = ([x, y]: number[]) => [cadre.x + cadre.width * x, cadre.y + cadre.height * y] as const;
  await page.mouse.move(...position(points[0]));
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...position(point), { steps: 6 });
  await page.mouse.up();
}

const decaler = (jour: string, n: number) => new Date(Date.parse(`${jour}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Un technicien relié à sa fiche, un client avec site et contact, et ses interventions autour du jour.
// Aucun nom ne contient « jour » : la base est partagée, et un libellé de liste qui le contiendrait
// répondrait au champ « Jour » d'un autre parcours.
async function preparerJournee(request: APIRequestContext, token: string, creerClient: (libelle: string) => Promise<{ id: string }>) {
  const headers = { Authorization: `Bearer ${token}` };
  const envoyer = async (methode: 'get' | 'post' | 'put' | 'patch', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const technicien: Compte = await envoyer('post', '/users', { email: `ma-j.${suffixe}@iris.test`, name: `Technicien MJ ${suffixe}`, role: 'TECHNICIEN' });
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche MJ ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const client = await creerClient(`ma-j-${suffixe}`);
  const site = (await envoyer('get', `/clients/${client.id}`)).sites[0];
  const contact = await envoyer('post', `/clients/${client.id}/contacts`, { prenom: 'Alice', nom: 'Martin', telephone: '06 12 34 56 78' });
  const aujourdhui = dateDuJour().split('-').reverse().join('-');
  const intervention = async (titre: string, planification: object) => {
    const creee = await envoyer('post', '/interventions', { clientId: client.id, siteId: site.id, contactId: contact.id, titre: `${titre} ${suffixe}` });
    await envoyer('put', `/interventions/${creee.id}/planning`, { intervenantIds: [fiche.id], ...planification });
    return { ...creee, titre: `${titre} ${suffixe}` };
  };
  return {
    technicien, aujourdhui, envoyer,
    principale: await intervention('Chaudière en panne', { dateDebut: aujourdhui, creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30' }),
    matin: await intervention('Contrôle du matin', { dateDebut: aujourdhui, creneau: 'MATIN' }),
    hier: await intervention('Reprise d’hier', { dateDebut: decaler(aujourdhui, -1), creneau: 'APRES_MIDI' }),
    demain: await intervention('Visite de demain', { dateDebut: decaler(aujourdhui, 1), creneau: 'JOURNEE' }),
  };
}

// Lot pilote 3b-4 : « Ma journée » à l'accueil du technicien, puis la fiche de l'intervention pour
// agir sur place, à 375 px, sans fenêtre du navigateur.
test('sur téléphone, le technicien suit sa journée, appelle le contact et mène l’intervention depuis sa fiche', async ({ session, request, creerClient, browser }) => {
  const { technicien, aujourdhui, principale, matin, hier, demain } = await preparerJournee(request, session.token, creerClient);
  const page = await pageTelephone(browser, technicien);
  const fenetres: string[] = [];
  page.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
  try {
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Ma journée' })).toBeVisible();
    await expect(page.getByText(/^Aujourd’hui, /)).toBeVisible();
    const duJour = page.getByRole('region', { name: 'Interventions du jour' });
    // Le matin avant 8 h 30.
    await expect(duJour.locator('article h3')).toHaveText([matin.titre, principale.titre]);
    const carte = duJour.locator('article', { hasText: principale.titre });
    await expect(carte.getByText('Adresse : 2 rue du Parcours, 14000 Caen')).toBeVisible();
    await expect(carte.getByText(/· 08:30–09:30$/)).toBeVisible();
    await expect(carte.getByRole('link', { name: '06 12 34 56 78' })).toHaveAttribute('href', 'tel:0612345678');
    await expect(page.getByRole('region', { name: 'Restées ouvertes les jours précédents' }).locator('article h3')).toHaveText([hier.titre]);
    // Rien ne dépasse la largeur du téléphone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await expect(duJour.locator('article h3')).toHaveText([demain.titre]);
    await expect(page.getByText(/^Aujourd’hui, /)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Restées ouvertes les jours précédents' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Aujourd’hui' }).click();
    await expect(duJour.locator('article h3')).toHaveText([matin.titre, principale.titre]);
    await page.getByRole('button', { name: 'Jour précédent' }).click();
    await expect(duJour.locator('article h3')).toHaveText([hier.titre]);
    await expect(page.getByRole('region', { name: 'Restées ouvertes les jours précédents' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Aujourd’hui' }).click();
    await expect(duJour.locator('article h3')).toHaveText([matin.titre, principale.titre]);

    await carte.getByRole('link', { name: 'Ouvrir la fiche' }).click();
    await expect(page).toHaveURL(new RegExp(`/interventions/${principale.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Fiche intervention' })).toBeVisible();
    const fiche = page.locator('article', { hasText: principale.titre });
    await expect(page.locator('article')).toHaveCount(1);
    await expect(fiche.getByRole('link', { name: '06 12 34 56 78' })).toHaveAttribute('href', 'tel:0612345678');
    await fiche.getByRole('button', { name: 'Démarrer' }).click();
    await expect(fiche.getByText('En cours', { exact: true })).toBeVisible();

    await fiche.getByRole('button', { name: 'Ajouter un compte rendu' }).click();
    const compteRendu = fiche.getByRole('dialog', { name: 'Compte rendu d’intervention' });
    await compteRendu.getByLabel('Texte du compte rendu').fill('Brûleur nettoyé, chaudière relancée.');
    await compteRendu.getByRole('button', { name: 'Enregistrer le compte rendu' }).click();
    await expect(fiche.getByText('Brûleur nettoyé, chaudière relancée.')).toBeVisible();

    await fiche.getByRole('button', { name: 'Faire signer ce compte rendu' }).click();
    const signature = fiche.getByRole('dialog', { name: 'Signature du client' });
    await signature.getByLabel('Nom du signataire client').fill('Alice Martin');
    await signature.getByLabel('Confirmation du client').check();
    await dessinerSignature(page, signature.getByRole('img', { name: 'Zone de signature du client' }));
    await signature.getByRole('button', { name: 'Enregistrer la signature' }).click();
    await expect(fiche.getByRole('img', { name: 'Signature de Alice Martin' })).toBeVisible();

    await fiche.getByPlaceholder('Date (JJ-MM-AAAA)').fill(dateDuJour());
    await fiche.getByPlaceholder('Heures').fill('1,5');
    await fiche.getByPlaceholder('Commentaire').fill('Dépannage chaudière');
    await fiche.getByRole('button', { name: 'Enregistrer mes heures' }).click();
    await expect(fiche.getByText(/— 1\.5 h — Dépannage chaudière/)).toBeVisible();

    await fiche.getByRole('button', { name: 'Terminer' }).click();
    await fiche.getByRole('dialog', { name: 'Terminer l’intervention' }).getByRole('button', { name: 'Confirmer la fin de l’intervention' }).click();
    await expect(fiche.getByText('Terminée', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    // Retour à la journée : l'intervention passe parmi les terminées.
    await page.getByRole('link', { name: '← Ma journée' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Ma journée' })).toBeVisible();
    await expect(duJour.locator('article h3')).toHaveText([matin.titre]);
    await expect(page.getByRole('region', { name: 'Terminées ce jour' }).locator('article h3')).toHaveText([principale.titre]);
    expect(aujourdhui).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fenetres).toEqual([]);
  } finally {
    await page.context().close();
  }
});

// Une fiche hors de ses dossiers est introuvable, sans rien en révéler.
test('la fiche d’une intervention qui n’est pas affectée au technicien est introuvable', async ({ session, request, creerClient, browser }) => {
  const { technicien, envoyer } = await preparerJournee(request, session.token, creerClient);
  const autreClient = await creerClient(`ma-j-autre-${Date.now()}`);
  const etrangere = await envoyer('post', '/interventions', { clientId: autreClient.id, titre: `Dossier d’un autre ${Date.now()}` });
  const page = await pageTelephone(browser, technicien);
  try {
    await page.goto(`/interventions/${etrangere.id}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Fiche intervention' })).toBeVisible();
    await expect(page.getByText('Intervention introuvable : annulée, ou retirée de vos dossiers.')).toBeVisible();
    await expect(page.getByText(etrangere.titre)).toHaveCount(0);
    await page.route(`**/api/interventions/${etrangere.id}`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Erreur lors de la lecture de l’intervention.' }) }));
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('Erreur lors de la lecture de l’intervention.')).toBeVisible();
    await expect(page.getByText('Intervention introuvable : annulée, ou retirée de vos dossiers.')).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
