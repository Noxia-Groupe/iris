import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Au moins 200 clients actifs classés avant « ZZZ » : le client du chantier est alors hors de la
// liste initiale de GET /api/clients, quelle que soit la base E2E (vierge ou conservée).
async function remplirAuDela(request: APIRequestContext, headers: Record<string, string>) {
  const liste = await (await request.get(`${api}/clients`, { headers })).json() as { clients: unknown[] };
  const manquants = 200 - liste.clients.length;
  for (let i = 0; i < manquants; i += 20) {
    const reponses = await Promise.all(Array.from({ length: Math.min(20, manquants - i) }, (_, j) =>
      request.post(`${api}/clients`, { headers, data: { raisonSociale: `E2E 111 fiche remplissage ${Date.now()} ${String(i + j).padStart(3, '0')}` } })));
    for (const reponse of reponses) expect(reponse.status(), await reponse.text()).toBe(201);
  }
}

// Enregistre la fiche et rend le corps du PATCH envoyé.
async function enregistrer(page: Page, chantierId: string) {
  const requete = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/api/chantiers/${chantierId}`));
  const reponse = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/api/chantiers/${chantierId}`));
  await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  const corps = JSON.parse((await requete).postData() || '{}') as Record<string, unknown>;
  const recu = await reponse;
  expect(recu.status(), await recu.text()).toBe(200);
  return corps;
}

// #111 : sur la fiche chantier, l'administration garde le client lié même hors des 200 premiers
// ou désactivé, le réaffecte à un autre client retrouvé par la recherche, et n'envoie le client
// que s'il change.
test('#111 : client de la fiche chantier hors des 200 premiers, réaffecté puis désactivé', async ({ allerSurPageAdmin, request, session }) => {
  test.slow();
  const headers = auth(session.token);
  await remplirAuDela(request, headers);
  const prefixe = `ZZZ E2E 111 fiche ${Date.now()}`;
  const creerClient = async (libelle: string) => {
    const reponse = await request.post(`${api}/clients`, { headers, data: { raisonSociale: `${prefixe} ${libelle}` } });
    expect(reponse.status(), await reponse.text()).toBe(201);
    return (await reponse.json()) as { id: string; raisonSociale: string };
  };
  const initial = await creerClient('initial');
  const autre = await creerClient('autre');
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const devis = await envoyer('post', '/devis', { clientId: initial.id, objet: `Fiche 111 ${prefixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  // La fiche exige un responsable et, dès qu'il existe un commercial, un commercial : on les fixe.
  const suffixe = Date.now();
  const conducteur = await envoyer('post', '/users', { email: `fiche111.conducteur.${suffixe}@iris.test`, name: `Conducteur fiche 111 ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as { id: string };
  const commercial = await envoyer('post', '/users', { email: `fiche111.commercial.${suffixe}@iris.test`, name: `Commercial fiche 111 ${suffixe}`, role: 'COMMERCIAL' }) as { id: string };
  for (const [chemin, data] of [[`/chantiers/${chantier.id}`, { responsableId: conducteur.id }], [`/chantiers/${chantier.id}/commercial`, { commercialId: commercial.id }]] as const) {
    const reponse = await request.patch(`${api}${chemin}`, { headers, data });
    expect(reponse.ok(), `${chemin} : ${await reponse.text()}`).toBeTruthy();
  }
  const lireChantier = async () => (await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json()) as { nom: string; clientId: string };
  // Témoin : le client lié est hors de la liste initiale des clients.
  expect((await (await request.get(`${api}/clients`, { headers })).json()).clients.some((c: { id: string }) => c.id === initial.id)).toBe(false);

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  const select = page.getByRole('combobox', { name: 'Client du chantier' });
  const nom = page.locator('input[name="nom"]');
  // Le bouton de la barre d'actions de la fiche (un second « Modifier » concerne le commercial).
  const ouvrirEdition = async () => {
    await page.getByRole('button', { name: 'Modifier', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Modifier le chantier' })).toBeVisible();
  };

  // 1. Le client lié est proposé et sélectionné ; enregistrer une autre modification ne l'envoie pas.
  await ouvrirEdition();
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue(initial.id);
  await expect(select.locator(`option[value="${initial.id}"]`)).toHaveText(initial.raisonSociale);
  await nom.fill(`${chantier.nom} renommé`);
  const corpsRenommage = await enregistrer(page, chantier.id);
  expect('clientId' in corpsRenommage).toBe(false);
  expect(await lireChantier()).toMatchObject({ nom: `${chantier.nom} renommé`, clientId: initial.id });

  // 2. Réaffectation à un autre client, retrouvé par la recherche.
  await ouvrirEdition();
  await page.getByRole('searchbox', { name: 'Rechercher un client' }).fill(`${prefixe} autre`);
  await expect(select.locator(`option[value="${autre.id}"]`)).toHaveCount(1);
  await select.selectOption(autre.id);
  await expect(select).toHaveValue(autre.id);
  const corpsReaffectation = await enregistrer(page, chantier.id);
  expect(corpsReaffectation.clientId).toBe(autre.id);
  expect((await lireChantier()).clientId).toBe(autre.id);

  // 3. Client désactivé depuis : il reste affiché, et la fiche s'enregistre sans le remplacer.
  const desactivation = await request.delete(`${api}/clients/${autre.id}`, { headers });
  expect(desactivation.ok(), await desactivation.text()).toBeTruthy();
  await page.reload({ waitUntil: 'networkidle' });
  await ouvrirEdition();
  await expect(select.locator(`option[value="${autre.id}"]`)).toHaveText(`${autre.raisonSociale} (client désactivé)`);
  await expect(select).toHaveValue(autre.id);
  await nom.fill(`${chantier.nom} client désactivé`);
  const corpsDesactive = await enregistrer(page, chantier.id);
  expect('clientId' in corpsDesactive).toBe(false);
  expect(await lireChantier()).toMatchObject({ nom: `${chantier.nom} client désactivé`, clientId: autre.id });

  // 4. Envoi pendant une recherche (sélecteur désactivé, hors du formulaire) : refus local, sans requête.
  const rechercheLente = `${prefixe} recherche lente`;
  await page.route((url) => url.pathname.endsWith('/api/clients') && url.searchParams.get('q') === rechercheLente, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await ouvrirEdition();
  let modifications = 0;
  page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname.endsWith(`/api/chantiers/${chantier.id}`)) modifications += 1; });
  await page.getByRole('searchbox', { name: 'Rechercher un client' }).fill(rechercheLente);
  await expect(select).toBeDisabled();
  // L'alerte bloque le clic tant qu'elle est ouverte : elle est acceptée dès son ouverture.
  let message = '';
  page.once('dialog', (alerte) => { message = alerte.message(); void alerte.accept(); });
  await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect.poll(() => message).toBe('Choisissez un client.');
  expect(modifications).toBe(0);
  expect((await lireChantier()).clientId).toBe(autre.id);
});
