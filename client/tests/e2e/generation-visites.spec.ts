import { createHmac, randomUUID } from 'node:crypto';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Jour civil de Paris décalé de quelques jours, au format JJ-MM-AAAA.
function dansJours(jours: number) {
  const [jour, mois, annee] = dateDuJour().split('-').map(Number);
  const date = new Date(Date.UTC(annee, mois - 1, jour + jours));
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
}

// Même jour civil un an plus tard (le 29-02 devient le 28-02), comme l'échéance suivante d'un
// contrat annuel.
function dansUnAn(jjmmaaaa: string) {
  const [jour, mois, annee] = jjmmaaaa.split('-').map(Number);
  const dernier = new Date(Date.UTC(annee + 1, mois, 0)).getUTCDate();
  return `${String(Math.min(jour, dernier)).padStart(2, '0')}-${String(mois).padStart(2, '0')}-${annee + 1}`;
}

// Lot pilote 5 (décision A9) : l'administration règle l'anticipation de la génération des
// visites, lance un passage depuis l'écran des contrats, et retrouve la visite créée dans la
// file des interventions. Le serveur des tests ne lance aucun passage quotidien
// (GENERATION_VISITES_AUTOMATIQUE=0), ce que l'écran indique.
test('l’administration règle l’anticipation, lance la génération et retrouve la visite à planifier', async ({ allerSurPageAdmin, creerClient, request, session, page: pageAdmin }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const fenetres: string[] = [];
  pageAdmin.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
  const suffixe = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const client = await creerClient('generation-visites', false);
  const titre = `Contrat généré ${suffixe}`;
  const creation = await request.post(`${api}/contrats-maintenance`, { headers, data: { clientId: client.id, titre, periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: dansJours(5) } });
  expect(creation.status(), await creation.text()).toBe(201);
  const contrat = await creation.json() as { id: string };
  // Second contrat, échu aujourd'hui, dont la visite est déjà terminée : le passage avance son
  // échéance d'un an, et la liste des contrats doit le montrer.
  const titreTermine = `Contrat visite terminée ${suffixe}`;
  const creationTermine = await request.post(`${api}/contrats-maintenance`, { headers, data: { clientId: client.id, titre: titreTermine, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: dateDuJour() } });
  expect(creationTermine.status(), await creationTermine.text()).toBe(201);
  const contratTermine = await creationTermine.json() as { id: string };
  const visite = await request.post(`${api}/contrats-maintenance/${contratTermine.id}/generer-intervention`, { headers });
  expect(visite.status(), await visite.text()).toBe(201);
  const visiteId = (await visite.json() as { id: string }).id;
  for (const statut of ['PLANIFIEE', 'EN_COURS']) {
    const transition = await request.patch(`${api}/interventions/${visiteId}/statut`, { headers, data: { statut } });
    expect(transition.ok(), await transition.text()).toBeTruthy();
  }
  const compteRendu = await request.post(`${api}/interventions/${visiteId}/rapports`, { headers, data: { contenu: 'Visite réalisée.', cleEnvoi: randomUUID() } });
  expect(compteRendu.status(), await compteRendu.text()).toBe(201);
  const fin = await request.patch(`${api}/interventions/${visiteId}/statut`, { headers, data: { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' } });
  expect(fin.ok(), await fin.text()).toBeTruthy();
  const visitesDuContrat = async () => {
    const reponse = await request.get(`${api}/interventions`, { headers });
    expect(reponse.ok(), await reponse.text()).toBeTruthy();
    return (await reponse.json() as { contratMaintenanceId: string | null; titre: string; statut: string }[]).filter((i) => i.contratMaintenanceId === contrat.id);
  };

  try {
    const page = await allerSurPageAdmin('/contrats-maintenance');
    const panneau = page.getByRole('region', { name: 'Génération automatique des visites' });
    await expect(panneau.getByText('La génération automatique est arrêtée sur ce serveur')).toBeVisible();
    const anticipation = panneau.getByLabel('Anticipation (jours avant l’échéance)');
    const lancer = async () => {
      const reponse = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/contrats-maintenance/generation-visites'));
      await panneau.getByRole('button', { name: 'Lancer la génération maintenant' }).click();
      expect((await reponse).status()).toBe(201);
      await expect(panneau.getByText(/^Génération terminée : \d+ visites? créées?, \d+ échéances? avancées?\.$/)).toBeVisible();
    };

    // Échéance à 5 jours, anticipation de 2 jours : pas encore de visite.
    await anticipation.fill('2');
    await panneau.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(panneau.getByText('Anticipation enregistrée : 2 jours.')).toBeVisible();
    const carteTermine = page.locator('article').filter({ has: page.getByRole('heading', { name: titreTermine }) });
    await expect(carteTermine).toContainText(`Échéance : ${dateDuJour()}`);
    await lancer();
    expect(await visitesDuContrat()).toEqual([]);
    await expect(carteTermine).toContainText(`Échéance : ${dansUnAn(dateDuJour())}`);
    await expect(panneau.getByText(`lancé par ${session.user.name}`, { exact: false })).toBeVisible();

    // Anticipation de 10 jours : la visite est créée, à planifier, et la liste des contrats suit.
    await anticipation.fill('10');
    await panneau.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(panneau.getByText('Anticipation enregistrée : 10 jours.')).toBeVisible();
    await lancer();
    expect(await visitesDuContrat()).toEqual([expect.objectContaining({ titre: `Maintenance préventive — ${titre}`, statut: 'A_PLANIFIER' })]);
    await expect(panneau.getByRole('alert')).toHaveCount(0);

    // Vide : génération désactivée, le passage manuel n'est plus proposé.
    await anticipation.fill('');
    await panneau.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(panneau.getByText('Génération automatique désactivée.', { exact: true })).toBeVisible();
    await expect(panneau.getByRole('button', { name: 'Lancer la génération maintenant' })).toBeDisabled();

    await page.goto('/interventions', { waitUntil: 'networkidle' });
    await expect(page.getByText(`Maintenance préventive — ${titre}`)).toBeVisible();
  } finally {
    const retour = await request.put(`${api}/parametres`, { headers, data: { anticipationVisitesJours: 30 } });
    expect(retour.ok(), await retour.text()).toBeTruthy();
  }
  expect(fenetres).toEqual([]);
});

// L'alerte (dernier passage en échec, interrompu, ou absent depuis avant-hier) est calculée par le
// serveur, qui la teste ; ici, l'écran la montre à l'administration, en tête des contrats et des
// interventions, avec un lien vers les contrats.
test('l’alerte de la génération s’affiche à l’administration sur les interventions et les contrats', async ({ allerSurPageAdmin, page }) => {
  const texte = 'La génération des visites du 14-10-2026 est en échec (1 erreur) : des visites peuvent manquer. Relancez-la une fois la cause corrigée.';
  await page.route('**/api/contrats-maintenance/generation-visites', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const reponse = await route.fetch();
    await route.fulfill({ response: reponse, json: { ...(await reponse.json()), alerte: texte } });
  });
  await allerSurPageAdmin('/interventions');
  const alerte = page.getByRole('alert').filter({ hasText: texte });
  await expect(alerte).toBeVisible();
  await alerte.getByRole('link', { name: 'Contrats de maintenance' }).click();
  await expect(page).toHaveURL(/\/contrats-maintenance$/);
  await expect(page.getByRole('region', { name: 'Génération automatique des visites' }).getByRole('alert')).toHaveText(texte);
});

test('un conducteur de travaux ne lit pas l’état de la génération des visites', async ({ request, session, browser }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const suffixe = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const creation = await request.post(`${api}/users`, { headers, data: { email: `generation.conducteur.${suffixe}@iris.test`, name: `Conducteur génération ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' } });
  expect(creation.status(), await creation.text()).toBe(201);
  const conducteur = await creation.json() as { id: string; name: string; email: string };
  const refus = await request.get(`${api}/contrats-maintenance/generation-visites`, { headers: { Authorization: `Bearer ${jetonPour(conducteur.id)}` } });
  expect(refus.status()).toBe(403);
  const contexte = await browser.newContext();
  try {
    const vue = await contexte.newPage();
    const lectures: string[] = [];
    vue.on('request', (requete) => { if (requete.url().includes('/generation-visites')) lectures.push(requete.url()); });
    await vue.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(conducteur.id), JSON.stringify({ ...conducteur, role: 'CONDUCTEUR_TRAVAUX', permissions: [] })]);
    await vue.goto('/interventions', { waitUntil: 'networkidle' });
    await expect(vue.getByRole('heading', { name: 'Interventions SAV' })).toBeVisible();
    expect(lectures).toEqual([]);
  } finally {
    await contexte.close();
  }
});

// Ajout proposé par l'audit interne de #293 : le panneau montre le dernier passage avec ses dates
// au format JJ-MM-AAAA, ses contrats laissés de côté et ses erreurs, sans rien couper à 320 px,
// même avec un numéro de série insécable dans le titre d'un contrat.
test('le panneau détaille le dernier passage, dates JJ-MM-AAAA, sans déborder à 320 px', async ({ allerSurPageAdmin, page }) => {
  const serie = 'SNA7B3C9D2E8F4G5H6J7K8L9M0P1Q2R3S4T5U6V7W8';
  const execution = {
    id: 'e2e', jour: '2026-10-14T00:00:00.000Z', declenchement: 'MANUEL', cleJourAutomatique: null, auteurId: 'x', auteurNom: 'Administratrice E2E',
    anticipationJours: 30, debut: '2026-10-14T05:07:09.000Z', fin: '2026-10-14T05:08:00.000Z', statut: 'ECHEC', visitesCreees: 3, echeancesAvancees: 1,
    contratsIgnores: [{ contratId: 'a', titre: `Contrat ${serie}`, motif: 'Client désactivé : aucune visite n’est créée ni aucune échéance avancée.' }],
    erreurs: [{ contratId: 'b', titre: 'Contrat en échec', message: 'Contrat non traité : erreur technique, détaillée dans le journal du serveur.' }],
  };
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route('**/api/contrats-maintenance/generation-visites', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const reponse = await route.fetch();
    await route.fulfill({ response: reponse, json: { ...(await reponse.json()), anticipationVisitesJours: 30, derniereExecution: execution } });
  });
  await allerSurPageAdmin('/contrats-maintenance');
  const panneau = page.getByRole('region', { name: 'Génération automatique des visites' });
  await expect(panneau).toContainText('Dernier passage : 14-10-2026 07:07:09 (lancé par Administratrice E2E, échéances jusqu’à 30 jours après le 14-10-2026) : 3 visites créées, 1 échéance avancée, en échec.');
  await expect(panneau.getByRole('listitem').filter({ hasText: serie })).toContainText('Client désactivé');
  await expect(panneau.getByRole('listitem').filter({ hasText: 'Contrat en échec' })).toContainText('Contrat non traité');
  expect(await page.evaluate(() => { const p = document.querySelector('main')!; return p.scrollWidth - p.clientWidth; })).toBeLessThanOrEqual(0);
});
