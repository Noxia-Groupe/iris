import { createHmac } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

type Compte = { id: string; name: string };

// Décisions de Nelson (14-10-2026) : le formulaire de l'Administration ouvre le chantier d'une
// affaire sans erreur, une seule fois par affaire, et un chantier se réattribue à un autre
// conducteur depuis sa fiche, par exemple au départ de son conducteur.
async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string, avecSite?: boolean) => Promise<{ id: string }>, cle: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const creerCompte = async (role: string, nom: string): Promise<Compte> =>
    envoyer('post', '/users', { email: `ouverture.${cle}.${role.toLowerCase()}.${nom.length}.${suffixe}@iris.test`, name: `${nom} ${suffixe}`, role });
  const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'Conducteur partant');
  const remplacant = await creerCompte('CONDUCTEUR_TRAVAUX', 'Conducteur remplaçant');
  const commercial = await creerCompte('COMMERCIAL', 'Commercial ouverture');
  const client = await creerClient(`ouverture-${cle}`, false);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Ouverture ${cle} E2E ${suffixe}`, lignes: [
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20 },
  ] }) as { id: string; numero: string; objet: string; clientId: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  return { headers, envoyer, conducteur, remplacant, commercial, devis };
}

test('l’Administration ouvre le chantier d’une affaire une seule fois, puis le réattribue depuis la fiche au départ du conducteur', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  test.slow();
  const { headers, envoyer, conducteur, remplacant, commercial, devis } = await preparer(request, session.token, creerClient, 'complet');
  const admin = await allerSurPageAdmin('/admin');
  await expect(admin.getByRole('heading', { name: 'Ouvrir le chantier d’une affaire' })).toBeVisible();

  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await expect(admin.getByText(`Chantier « ${devis.objet} »`)).toContainText('vendu 100,00 € HT');
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  // Préremplie au jour de la société, au format JJ-MM-AAAA.
  await expect(admin.getByLabel('Date de début')).toHaveValue(/^\d{2}-\d{2}-\d{4}$/);
  await admin.getByLabel('Date de début').fill('05-10-2026');
  await admin.getByRole('checkbox', { name: 'Vidéo' }).check();

  const ouverture = admin.waitForResponse((r) => r.url().endsWith(`/api/devis/${devis.id}/convertir`) && r.request().method() === 'POST');
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  expect((await ouverture).status()).toBe(201);
  const confirmation = admin.getByRole('status').filter({ hasText: `pour l’affaire ${devis.numero}` });
  await expect(confirmation).toBeVisible();
  // Le devis converti n'est plus proposé, et le chantier rejoint la liste avec son titulaire.
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
  const carte = admin.locator('div.p-4').filter({ has: admin.getByRole('link', { name: devis.objet }) });
  await expect(carte).toContainText(`Responsable : ${conducteur.name}`);

  const chantiers = await (await request.get(`${api}/chantiers`, { headers })).json() as { id: string; numeroDevis: string }[];
  const ouverts = chantiers.filter((c) => c.numeroDevis === devis.numero);
  expect(ouverts).toHaveLength(1);
  const chantierId = ouverts[0].id;
  const fiche = await (await request.get(`${api}/chantiers/${chantierId}`, { headers })).json() as { responsable: Compte; commercial: Compte; types: string[]; dateDebut: string };
  expect(fiche.responsable.id).toBe(conducteur.id);
  expect(fiche.commercial.id).toBe(commercial.id);
  expect(fiche.types).toEqual(['Vidéo']);
  expect(fiche.dateDebut).toBe('2026-10-05T00:00:00.000Z');
  // Chaque affaire a son chantier : une seconde conversion est refusée.
  const seconde = await request.post(`${api}/devis/${devis.id}/convertir`, { headers, data: { cible: 'CHANTIER' } });
  expect(seconde.status()).toBe(409);

  // Départ du conducteur et du commercial : leurs comptes sont désactivés, puis le chantier est
  // confié à un autre conducteur depuis la fiche, sans passer par l'API ; le commercial désactivé
  // reste rattaché.
  await envoyer('patch', `/users/${conducteur.id}/actif`, { actif: false });
  await envoyer('patch', `/users/${commercial.id}/actif`, { actif: false });
  await confirmation.getByRole('link', { name: 'Ouvrir la fiche du chantier' }).click();
  await admin.getByRole('button', { name: 'Modifier' }).first().click();
  const titulaire = admin.locator('select[name="responsableId"]');
  await expect(titulaire.locator('option:checked')).toHaveText(`${conducteur.name} (hors des conducteurs actifs)`);
  await expect(admin.locator('select[name="commercialId"] option:checked')).toHaveText(`${commercial.name} (hors des commerciaux actifs)`);
  await titulaire.selectOption(remplacant.id);
  // Le commercial, inchangé, n'est pas renvoyé.
  const appelsCommercial: string[] = [];
  admin.on('request', (r) => { if (r.url().endsWith(`/api/chantiers/${chantierId}/commercial`)) appelsCommercial.push(r.method()); });
  const enregistrement = admin.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantierId}`) && r.request().method() === 'PATCH');
  await admin.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  expect((await enregistrement).status()).toBe(200);
  await expect(admin.getByRole('heading', { name: 'Modifier le chantier' })).toHaveCount(0);
  expect(appelsCommercial).toEqual([]);
  const relu = await (await request.get(`${api}/chantiers/${chantierId}`, { headers })).json() as { responsable: Compte; commercial: Compte; dateDebut: string };
  expect(relu.responsable.id).toBe(remplacant.id);
  expect(relu.commercial.id).toBe(commercial.id);
  expect(relu.dateDebut).toBe('2026-10-05T00:00:00.000Z');
});

// Un refus du serveur s'affiche au lieu d'être ignoré : ici, le devis a été converti par un
// autre écran entre l'affichage du formulaire et son envoi.
test('l’ouverture d’un devis converti entre-temps est refusée avec un message, et le devis n’est plus proposé', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'concurrent');
  const admin = await allerSurPageAdmin('/admin');
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  const ailleurs = await request.post(`${api}/devis/${devis.id}/convertir`, { headers, data: { cible: 'CHANTIER' } });
  expect(ailleurs.status()).toBe(201);

  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'Ce devis a déjà été converti' })).toBeVisible();
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
  const chantiers = await (await request.get(`${api}/chantiers`, { headers })).json() as { numeroDevis: string }[];
  expect(chantiers.filter((c) => c.numeroDevis === devis.numero)).toHaveLength(1);
});

// Un devis annulé entre l'affichage du formulaire et son envoi : le refus (400) s'affiche, et la
// liste relue ne le propose plus.
test('l’ouverture d’un devis annulé entre-temps est refusée avec un message, et le devis n’est plus proposé', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'annule');
  const admin = await allerSurPageAdmin('/admin');
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  const annulation = await request.post(`${api}/devis/${devis.id}/annulation`, { headers, data: { motif: 'Annulé pendant le formulaire E2E' } });
  expect(annulation.status(), await annulation.text()).toBe(200);

  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'Ce devis est annulé' })).toBeVisible();
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
});

// Le conducteur choisi est désactivé pendant le formulaire (départ, par exemple) : le refus
// s'affiche, et la liste relue revient au choix vide au lieu de passer en silence au premier
// conducteur restant. L'envoi suivant est bloqué tant qu'un conducteur n'est pas rechoisi.
test('un conducteur désactivé pendant le formulaire n’est remplacé par aucun autre', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, envoyer, conducteur, remplacant, commercial, devis } = await preparer(request, session.token, creerClient, 'desactive');
  const admin = await allerSurPageAdmin('/admin');
  const conversions: number[] = [];
  admin.on('response', (r) => { if (r.url().endsWith(`/api/devis/${devis.id}/convertir`)) conversions.push(r.status()); });
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  const responsable = admin.getByLabel('Responsable du chantier');
  await responsable.selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  await envoyer('patch', `/users/${conducteur.id}/actif`, { actif: false });

  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'Conducteur responsable introuvable' })).toBeVisible();
  await expect(responsable.locator(`option[value="${conducteur.id}"]`)).toHaveCount(0);
  await expect(responsable.locator(`option[value="${remplacant.id}"]`)).toHaveCount(1);
  await expect(responsable).toHaveValue('');
  await expect(admin.getByLabel('Commercial rattaché')).toHaveValue(commercial.id);
  // Sans conducteur rechoisi, le navigateur bloque l'envoi : aucune autre conversion.
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  expect(await responsable.evaluate((el: HTMLSelectElement) => el.validity.valueMissing)).toBe(true);
  await admin.waitForLoadState('networkidle');
  expect(conversions).toEqual([400]);
  const chantiers = await (await request.get(`${api}/chantiers`, { headers })).json() as { numeroDevis: string }[];
  expect(chantiers.filter((c) => c.numeroDevis === devis.numero)).toHaveLength(0);
});

// Même règle pour le commercial : désactivé pendant le formulaire, il n'est remplacé par aucun
// autre commercial resté actif ; le responsable, toujours valide, est conservé.
test('un commercial désactivé pendant le formulaire n’est remplacé par aucun autre', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, envoyer, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'commercial-desactive');
  const autreCommercial = await envoyer('post', '/users', { email: `ouverture.commercial-desactive.autre.${Date.now()}@iris.test`, name: `Autre commercial actif ${Date.now()}`, role: 'COMMERCIAL' }) as Compte;
  const admin = await allerSurPageAdmin('/admin');
  const conversions: number[] = [];
  admin.on('response', (r) => { if (r.url().endsWith(`/api/devis/${devis.id}/convertir`)) conversions.push(r.status()); });
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  const listeCommercial = admin.getByLabel('Commercial rattaché');
  await listeCommercial.selectOption(commercial.id);
  await envoyer('patch', `/users/${commercial.id}/actif`, { actif: false });

  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'Commercial introuvable' })).toBeVisible();
  await expect(listeCommercial.locator(`option[value="${commercial.id}"]`)).toHaveCount(0);
  await expect(listeCommercial.locator(`option[value="${autreCommercial.id}"]`)).toHaveCount(1);
  await expect(listeCommercial).toHaveValue('');
  await expect(admin.getByLabel('Responsable du chantier')).toHaveValue(conducteur.id);
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  expect(await listeCommercial.evaluate((el: HTMLSelectElement) => el.validity.valueMissing)).toBe(true);
  await admin.waitForLoadState('networkidle');
  expect(conversions).toEqual([400]);
  const chantiers = await (await request.get(`${api}/chantiers`, { headers })).json() as { numeroDevis: string }[];
  expect(chantiers.filter((c) => c.numeroDevis === devis.numero)).toHaveLength(0);
});

// Après une ouverture réussie, le formulaire repart à vide pour l'affaire suivante : devis,
// responsable, commercial et types vidés, date revenue au jour de la société.
test('après une ouverture, le formulaire repart à vide pour l’affaire suivante', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { envoyer, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'remise-a-zero');
  // Un second devis prêt garde le formulaire affiché après la première ouverture.
  const second = await envoyer('post', '/devis', { clientId: devis.clientId, objet: `Seconde affaire E2E ${Date.now()}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }) as { id: string };
  await envoyer('put', `/devis/${second.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${second.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const admin = await allerSurPageAdmin('/admin');
  const date = admin.getByLabel('Date de début');
  await expect(date).toHaveValue(/^\d{2}-\d{2}-\d{4}$/);
  const jourDeLaSociete = await date.inputValue();
  // Une date saisie différente du jour, pour que sa remise au jour soit observable.
  const autreJour = jourDeLaSociete === '05-10-2026' ? '06-10-2026' : '05-10-2026';
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  await date.fill(autreJour);
  await admin.getByRole('checkbox', { name: 'Vidéo' }).check();
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('status').filter({ hasText: `pour l’affaire ${devis.numero}` })).toBeVisible();

  await expect(admin.getByLabel('Devis signé de l’affaire')).toHaveValue('');
  await expect(admin.locator(`#ouverture-devis option[value="${second.id}"]`)).toHaveCount(1);
  await expect(admin.getByLabel('Responsable du chantier')).toHaveValue('');
  await expect(admin.getByLabel('Commercial rattaché')).toHaveValue('');
  await expect(date).toHaveValue(jourDeLaSociete);
  await expect(admin.getByRole('checkbox', { name: 'Vidéo' })).not.toBeChecked();
});

// Sans réponse à l'ouverture, le chantier a pu être ouvert : le message ne l'affirme ni ne le nie,
// et la saisie reste pour réessayer.
test('sans réponse du serveur à l’ouverture, le message ne conclut pas', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'ouverture-reseau');
  const admin = await allerSurPageAdmin('/admin');
  await admin.route(`**/api/devis/${devis.id}/convertir`, (route) => route.abort('failed'));
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'L’ouverture du chantier n’a pas pu être confirmée : impossible de joindre le serveur.' })).toBeVisible();
  await expect(admin.getByLabel('Devis signé de l’affaire')).toHaveValue(devis.id);
  await expect(admin.getByLabel('Responsable du chantier')).toHaveValue(conducteur.id);
});

// La conversion aboutit côté serveur, mais sa réponse est perdue : le message ne conclut pas, le
// devis converti disparaît du formulaire, son chantier apparaît dans la liste, et les choix
// encore valides restent pour la suite.
test('une ouverture dont la réponse est perdue retire le devis et montre le chantier', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, envoyer, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'reponse-perdue');
  // Un second devis prêt garde le formulaire affiché une fois le premier converti, quel que soit
  // l'état de la base laissé par les autres tests.
  const second = await envoyer('post', '/devis', { clientId: devis.clientId, objet: `Seconde affaire réponse perdue ${Date.now()}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }) as { id: string };
  await envoyer('put', `/devis/${second.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${second.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const admin = await allerSurPageAdmin('/admin');
  let statutServeur = 0;
  await admin.route(`**/api/devis/${devis.id}/convertir`, async (route) => {
    const reponse = await route.fetch();
    statutServeur = reponse.status();
    await route.abort('failed');
  });
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  await admin.getByLabel('Date de début').fill('07-10-2026');
  await admin.getByRole('checkbox', { name: 'Vidéo' }).check();
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'L’ouverture du chantier n’a pas pu être confirmée' })).toHaveText('L’ouverture du chantier n’a pas pu être confirmée : impossible de joindre le serveur. Vérifiez la liste des chantiers avant de réessayer.');
  expect(statutServeur).toBe(201);
  await expect(admin.locator(`#ouverture-devis option[value="${second.id}"]`)).toHaveCount(1);
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
  await expect(admin.getByLabel('Devis signé de l’affaire')).toHaveValue('');
  await expect(admin.getByLabel('Responsable du chantier')).toHaveValue(conducteur.id);
  await expect(admin.getByLabel('Commercial rattaché')).toHaveValue(commercial.id);
  await expect(admin.getByLabel('Date de début')).toHaveValue('07-10-2026');
  await expect(admin.getByRole('checkbox', { name: 'Vidéo' })).toBeChecked();
  await expect(admin.getByRole('link', { name: devis.objet })).toBeVisible();
  const chantiers = await (await request.get(`${api}/chantiers`, { headers })).json() as { numeroDevis: string }[];
  expect(chantiers.filter((c) => c.numeroDevis === devis.numero)).toHaveLength(1);
});

// Une relecture plus ancienne qui répond après une plus récente est ignorée : elle remettrait
// dans la liste un devis converti entre-temps.
test('une relecture dépassée ne remet pas un devis converti dans la liste', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, envoyer, conducteur, remplacant, commercial, devis } = await preparer(request, session.token, creerClient, 'relecture-depassee');
  const admin = await allerSurPageAdmin('/admin');
  let retarder = false;
  let relectureRetardeeEnvoyee = false;
  let relectureRetardeeServie = false;
  await admin.route('**/api/devis/a-convertir', async (route) => {
    if (!retarder) return route.continue();
    retarder = false;
    const reponse = await route.fetch();
    await new Promise((fin) => setTimeout(fin, 3000));
    relectureRetardeeEnvoyee = true;
    await route.fulfill({ response: reponse });
    relectureRetardeeServie = true;
  });
  // Seconde tentative : le serveur convertit, mais la réponse est perdue.
  await admin.route(`**/api/devis/${devis.id}/convertir`, async (route) => {
    if ((route.request().postDataJSON() as { responsableId: string }).responsableId === conducteur.id) return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  await envoyer('patch', `/users/${conducteur.id}/actif`, { actif: false });
  retarder = true;
  // Premier refus : sa relecture (devis encore proposé) est retenue 3 s.
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'Conducteur responsable introuvable' })).toBeVisible();
  await admin.getByLabel('Responsable du chantier').selectOption(remplacant.id);
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'n’a pas pu être confirmée' })).toBeVisible();
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
  // Le test ne discrimine que si la relecture récente précède la relecture retenue : sinon, il
  // échoue ici plutôt que de passer sans rien vérifier.
  expect(relectureRetardeeEnvoyee, 'la relecture récente doit précéder la relecture dépassée').toBe(false);
  // La relecture dépassée arrive ensuite : le devis doit rester absent (attente bornée, pour un
  // constat d'absence).
  await expect.poll(() => relectureRetardeeServie, { timeout: 10_000 }).toBe(true);
  await admin.waitForTimeout(500);
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
  const chantiers = await (await request.get(`${api}/chantiers`, { headers })).json() as { numeroDevis: string }[];
  expect(chantiers.filter((c) => c.numeroDevis === devis.numero)).toHaveLength(1);
});

// Un chargement plus ancien qui échoue après qu'un plus récent a réussi n'affiche pas de bandeau
// d'erreur au-dessus de listes à jour.
test('l’échec d’un chargement dépassé n’affiche pas d’erreur', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { envoyer, conducteur, remplacant, commercial, devis } = await preparer(request, session.token, creerClient, 'echec-depasse');
  const admin = await allerSurPageAdmin('/admin');
  let echouerEnRetard = false;
  let echecEnvoye = false;
  let echecServi = false;
  await admin.route('**/api/devis/a-convertir', async (route) => {
    if (!echouerEnRetard) return route.continue();
    echouerEnRetard = false;
    await new Promise((fin) => setTimeout(fin, 3000));
    echecEnvoye = true;
    await route.fulfill({ status: 500, json: { error: 'Indisponible' } });
    echecServi = true;
  });
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  await admin.getByLabel('Commercial rattaché').selectOption(commercial.id);
  await envoyer('patch', `/users/${conducteur.id}/actif`, { actif: false });
  echouerEnRetard = true;
  // Refus : sa relecture échouera dans 3 s. L'ouverture suivante réussit et relit les listes.
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: 'Conducteur responsable introuvable' })).toBeVisible();
  await admin.getByLabel('Responsable du chantier').selectOption(remplacant.id);
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  await expect(admin.getByRole('status').filter({ hasText: `pour l’affaire ${devis.numero}` })).toBeVisible();
  // La relecture récente est appliquée (devis converti retiré) avant l'échec dépassé : sinon, le
  // test échoue ici plutôt que de passer sans rien vérifier.
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(0);
  expect(echecEnvoye, 'la relecture récente doit précéder l’échec dépassé').toBe(false);
  // L'échec dépassé arrive ensuite : aucun bandeau (attente bornée, pour un constat d'absence).
  await expect.poll(() => echecServi, { timeout: 10_000 }).toBe(true);
  await admin.waitForTimeout(500);
  await expect(admin.getByText('n’ont pas pu être chargés')).toHaveCount(0);
});

// Sans aucun commercial actif, la liste est désactivée et le chantier s'ouvre sans commercial,
// sans envoyer de commercial vide, que le serveur refuserait (comportement de la question 8).
test('sans commercial actif, le formulaire ouvre le chantier sans commercial', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, conducteur, devis } = await preparer(request, session.token, creerClient, 'sans-commercial');
  const admin = await allerSurPageAdmin('/admin');
  await admin.route('**/api/commerciaux', (route) => route.fulfill({ json: [] }));
  await admin.reload();
  await expect(admin.getByLabel('Commercial rattaché (aucun disponible)')).toBeDisabled();
  await admin.getByLabel('Devis signé de l’affaire').selectOption(devis.id);
  await admin.getByLabel('Responsable du chantier').selectOption(conducteur.id);
  const ouverture = admin.waitForResponse((r) => r.url().endsWith(`/api/devis/${devis.id}/convertir`));
  await admin.getByRole('button', { name: 'Ouvrir le chantier' }).click();
  const reponse = await ouverture;
  expect(reponse.status(), await reponse.text()).toBe(201);
  expect(Object.keys(reponse.request().postDataJSON() as object)).not.toContain('commercialId');
  const fiche = await (await request.get(`${api}/chantiers/${(await reponse.json() as { id: string }).id}`, { headers })).json() as { commercial: unknown };
  expect(fiche.commercial).toBeNull();
});

// Échec de lecture d'une des trois listes : message exact et aucun formulaire, puis « Réessayer »
// le fait apparaître. États vides : aucun devis prêt, aucun conducteur actif.
test('le formulaire d’ouverture signale un chargement en échec et ses listes vides', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { devis } = await preparer(request, session.token, creerClient, 'chargement');
  const admin = await allerSurPageAdmin('/admin');
  await expect(admin.getByLabel('Devis signé de l’affaire')).toBeVisible();

  // La liste des devis à convertir n'est lue que par ce formulaire : elle échoue jusqu'à
  // « Réessayer » (le chargement peut être lancé deux fois au montage, en développement).
  let enEchec = true;
  await admin.route('**/api/devis/a-convertir', (route) => (enEchec ? route.fulfill({ status: 500, json: { error: 'Indisponible' } }) : route.continue()));
  await admin.reload();
  const bandeau = admin.getByRole('alert').filter({ hasText: 'Les devis, conducteurs ou commerciaux n’ont pas pu être chargés.' });
  await expect(bandeau).toBeVisible();
  await expect(admin.getByLabel('Devis signé de l’affaire')).toHaveCount(0);
  enEchec = false;
  await bandeau.getByRole('button', { name: 'Réessayer' }).click();
  await expect(admin.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(1);
  await expect(bandeau).toHaveCount(0);
  await admin.unroute('**/api/devis/a-convertir');

  await admin.route('**/api/conducteurs', (route) => route.fulfill({ json: [] }));
  await admin.reload();
  await expect(admin.getByText('Aucun conducteur actif : créez ou réactivez un compte conducteur')).toBeVisible();
  await admin.unroute('**/api/conducteurs');

  await admin.route('**/api/devis/a-convertir', (route) => route.fulfill({ json: [] }));
  await admin.reload();
  await expect(admin.getByText('Aucun devis signé n’attend l’ouverture de son chantier.')).toBeVisible();
  await expect(admin.getByLabel('Devis signé de l’affaire')).toHaveCount(0);
});

// Formulaires voisins de l'Administration : un ajout refusé (nom déjà pris) est signalé, et la
// saisie conservée pour être corrigée.
test('un fournisseur déjà enregistré est refusé avec un message, sans vider la saisie', async ({ allerSurPageAdmin, request, session }) => {
  const nom = `Fournisseur doublon E2E ${Date.now()}`;
  const creation = await request.post(`${api}/fournisseurs`, { headers: { Authorization: `Bearer ${session.token}` }, data: { nom } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  const admin = await allerSurPageAdmin('/admin');
  await admin.getByRole('button', { name: 'Fournisseurs', exact: true }).click();
  const formulaire = admin.locator('form').filter({ has: admin.locator('input[name="nom"]') }).first();
  await formulaire.locator('input[name="nom"]').fill(nom);
  // L'alerte est acceptée dans l'écouteur même : sans écouteur actif, Playwright la fermerait
  // de lui-même, et une acceptation tardive resterait bloquée.
  let alerte = '';
  admin.once('dialog', (dialogue) => { alerte = dialogue.message(); void dialogue.accept(); });
  await formulaire.getByRole('button', { name: 'Enregistrer' }).click();
  await expect.poll(() => alerte).toBe('Un fournisseur porte déjà ce nom.');
  await expect(formulaire.locator('input[name="nom"]')).toHaveValue(nom);
});

// Le titulaire confie lui-même son chantier à un autre conducteur depuis la fiche : la
// réattribution aboutit sans alerte, et il retrouve sa liste, le chantier n'étant plus le sien.
// Avant, le commercial était enregistré après coup et refusé (« Chantier introuvable »).
test('un conducteur confie son chantier à un autre conducteur depuis la fiche, sans message d’erreur', async ({ browser, creerClient, request, session }) => {
  test.slow();
  const { headers, conducteur, remplacant, commercial, devis } = await preparer(request, session.token, creerClient, 'passation');
  const ouvert = await request.post(`${api}/devis/${devis.id}/convertir`, { headers, data: { cible: 'CHANTIER', responsableId: conducteur.id, commercialId: commercial.id } });
  expect(ouvert.status(), await ouvert.text()).toBe(201);
  const chantierId = (await ouvert.json() as { id: string }).id;

  const contexte = await browser.newContext();
  try {
    const page = await contexte.newPage();
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(conducteur.id), JSON.stringify({ ...conducteur, role: 'CONDUCTEUR_TRAVAUX', permissions: [] })]);
    const alertes: string[] = [];
    page.on('dialog', (dialog) => { alertes.push(dialog.message()); void dialog.accept(); });
    const appelsCommercial: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith(`/api/chantiers/${chantierId}/commercial`)) appelsCommercial.push(r.method()); });

    await page.goto(`/chantiers/${chantierId}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Modifier' }).first().click();
    await page.locator('select[name="responsableId"]').selectOption(remplacant.id);
    const enregistrement = page.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantierId}`) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
    expect((await enregistrement).status()).toBe(200);
    await expect(page).toHaveURL(/\/chantiers$/);
    expect(alertes).toEqual([]);
    expect(appelsCommercial, 'le commercial inchangé n’est pas renvoyé').toEqual([]);
  } finally {
    await contexte.close();
  }
  const relu = await (await request.get(`${api}/chantiers/${chantierId}`, { headers })).json() as { responsable: { id: string }; commercial: { id: string } };
  expect(relu.responsable.id).toBe(remplacant.id);
  expect(relu.commercial.id).toBe(commercial.id);
});

// Un refus de la fiche (ici une référence d'affaire déjà prise) laisse la fenêtre ouverte avec
// la saisie, pour corriger le champ refusé ; le message dit que le commercial, enregistré juste
// avant, l'est resté. Relire toute la fiche aurait démonté la fenêtre et vidé la saisie. Une fois
// la référence corrigée, la fiche s'enregistre sans renvoyer le commercial, et l'affiche.
test('un refus de la fiche garde la saisie, et le commercial déjà enregistré s’affiche', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  test.slow();
  const { headers, envoyer, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'refus');
  const suffixe = Date.now();
  const autreCommercial = await envoyer('post', '/users', { email: `ouverture.refus.autre.${suffixe}@iris.test`, name: `Autre commercial ${suffixe}`, role: 'COMMERCIAL' }) as Compte;
  const ouvert = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: conducteur.id, commercialId: commercial.id }) as { id: string; nom: string };
  // Une autre affaire, dont la référence est déjà portée par son chantier.
  const autreClient = await creerClient('ouverture-refus-autre', false);
  const autreDevis = await envoyer('post', '/devis', { clientId: autreClient.id, objet: `Autre affaire E2E ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }) as { id: string; numero: string };
  await envoyer('put', `/devis/${autreDevis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${autreDevis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  await envoyer('post', `/devis/${autreDevis.id}/convertir`, { cible: 'CHANTIER' });

  const admin = await allerSurPageAdmin(`/chantiers/${ouvert.id}`);
  const appelsCommercial: string[] = [];
  admin.on('request', (r) => { if (r.url().endsWith(`/api/chantiers/${ouvert.id}/commercial`)) appelsCommercial.push(r.method()); });
  await admin.getByRole('button', { name: 'Modifier' }).first().click();
  // Premier refus, commercial inchangé : le motif seul, et seule la fiche est envoyée.
  await admin.locator('input[name="numeroDevis"]').fill(autreDevis.numero);
  let premiereAlerte = '';
  admin.once('dialog', (dialogue) => { premiereAlerte = dialogue.message(); void dialogue.accept(); });
  await admin.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect.poll(() => premiereAlerte).toContain('déjà rattaché à un autre chantier');
  expect(premiereAlerte).not.toMatch(/commercial/i);
  expect(appelsCommercial).toEqual([]);
  const nouveauNom = `Nom corrigé E2E ${suffixe}`;
  await admin.locator('input[name="nom"]').fill(nouveauNom);
  await admin.locator('select[name="commercialId"]').selectOption(autreCommercial.id);
  await admin.locator('input[name="numeroDevis"]').fill(autreDevis.numero);
  let alerte = '';
  admin.once('dialog', (dialogue) => { alerte = dialogue.message(); void dialogue.accept(); });
  await admin.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect.poll(() => alerte).toContain('déjà rattaché à un autre chantier');
  expect(alerte).toMatch(/^Le commercial a été enregistré, mais pas les autres modifications : /);
  // La fenêtre et la saisie sont intactes.
  await expect(admin.getByRole('heading', { name: 'Modifier le chantier' })).toBeVisible();
  await expect(admin.locator('input[name="nom"]')).toHaveValue(nouveauNom);
  await expect(admin.locator('input[name="numeroDevis"]')).toHaveValue(autreDevis.numero);
  await expect(admin.locator('select[name="commercialId"]')).toHaveValue(autreCommercial.id);
  // Le commercial est enregistré, la fiche ne l'est pas.
  const relu = await (await request.get(`${api}/chantiers/${ouvert.id}`, { headers })).json() as { nom: string; commercial: Compte; numeroDevis: string };
  expect(relu.commercial.id).toBe(autreCommercial.id);
  expect(relu.nom).toBe(ouvert.nom);

  // Référence corrigée dans la même fenêtre : la fiche s'enregistre, et le commercial, déjà
  // enregistré, n'est pas renvoyé.
  await admin.locator('input[name="numeroDevis"]').fill(relu.numeroDevis);
  const enregistrement = admin.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${ouvert.id}`) && r.request().method() === 'PATCH');
  await admin.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  expect((await enregistrement).status()).toBe(200);
  await expect(admin.getByRole('heading', { name: 'Modifier le chantier' })).toHaveCount(0);
  expect(appelsCommercial).toEqual(['PATCH']);
  await expect(admin.getByText(nouveauNom).first()).toBeVisible();
  await expect(admin.getByText(autreCommercial.name).first()).toBeVisible();
  const final = await (await request.get(`${api}/chantiers/${ouvert.id}`, { headers })).json() as { nom: string; commercial: Compte; numeroDevis: string };
  expect(final.nom).toBe(nouveauNom);
  expect(final.commercial.id).toBe(autreCommercial.id);
  expect(final.numeroDevis).toBe(relu.numeroDevis);
});

// Le commercial enregistré, la fiche n'obtient pas de réponse : le message dit que le commercial
// l'est, sans affirmer ni nier l'enregistrement du reste, et la fenêtre garde la saisie.
test('sans réponse du serveur après l’enregistrement du commercial, le message le dit', async ({ allerSurPageAdmin, creerClient, request, session }) => {
  const { headers, envoyer, conducteur, commercial, devis } = await preparer(request, session.token, creerClient, 'reseau');
  const autreCommercial = await envoyer('post', '/users', { email: `ouverture.reseau.autre.${Date.now()}@iris.test`, name: `Autre commercial réseau ${Date.now()}`, role: 'COMMERCIAL' }) as Compte;
  const ouvert = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: conducteur.id, commercialId: commercial.id }) as { id: string; nom: string };
  const admin = await allerSurPageAdmin(`/chantiers/${ouvert.id}`);
  await admin.route(`**/api/chantiers/${ouvert.id}`, (route) => (route.request().method() === 'PATCH' ? route.abort('failed') : route.continue()));
  await admin.getByRole('button', { name: 'Modifier' }).first().click();
  const nomSaisi = `Nom sans réponse ${Date.now()}`;
  await admin.locator('input[name="nom"]').fill(nomSaisi);
  // Commercial inchangé : le message réseau seul.
  let premiereAlerte = '';
  admin.once('dialog', (dialogue) => { premiereAlerte = dialogue.message(); void dialogue.accept(); });
  await admin.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect.poll(() => premiereAlerte).toBe('Impossible de joindre le serveur.');
  // Autre commercial : enregistré, puis la fiche reste sans réponse.
  await admin.locator('select[name="commercialId"]').selectOption(autreCommercial.id);
  let alerte = '';
  admin.once('dialog', (dialogue) => { alerte = dialogue.message(); void dialogue.accept(); });
  await admin.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect.poll(() => alerte).toBe('Le commercial a été enregistré ; l’enregistrement des autres modifications n’a pas pu être confirmé : impossible de joindre le serveur.');
  // La fenêtre reste ouverte avec la saisie.
  await expect(admin.getByRole('heading', { name: 'Modifier le chantier' })).toBeVisible();
  await expect(admin.locator('input[name="nom"]')).toHaveValue(nomSaisi);
  await expect(admin.locator('select[name="commercialId"]')).toHaveValue(autreCommercial.id);
  const relu = await (await request.get(`${api}/chantiers/${ouvert.id}`, { headers })).json() as { nom: string; commercial: Compte };
  expect(relu.commercial.id).toBe(autreCommercial.id);
  expect(relu.nom).toBe(ouvert.nom);
});

// Écran Devis : un devis converti mène à la fiche de son chantier pour l'administration ; un autre
// porteur du droit devis (ici un commercial) lit « Chantier ouvert. », sans lien vers une fiche
// qu'il ne peut pas forcément consulter.
test('l’écran Devis ne donne le lien vers la fiche du chantier ouvert qu’à l’administration', async ({ allerSurPageAdmin, browser, creerClient, request, session }) => {
  const { envoyer, devis, commercial } = await preparer(request, session.token, creerClient, 'lien-devis');
  const ouvert = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  const admin = await allerSurPageAdmin('/devis');
  const ligneAdmin = admin.locator('li', { hasText: devis.numero });
  await expect(ligneAdmin.getByRole('link', { name: 'voir la fiche' })).toHaveAttribute('href', `/chantiers/${ouvert.id}`);
  // Ouvert depuis l'écran Devis, sans titulaire : la liste de l'Administration le signale.
  await admin.goto('/admin', { waitUntil: 'networkidle' });
  const carte = admin.locator('div.p-4').filter({ has: admin.getByRole('link', { name: devis.objet }) });
  await expect(carte).toContainText('Responsable : Non affecté — à attribuer depuis la fiche');

  const contexte = await browser.newContext();
  try {
    const page = await contexte.newPage();
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(commercial.id), JSON.stringify({ ...commercial, role: 'COMMERCIAL', permissions: ['devis:read', 'devis:write', 'clients:read', 'chantiers:read'] })]);
    await page.goto('/devis', { waitUntil: 'networkidle' });
    const ligne = page.locator('li', { hasText: devis.numero });
    await expect(ligne).toContainText('Chantier ouvert.');
    await expect(ligne.getByRole('link', { name: 'voir la fiche' })).toHaveCount(0);
  } finally {
    await contexte.close();
  }
});
