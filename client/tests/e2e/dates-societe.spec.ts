import { createHmac } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Décision de Nelson (14-10-2026) : toutes les dates suivent le jour et l'heure de la société,
// où que se trouve celui qui consulte Iris. Chaque parcours place le navigateur dans un autre
// fuseau que la société, à un instant où leurs jours diffèrent.

async function avecFuseauSociete(request: APIRequestContext, token: string, fuseau: string, parcours: () => Promise<void>) {
  const headers = { Authorization: `Bearer ${token}` };
  const initial = await (await request.get(`${api}/company`, { headers })).json() as { fuseauHoraire?: string | null };
  const maj = await request.put(`${api}/company`, { headers, data: { fuseauHoraire: fuseau } });
  expect(maj.ok(), await maj.text()).toBeTruthy();
  try {
    await parcours();
  } finally {
    const restauration = await request.put(`${api}/company`, { headers, data: { fuseauHoraire: initial.fuseauHoraire || 'Europe/Paris' } });
    expect(restauration.ok(), await restauration.text()).toBeTruthy();
  }
}

// Ouvre une page en session sans attendre la fin du réseau : une lecture peut y être retenue.
async function ouvrirSansAttendre(page: Page, chemin: string, token: string, user: object) {
  await page.addInitScript(([jeton, utilisateur]) => {
    localStorage.setItem('token', jeton as string);
    localStorage.setItem('user', utilisateur as string);
  }, [token, JSON.stringify(user)]);
  await page.goto(chemin, { waitUntil: 'domcontentloaded' });
}

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre
// une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Devis signé, prêt à ouvrir son chantier : le formulaire d'ouverture n'affiche ses champs
// qu'avec un tel devis.
async function signerDevisPret(request: APIRequestContext, token: string, creerClient: (libelle: string, avecSite?: boolean) => Promise<{ id: string }>, libelle: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const envoyer = async (path: string, methode: 'post' | 'put', data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const client = await creerClient(libelle, false);
  const devis = await envoyer('/devis', 'post', { clientId: client.id, objet: `${libelle} E2E ${Date.now()}`, lignes: [
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 50, tauxTva: 20 },
  ] }) as { id: string };
  await envoyer(`/devis/${devis.id}/statut`, 'put', { statut: 'ENVOYE' });
  await envoyer(`/devis/${devis.id}/signature`, 'post', { signataire: 'Client E2E', confirme: true });
  return devis;
}

// Avant la lecture du fuseau, un écran calcule sa période au fuseau par défaut (Europe/Paris) et
// la demande ; une fois le fuseau lu, il demande celle de la société. La lecture du fuseau est
// retenue jusqu'à la première demande, et la réponse à celle-ci jusqu'à l'affichage de la période
// de la société : arrivée la dernière, cette réponse dépassée ne doit pas l'écraser.
async function verifierReponseDepassee(page: Page, options: {
  demande: string;
  estDepassee: (url: URL) => boolean;
  ouvrir: () => Promise<void>;
  attendu: Locator;
  depasse?: Locator;
}) {
  let libererSociete = () => {};
  const societeRetenue = new Promise<void>((resolve) => { libererSociete = resolve; });
  let libererDepassee = () => {};
  const depasseeRetenue = new Promise<void>((resolve) => { libererDepassee = resolve; });
  let depasseeDemandee = false;
  await page.route('**/api/company', async (route) => {
    if (route.request().method() === 'GET') await societeRetenue;
    await route.continue();
  });
  await page.route(options.demande, async (route) => {
    if (options.estDepassee(new URL(route.request().url()))) {
      depasseeDemandee = true;
      libererSociete();
      await depasseeRetenue;
    }
    await route.continue();
  });
  try {
    await options.ouvrir();
    await expect(options.attendu).toBeVisible();
    expect(depasseeDemandee, 'la période du fuseau par défaut a d’abord été demandée').toBe(true);
    const reponseDepassee = page.waitForResponse((r) => r.request().method() === 'GET' && options.estDepassee(new URL(r.url())));
    libererDepassee();
    await (await reponseDepassee).finished();
    // Laisse à la page le temps d'appliquer cette réponse, si elle ne l'écartait pas.
    await page.waitForTimeout(500);
    await expect(options.attendu).toBeVisible();
    if (options.depasse) await expect(options.depasse).toHaveCount(0);
  } finally {
    libererSociete();
    libererDepassee();
  }
}

test.describe('navigateur à Gambier, société à Wallis : périodes', () => {
  test.use({ timezoneId: 'Pacific/Gambier' });

  // 31-10-2026 à 13:00 UTC : déjà le 1er novembre à Wallis, encore le 31 octobre à Paris (fuseau
  // par défaut de l'écran), en UTC et à Gambier. Le mois affiché est celui de la société.
  test('les statistiques ouvrent le mois de la société, et une réponse dépassée ne l’écrase pas', async ({ page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-31T13:00:00Z') });
    await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
      await verifierReponseDepassee(page, {
        demande: '**/api/stats/types-chantiers?*',
        estDepassee: (url) => url.searchParams.get('ref') === '2026-10-31',
        ouvrir: async () => {
          await ouvrirSansAttendre(page, '/statistiques', session.token, session.user);
          await page.getByRole('button', { name: 'Types de chantiers' }).click();
        },
        attendu: page.getByText('Novembre 2026', { exact: true }),
        depasse: page.getByText('Octobre 2026', { exact: true }),
      });
      await page.getByTitle('Période précédente').click();
      await expect(page.getByText('Octobre 2026', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: "Aujourd'hui" }).click();
      await expect(page.getByText('Novembre 2026', { exact: true })).toBeVisible();
    });
  });

  test('« Mes commerciaux » ouvre le mois de la société, et une réponse dépassée ne l’écrase pas', async ({ page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-31T13:00:00Z') });
    await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
      await verifierReponseDepassee(page, {
        demande: '**/api/stats/commerciaux?*',
        estDepassee: (url) => url.searchParams.get('ref') === '2026-10-31',
        ouvrir: () => ouvrirSansAttendre(page, '/commerciaux', session.token, session.user),
        attendu: page.getByText('Novembre 2026', { exact: true }),
        depasse: page.getByText('Octobre 2026', { exact: true }),
      });
    });
  });

  test('« Résultat commercial » ouvre le mois de la société, et une réponse dépassée ne l’écrase pas', async ({ page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-31T13:00:00Z') });
    const headers = { Authorization: `Bearer ${session.token}` };
    const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const creation = await request.post(`${api}/users`, { headers, data: { email: `dates.periode.commercial.${suffixe}@iris.test`, name: `Commercial période ${suffixe}`, role: 'COMMERCIAL' } });
    expect(creation.ok(), await creation.text()).toBeTruthy();
    const commercial = await creation.json() as { id: string; name: string; email: string };
    await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
      await verifierReponseDepassee(page, {
        demande: '**/api/stats/commerciaux?*',
        estDepassee: (url) => url.searchParams.get('ref') === '2026-10-31',
        ouvrir: () => ouvrirSansAttendre(page, '/resultat-commercial', jetonPour(commercial.id), { ...commercial, role: 'COMMERCIAL', permissions: [] }),
        attendu: page.getByText('Novembre 2026', { exact: true }),
        depasse: page.getByText('Octobre 2026', { exact: true }),
      });
    });
  });

  // Dimanche 18-10-2026 à 13:00 UTC : semaine du 12 à Paris (et à Gambier), lundi 19 à Wallis.
  test('les performances ouvrent la semaine de la société, et une réponse dépassée ne l’écrase pas', async ({ page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-18T13:00:00Z') });
    await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
      await verifierReponseDepassee(page, {
        demande: '**/api/stats/conducteurs/assiduite?*',
        estDepassee: (url) => url.searchParams.get('week') === '2026-10-18',
        ouvrir: () => ouvrirSansAttendre(page, '/performances', session.token, session.user),
        attendu: page.getByText(/Semaine du 19\/10 au 23\/10/),
        depasse: page.getByText(/Semaine du 12\/10/),
      });
    });
  });

  test('le planning garde les affectations de la semaine de la société malgré une réponse dépassée', async ({ page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-18T13:00:00Z') });
    const headers = { Authorization: `Bearer ${session.token}` };
    const intervenant = await request.post(`${api}/intervenants`, { headers, data: { nom: `Intervenant période E2E ${Date.now()}`, role: 'Technicien', tauxHoraireCharge: 40 } });
    expect(intervenant.ok(), await intervenant.text()).toBeTruthy();
    const { id: intervenantId } = await intervenant.json() as { id: string };
    const titre = `Affectation du 19-10 E2E ${Date.now()}`;
    const evenement = await request.post(`${api}/planning/events`, { headers, data: { categorie: 'HORS_CHANTIER', dateDebut: '2026-10-19', titre, intervenantIds: [intervenantId] } });
    expect(evenement.ok(), await evenement.text()).toBeTruthy();
    const { id: evenementId } = await evenement.json() as { id: string };
    try {
      await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
        await verifierReponseDepassee(page, {
          demande: '**/api/planning/events?*',
          estDepassee: (url) => url.searchParams.get('start') === '2026-10-12',
          ouvrir: () => ouvrirSansAttendre(page, '/planning', session.token, session.user),
          attendu: page.getByText(titre),
        });
        await expect(page.getByRole('button', { name: 'Semaine 43' })).toBeVisible();
      });
    } finally {
      await request.delete(`${api}/planning/events/${evenementId}`, { headers });
      await request.delete(`${api}/intervenants/${intervenantId}`, { headers });
    }
  });
});

test.describe('navigateur à Gambier, société à Nouméa : fiche chantier', () => {
  test.use({ timezoneId: 'Pacific/Gambier' });

  // Un chantier converti avant ce lot commence à un instant : 14-10-2026 à 13:30 UTC, soit le
  // 15-10 à 00:30 à Nouméa (encore le 14 à Paris, fuseau par défaut, en UTC et à Gambier). La
  // fiche l'affiche et le préremplit au 15, et enregistrer la fiche sans y toucher garde le 15
  // (avant, le jour UTC était réenregistré : le 14). Lue le 16 à 23:00 à Nouméa, elle compte un
  // jour civil écoulé, et non 46 h 30 arrondies à 2 jours ; le 17 à 00:30 à Nouméa (encore le 16
  // en UTC), deux. Le formulaire est ouvert pendant que la lecture du fuseau est retenue : il
  // montre d'abord le jour du fuseau par défaut, puis celui de la société une fois le fuseau lu.
  // Le journal des saisies rend la date d'un achat en JJ-MM-AAAA, à sa création, sa correction,
  // son archivage et sa restauration, et laisse tel quel un texte libre qui ressemble à une date
  // sans en être une (la fiche ne doit pas planter).
  test('la fiche lit un début horodaté au jour de la société, et l’enregistre sans le décaler', async ({ creerClient, page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-16T12:00:00Z') });
    const headers = { Authorization: `Bearer ${session.token}` };
    const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
      const response = await request[methode](`${api}${path}`, { headers, data });
      expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
      return response.json();
    };
    const suffixe = Date.now();
    const conducteur = await envoyer('post', '/users', { email: `dates.conducteur.${suffixe}@iris.test`, name: `Conducteur dates ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as { id: string };
    const commercial = await envoyer('post', '/users', { email: `dates.commercial.${suffixe}@iris.test`, name: `Commercial dates ${suffixe}`, role: 'COMMERCIAL' }) as { id: string };
    const client = await creerClient('dates-fiche', false);
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Dates fiche E2E ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    // Début réel distinct de la date attendue après enregistrement (15-10-2026), quel que soit le
    // jour où le test tourne.
    const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: conducteur.id, commercialId: commercial.id, dateDebut: '01-10-2026' }) as { id: string };
    const fournisseur = await envoyer('post', '/fournisseurs', { nom: `Fournisseur dates ${suffixe}` }) as { id: string };
    const categorie = await envoyer('post', '/categories', { nom: `Catégorie dates ${suffixe}` }) as { id: string };
    const achat = await envoyer('post', '/achats', { date: '14-10-2026', fournisseurId: fournisseur.id, categorieId: categorie.id, description: '2026-13-01T10:00:00Z', montantHT: 10, chantierId: chantier.id }) as { id: string };
    const correction = await request.patch(`${api}/achats/${achat.id}`, { headers, data: { montantHT: 12, motifCorrection: 'Montant corrigé E2E' } });
    expect(correction.ok(), await correction.text()).toBeTruthy();
    const archivage = await request.delete(`${api}/achats/${achat.id}`, { headers, data: { motifArchivage: 'Archivage E2E' } });
    expect(archivage.ok(), await archivage.text()).toBeTruthy();
    const restauration = await request.post(`${api}/achats/${achat.id}/restaurer`, { headers, data: { motifRestauration: 'Restauration E2E' } });
    expect(restauration.ok(), await restauration.text()).toBeTruthy();

    await page.route(`**/api/chantiers/${chantier.id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const reponse = await route.fetch();
      const corps = await reponse.json();
      await route.fulfill({ response: reponse, json: { ...corps, dateDebut: '2026-10-14T13:30:00.000Z' } });
    });
    const ficheRelue = (r: { url(): string; request(): { method(): string } }) => r.url().endsWith(`/api/chantiers/${chantier.id}`) && r.request().method() === 'GET';
    const avant = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { dateDebut: string; dateFin: string | null };
    await avecFuseauSociete(request, session.token, 'Pacific/Noumea', async () => {
      let libererSociete = () => {};
      const societeRetenue = new Promise<void>((resolve) => { libererSociete = resolve; });
      await page.route('**/api/company', async (route) => {
        if (route.request().method() === 'GET') await societeRetenue;
        await route.continue();
      });
      try {
        await ouvrirSansAttendre(page, `/chantiers/${chantier.id}`, session.token, session.user);
        await expect(page.getByText('Démarré le 14-10-2026')).toBeVisible();
        await page.getByRole('button', { name: 'Modifier' }).first().click();
        // Tant que le fuseau n'est pas lu, les dates ne se modifient pas : une saisie serait effacée
        // au moment où le champ se recale sur le jour de la société.
        await expect(page.locator('input[name="dateDebut"]')).toHaveValue('14-10-2026');
        await expect(page.locator('input[name="dateDebut"]')).toBeDisabled();
        await expect(page.locator('input[name="dateFin"]')).toBeDisabled();
        // Enregistrée avant la lecture du fuseau, la fiche garde ses dates : désactivées, elles ne
        // partent pas avec elle.
        const nouveauNom = `Dates fiche renommée E2E ${suffixe}`;
        await page.locator('input[name="nom"]').fill(nouveauNom);
        const envoi = page.waitForRequest((r) => r.url().endsWith(`/api/chantiers/${chantier.id}`) && r.method() === 'PATCH');
        const relectureSansFuseau = page.waitForResponse(ficheRelue);
        await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
        const corps = (await envoi).postDataJSON() as Record<string, unknown>;
        expect(Object.keys(corps)).not.toContain('dateDebut');
        expect(Object.keys(corps)).not.toContain('dateFin');
        await relectureSansFuseau;
        const renommee = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { nom: string; dateDebut: string; dateFin: string | null };
        expect(renommee).toMatchObject({ nom: nouveauNom, dateDebut: avant.dateDebut, dateFin: avant.dateFin });
        await page.getByRole('button', { name: 'Modifier' }).first().click();
        await expect(page.locator('input[name="dateDebut"]')).toBeDisabled();
      } finally {
        libererSociete();
      }
      await expect(page.locator('input[name="dateDebut"]')).toBeEnabled();
      await expect(page.locator('input[name="dateDebut"]')).toHaveValue('15-10-2026');
      await expect(page.getByText('Démarré le 15-10-2026 (il y a 1 j)')).toBeVisible();
      for (const libelle of [/^Valeurs enregistrées : /, /^Avant : /, /^Après : /, /^Valeurs archivées : /, /^Valeurs restaurées : /]) {
        await expect(page.getByText(libelle)).toContainText('"date":"14-10-2026"');
        await expect(page.getByText(libelle)).toContainText('"description":"2026-13-01T10:00:00Z"');
      }
      const enregistrement = page.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantier.id}`) && r.request().method() === 'PATCH');
      // La fiche se relit après l'enregistrement : le test attend la fin de cette relecture, que sa
      // route réécrit, pour ne pas se terminer pendant qu'elle est en cours.
      const relecture = page.waitForResponse(ficheRelue);
      await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
      const reponse = await enregistrement;
      expect(reponse.status()).toBe(200);
      expect((reponse.request().postDataJSON() as Record<string, unknown>).dateDebut).toBe('15-10-2026');
      await relecture;
      const relu = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { dateDebut: string };
      expect(relu.dateDebut).toBe('2026-10-15T00:00:00.000Z');

      // Le 16 à 13:30 UTC, déjà le 17 à 00:30 à Nouméa : deux jours civils écoulés (le jour UTC
      // n'en compterait qu'un).
      await page.clock.setSystemTime(new Date('2026-10-16T13:30:00Z'));
      const rechargement = page.waitForResponse(ficheRelue);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await rechargement;
      await expect(page.getByText('Démarré le 15-10-2026 (il y a 2 j)')).toBeVisible();
    });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});

test.describe('navigateur à Cayenne, société à Wallis', () => {
  test.use({ timezoneId: 'America/Cayenne' });

  // Dimanche 18-10-2026 à 13:00 UTC : 10 h le dimanche à Cayenne, déjà lundi 19 à 1 h à Wallis.
  test('le planning ouvre la semaine et surligne le jour de la société', async ({ allerSurPageAdmin, page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-18T13:00:00Z') });
    const headers = { Authorization: `Bearer ${session.token}` };
    // La grille n'apparaît qu'avec au moins un intervenant.
    const intervenant = await request.post(`${api}/intervenants`, { headers, data: { nom: `Intervenant dates E2E ${Date.now()}`, role: 'Technicien', tauxHoraireCharge: 40 } });
    expect(intervenant.ok(), await intervenant.text()).toBeTruthy();
    const { id } = await intervenant.json() as { id: string };
    try {
      await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
        await allerSurPageAdmin('/planning');
        await expect(page.getByRole('button', { name: 'Semaine 43' })).toBeVisible();
        await expect(page.locator('thead th', { hasText: '19-10' })).toHaveClass(/bg-blue-50/);
        await expect(page.locator('thead th', { hasText: '18-10' })).toHaveCount(0);
      });
    } finally {
      await request.delete(`${api}/intervenants/${id}`, { headers });
    }
  });

  // La page publique n'a pas de session : elle prend le jour, la semaine et le fuseau de la
  // société dans la réponse du serveur, simulée ici pour un instant donné.
  test('le planning public suit le jour et le fuseau de la société renvoyés par le serveur', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-14T13:00:00Z') });
    const demandes: string[] = [];
    await page.route('**/api/planning/public/**', async (route) => {
      demandes.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ events: [], intervenants: [], fuseauHoraire: 'Pacific/Wallis', aujourdhui: '2026-10-15', debut: '2026-10-12', fin: '2026-10-18' }),
      });
    });
    await page.goto('/planning/public/jeton-e2e-dates', { waitUntil: 'networkidle' });
    // Première demande sans plage : le serveur choisit la semaine de la société.
    expect(new URL(demandes[0]).search).toBe('');
    await expect(page.getByText('12 – 18 octobre 2026')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Semaine 42' })).toBeVisible();
    // Le jeudi 15 (Wallis) est « Aujourd'hui », et non le mercredi 14 de Cayenne.
    await expect(page.getByText("Aujourd'hui", { exact: true }).locator('..')).toContainText('jeudi 15 octobre');
    // 13:00 UTC = 01:00 à Wallis.
    await expect(page.getByText(/Mis à jour à 01:00/)).toBeVisible();
  });

  // Un rafraîchissement lancé avant un changement de semaine ne doit pas, arrivé le dernier,
  // remplacer les affectations de la semaine choisie.
  test('le planning public ignore une lecture dépassée par un changement de semaine', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-14T13:00:00Z') });
    const titre = 'Affectation semaine 43 E2E';
    const evenement = { id: 'e2e-semaine-43', categorie: 'HORS_CHANTIER', dateDebut: '2026-10-21T00:00:00.000Z', dateFin: '2026-10-21T00:00:00.000Z', creneau: 'JOURNEE', heureDebut: null, heureFin: null, chantier: null, titre, client: null, typeEvent: null, commentaire: null, intervenants: [] };
    let retenir = false;
    let libererRetenue = () => {};
    let signalerRetenue = () => {};
    const retenueDemandee = new Promise<void>((resolve) => { signalerRetenue = resolve; });
    await page.route('**/api/planning/public/**', async (route) => {
      const debut = new URL(route.request().url()).searchParams.get('start');
      if (!debut && retenir) {
        retenir = false;
        signalerRetenue();
        await new Promise<void>((resolve) => { libererRetenue = resolve; });
      }
      const semaine43 = debut === '2026-10-19';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ events: semaine43 ? [evenement] : [], intervenants: [], fuseauHoraire: 'Pacific/Wallis', aujourdhui: '2026-10-15', debut: semaine43 ? '2026-10-19' : '2026-10-12', fin: semaine43 ? '2026-10-25' : '2026-10-18' }),
      });
    });
    await page.goto('/planning/public/jeton-e2e-depassee', { waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: 'Semaine 42' })).toBeVisible();
    // Rafraîchissement de la semaine courante (retour sur l'onglet), retenu pendant que l'on
    // passe à la semaine suivante.
    retenir = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await retenueDemandee;
    await page.getByTitle('Semaine suivante').click();
    await expect(page.getByText(titre)).toBeVisible();
    const depassee = page.waitForResponse((r) => r.url().includes('/api/planning/public/') && !new URL(r.url()).searchParams.get('start'));
    libererRetenue();
    await (await depassee).finished();
    // Laisse à la page le temps d'appliquer cette réponse, si elle ne l'écartait pas.
    await page.waitForTimeout(500);
    await expect(page.getByText(titre)).toBeVisible();
  });
});

test.describe('navigateur à Gambier, société à Wallis', () => {
  test.use({ timezoneId: 'Pacific/Gambier' });

  // 01-01-2027 à 13:30 UTC : le 1er à Paris (fuseau par défaut de l'écran) et à Gambier, déjà
  // le 2 à Wallis. Le formulaire est ouvert pendant que la lecture du fuseau est retenue : ses
  // dates ne doivent pas être préremplies au jour de Paris, mais à celui de la société.
  test('une facture ouverte avant la lecture du fuseau est préremplie au jour de la société', async ({ page, request, session }) => {
    await page.clock.install({ time: new Date('2027-01-01T13:30:00Z') });
    await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
      let liberer = () => {};
      const retenue = new Promise<void>((resolve) => { liberer = resolve; });
      await page.route('**/api/company', async (route) => {
        if (route.request().method() === 'GET') await retenue;
        await route.continue();
      });
      await page.addInitScript(([token, user]) => {
        localStorage.setItem('token', token as string);
        localStorage.setItem('user', user as string);
      }, [session.token, JSON.stringify(session.user)]);
      await page.goto('/factures', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Nouvelle facture/ }).click();
      const emission = page.locator('input[name="dateEmission"]');
      await expect(emission).toBeDisabled();
      await expect(emission).toHaveValue('');
      liberer();
      await expect(emission).toBeEnabled();
      await expect(emission).toHaveValue('02-01-2027');
      await expect(page.locator('input[name="dateEcheance"]')).toHaveValue('02-01-2027');
    });
  });
});

// Fuseau de la société illisible : aucune date du jour n'est préremplie (ce serait le jour
// d'Europe/Paris, fuseau par défaut), elle reste à saisir : ouverture d'un chantier, heures,
// achats, contrats de maintenance et affectation du planning. Le formulaire d'ouverture n'affiche
// ses champs qu'avec un devis prêt : le test signe le sien, sans dépendre des autres parcours.
test('sans le fuseau de la société, les dates du jour ne sont pas préremplies', async ({ page, request, session, creerClient }) => {
  const devis = await signerDevisPret(request, session.token, creerClient, 'Fuseau illisible');
  await page.route('**/api/company', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ status: 500, json: { error: 'Paramètres indisponibles.' } })
    : route.continue()));
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [session.token, JSON.stringify(session.user)]);
  await page.goto('/admin', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Ouvrir le chantier d’une affaire' })).toBeVisible();
  await expect(page.locator(`#ouverture-devis option[value="${devis.id}"]`)).toHaveCount(1);
  await expect(page.getByLabel('Date de début')).toHaveValue('');
  await page.goto('/heures', { waitUntil: 'networkidle' });
  await expect(page.locator('input[name="date"]')).toHaveValue('');
  await page.goto('/achats', { waitUntil: 'networkidle' });
  await expect(page.locator('input[name="date"]')).toHaveValue('');
  await page.goto('/contrats-maintenance', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Nouveau contrat' }).click();
  await expect(page.locator('input[name="dateDebut"]')).toHaveValue('');
  await page.goto('/planning', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Affectation', exact: true }).click();
  await expect(page.locator('input[name="dateDebut"]')).toHaveValue('');
});

// Société au fuseau par défaut (Europe/Paris) : une fois ce fuseau lu, la date du jour se
// préremplit, même si le fuseau, inchangé, ne remonte pas le champ. Chaque page est ouverte
// pendant que la lecture du fuseau est retenue.
test('au fuseau par défaut, la date du jour se préremplit une fois le fuseau lu', async ({ page, request, session, creerClient }) => {
  await page.clock.install({ time: new Date('2026-10-14T10:00:00Z') });
  await signerDevisPret(request, session.token, creerClient, 'Fuseau par défaut');
  let ouvrirPorte = () => {};
  let porte = Promise.resolve();
  await page.route('**/api/company', async (route) => {
    if (route.request().method() === 'GET') await porte;
    await route.continue();
  });
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [session.token, JSON.stringify(session.user)]);
  await avecFuseauSociete(request, session.token, 'Europe/Paris', async () => {
    for (const { chemin, champ, bouton } of [
      { chemin: '/achats', champ: 'input[name="date"]' },
      { chemin: '/heures', champ: 'input[name="date"]' },
      { chemin: '/contrats-maintenance', champ: 'input[name="dateDebut"]', bouton: 'Nouveau contrat' },
      { chemin: '/admin', champ: '#ouverture-date' },
    ]) {
      porte = new Promise<void>((resolve) => { ouvrirPorte = resolve; });
      try {
        await page.goto(chemin, { waitUntil: 'domcontentloaded' });
        if (bouton) await page.getByRole('button', { name: bouton }).click();
        await expect(page.locator(champ), chemin).toHaveValue('');
      } finally {
        ouvrirPorte();
      }
      await expect(page.locator(champ), chemin).toHaveValue('14-10-2026');
    }
  });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// Société à Wallis : une date saisie avant la lecture du fuseau est gardée quand le fuseau arrive
// (le champ, déjà modifié, ne se recale pas sur le jour de la société).
test('une date saisie avant la lecture du fuseau est gardée', async ({ page, request, session }) => {
  await page.clock.install({ time: new Date('2026-10-14T13:00:00Z') });
  let ouvrirPorte = () => {};
  let porte = Promise.resolve();
  await page.route('**/api/company', async (route) => {
    if (route.request().method() === 'GET') await porte;
    await route.continue();
  });
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [session.token, JSON.stringify(session.user)]);
  await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
    for (const { chemin, champ, bouton } of [
      { chemin: '/achats', champ: 'input[name="date"]' },
      { chemin: '/heures', champ: 'input[name="date"]' },
      { chemin: '/contrats-maintenance', champ: 'input[name="dateDebut"]', bouton: 'Nouveau contrat' },
    ]) {
      porte = new Promise<void>((resolve) => { ouvrirPorte = resolve; });
      const lecture = page.waitForResponse((r) => r.url().endsWith('/api/company') && r.request().method() === 'GET');
      try {
        await page.goto(chemin, { waitUntil: 'domcontentloaded' });
        if (bouton) await page.getByRole('button', { name: bouton }).click();
        await page.locator(champ).fill('01-10-2026');
      } finally {
        ouvrirPorte();
      }
      await lecture;
      // Le fuseau lu (déjà le 15 à Wallis) ne remplace pas la date saisie. Délai laissé à la page
      // pour appliquer ce fuseau, si elle recalait le champ.
      await page.waitForTimeout(300);
      await expect(page.locator(champ), chemin).toHaveValue('01-10-2026');
    }
  });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// Instants affichés par la PR (signature d'un devis, historique des règles comptables, archivage du
// tableau de bord, début d'un chantier dans « Résultat commercial ») : au jour et à l'heure de la
// société, et non du navigateur ni d'UTC. Les réponses sont réécrites avec des instants fixes.
test.describe('navigateur à Gambier : instants affichés au fuseau de la société', () => {
  test.use({ timezoneId: 'Pacific/Gambier' });
  // 14-10-2026 à 13:30 UTC : le 15 à 01:30 à Wallis, le 14 à 04:30 à Gambier, à 15:30 à Paris.
  const instant = '2026-10-14T13:30:00.000Z';

  test('signature d’un devis, historique des règles et archivage du tableau de bord', async ({ page, request, session, creerClient }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const devis = await signerDevisPret(request, session.token, creerClient, 'Instants affichés');
    const signe = await (await request.get(`${api}/devis`, { headers })).json() as { id: string; objet: string }[];
    const objet = signe.find((d) => d.id === devis.id)?.objet as string;
    const conversion = await request.post(`${api}/devis/${devis.id}/convertir`, { headers, data: { cible: 'CHANTIER' } });
    expect(conversion.ok(), await conversion.text()).toBeTruthy();
    const { id: chantierId } = await conversion.json() as { id: string };
    await page.route('**/api/devis', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const reponse = await route.fetch();
      const liste = await reponse.json() as { id: string; signature?: { signeLe: string } | null }[];
      await route.fulfill({ response: reponse, json: liste.map((d) => (d.id === devis.id && d.signature ? { ...d, signature: { ...d.signature, signeLe: instant } } : d)) });
    });
    await page.route('**/api/comptabilite/regles/journal', (route) => route.fulfill({ json: [{
      id: 'e2e-instant', action: 'REMAPPAGE', type: 'REGLE', cible: 'E2E_INSTANT', avantCode: '706000', avantLibelle: 'Avant E2E',
      apresCode: '706100', apresLibelle: 'Après E2E', motif: 'Motif E2E', auteurNom: 'Auteur E2E', createdAt: instant,
    }] }));
    // Archivé sans date de fin : le tableau de bord lit sa dernière modification, un instant, au
    // jour de la société. À minuit UTC pile, Tahiti est encore le 14 à 14:00 (une lecture comme
    // date-seule donnerait le 15). Une copie du chantier, modifiée à 09:30 UTC, distingue aussi la
    // société du navigateur : Tahiti est encore le 14 à 23:30, Gambier et UTC déjà le 15.
    const nomMatin = `Archivé au matin E2E ${Date.now()}`;
    await page.route('**/api/chantiers', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const reponse = await route.fetch();
      const liste = await reponse.json() as { id: string; nom: string }[];
      const archive = { ...liste.find((c) => c.id === chantierId) as { id: string; nom: string }, statut: 'TERMINE', dateFin: null, updatedAt: '2026-10-15T00:00:00.000Z' };
      const matin = { ...archive, id: `${chantierId}-matin`, nom: nomMatin, updatedAt: '2026-10-15T09:30:00.000Z' };
      await route.fulfill({ response: reponse, json: [...liste.map((c) => (c.id === chantierId ? archive : c)), matin] });
    });
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [session.token, JSON.stringify(session.user)]);
    await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
      await page.goto('/devis', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('li', { hasText: objet })).toContainText('15/10/2026 01:30:00');
      await page.goto('/comptabilite', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Historique des règles' }).click();
      await expect(page.getByRole('region', { name: 'Historique des règles' })).toContainText('15/10/2026 01:30:00');
    });
    await avecFuseauSociete(request, session.token, 'Pacific/Tahiti', async () => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Chantiers terminés \/ archivés/ }).click();
      await expect(page.getByRole('button', { name: new RegExp(objet) })).toContainText('Archivé le 14-10-2026');
      await expect(page.getByRole('button', { name: new RegExp(nomMatin) })).toContainText('Archivé le 14-10-2026');
    });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('début d’un chantier horodaté dans « Résultat commercial »', async ({ page, request, session }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const creation = await request.post(`${api}/users`, { headers, data: { email: `dates.instant.commercial.${suffixe}@iris.test`, name: `Commercial instant ${suffixe}`, role: 'COMMERCIAL' } });
    expect(creation.ok(), await creation.text()).toBeTruthy();
    const commercial = await creation.json() as { id: string; name: string; email: string };
    const chantierHorodate = { id: 'e2e-horodate', nom: 'Chantier horodaté E2E', client: 'Client E2E', dateDebut: instant, statut: 'EN_COURS', budgetGlobalVendu: 1000, margeCommerciale: 100, commissionEstimee: 0, comptabiliseDansPeriode: false, encaisse: false };
    await page.route('**/api/stats/commerciaux?*', async (route) => {
      const reponse = await route.fetch();
      const donnees = await reponse.json() as { commerciaux?: Record<string, unknown>[] };
      const moi = { caTotal: 0, margeTotal: 0, margeStandard: 0, margeReduite: 0, commissionStandard: 0, commissionReduite: 0, commissionTotal: 0, suiviAdministratif: false, ...(donnees.commerciaux?.[0] ?? {}), chantiers: [chantierHorodate] };
      await route.fulfill({ response: reponse, json: { ...donnees, commerciaux: [moi] } });
    });
    await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
      await ouvrirSansAttendre(page, '/resultat-commercial', jetonPour(commercial.id), { ...commercial, role: 'COMMERCIAL', permissions: [] });
      await expect(page.locator('tr', { hasText: 'Chantier horodaté E2E' })).toContainText('15-10-2026');
    });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
