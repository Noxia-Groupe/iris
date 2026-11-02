import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, choisirClient } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

type Affaire = { id: string; nom: string; numeroDevis: string | null; clientId: string };
type Contrat = { id: string; titre: string; statut: string; dateDebut: string; prochaineEcheance: string; clientId: string; site: { id: string; nom: string; ville: string } | null };
type Visite = { id: string; reference: string; titre: string; statut: string; contratMaintenanceId: string | null };
type Facture = { id: string; clientId: string; statut: string; numero: string | null; origine: string; chantierId: string | null; interventionId: string | null; contratMaintenanceId: string | null };

// Correctif #448 (note N1 de l'audit de #445, qualifiée par le contrôle de cohérence) : le sélecteur de
// rattachement de l'écran Factures désignait une affaire par son seul nom et un contrat par son seul titre.
// Deux affaires d'un même client ouvertes par deux devis de même objet (le nom de l'affaire est l'objet du
// devis), ou deux contrats de même titre (un par site, ou un contrat clôturé et son successeur), y étaient
// indiscernables, alors que le rattachement est figé à l'émission et qu'un brouillon ne se modifie ni ne se
// supprime (#352) : règle 2 de la méthode, factures et documents figés. Désignation retenue, micro-arbitrage
// d'affichage (règle 5, choix par défaut, à confirmer) :
// - une affaire : « <nom> — <numéro de devis> », comme dans « Origine de la facture » du même écran ;
// - un contrat : « <titre> — <site> — début le <JJ-MM-AAAA> », le site omis en son absence, comme dans la
//   liste des contrats ;
// - une intervention : inchangée, « <référence> — <titre> » (#445).
// Aucun montant n'est en jeu : la ligne saisie n'est que celle qu'exige un brouillon.
//
// Rien ne dépend du jour, de l'heure ni du fuseau du passage :
// - les dates de début sont fixes et antérieures à l'écriture de ce test (02-11-2026) : un libellé qui
//   prendrait la date du jour ne peut jamais les rendre ;
// - leur jour et leur mois diffèrent : un libellé au format MM-JJ-AAAA s'en distingue ;
// - le navigateur est à Gambier (UTC−9) : une date de début, stockée à minuit UTC (relu par l'API), rendue
//   au fuseau du navigateur afficherait la veille ;
// - l'échéance d'un contrat est avancée d'un an : un libellé qui prendrait la prochaine échéance au lieu de
//   la date de début s'en distingue.
test.describe('navigateur à Gambier : affaires et contrats homonymes d’un même client au rattachement d’une facture', () => {
  test.use({ timezoneId: 'Pacific/Gambier' });

  const preparer = (request: APIRequestContext, token: string) => {
    const headers = { Authorization: `Bearer ${token}` };
    return async (methode: 'get' | 'post' | 'patch', path: string, data?: object) => {
      const response = await request[methode](`${api}${path}`, { headers, data });
      expect(response.ok(), `${methode.toUpperCase()} ${path} : ${response.status()} ${await response.text()}`).toBeTruthy();
      return response.json();
    };
  };

  // Ouvre un nouveau brouillon pour le client, comme l'utilisateur : bouton, puis recherche du client.
  const ouvrirBrouillon = async (page: Page, client: { id: string; raisonSociale: string }) => {
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    return page.locator('select[name="origine"]');
  };

  // Ligne qu'exige un brouillon, puis création ; rend la requête et la réponse de POST /api/factures.
  const creerLeBrouillon = async (page: Page) => {
    await page.getByRole('textbox', { name: 'Désignation ligne 1' }).fill('Prestation');
    await page.getByRole('textbox', { name: 'Prix unitaire HT ligne 1' }).fill('100');
    const creation = page.waitForResponse((response) => response.url().endsWith('/api/factures') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Créer le brouillon', exact: true }).click();
    const reponse = await creation;
    expect(reponse.status(), await reponse.text()).toBe(201);
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    return reponse;
  };

  test('facture d’affaire : deux affaires homonymes se distinguent par « nom — numéro de devis », et le brouillon se rattache à la seconde, et à elle seule', async ({ request, session, creerClient, allerSurPageAdmin }) => {
    const envoyer = preparer(request, session.token);
    const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const client = await creerClient(`homonymes-affaires ${suffixe}`);

    // Deux devis de même objet, signés puis convertis : deux affaires de même nom, ouvertes par la seule voie
    // de création d'un chantier.
    const objet = `Entretien annuel ${suffixe}`;
    const affaires: Affaire[] = [];
    const numerosDevis: string[] = [];
    for (let rang = 0; rang < 2; rang++) {
      const devis = await envoyer('post', '/devis', { clientId: client.id, objet, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string; numero: string };
      await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
      const affaire = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as Affaire;
      expect(affaire.nom, 'le nom de l’affaire est l’objet de son devis').toBe(objet);
      expect(affaire.numeroDevis, 'l’affaire porte le numéro du devis qui l’a ouverte').toBe(devis.numero);
      affaires.push(affaire);
      numerosDevis.push(devis.numero);
    }
    expect(numerosDevis[1], 'deux devis, deux numéros').not.toBe(numerosDevis[0]);

    // Préalable du constat, relu par l'API : le client n'a que ces deux affaires, de même nom.
    const affairesDuClient = (await envoyer('get', '/chantiers') as Affaire[]).filter((affaire) => affaire.clientId === client.id);
    expect(affairesDuClient.map((affaire) => affaire.id).sort()).toEqual(affaires.map((affaire) => affaire.id).sort());
    for (const affaire of affairesDuClient) expect(affaire).toMatchObject({ nom: objet, numeroDevis: numerosDevis[affaires.findIndex((a) => a.id === affaire.id)] });

    const page = await allerSurPageAdmin('/factures');
    const origine = await ouvrirBrouillon(page, client);
    await origine.selectOption('CHANTIER');
    const choix = page.locator('select[name="chantierId"]');
    const options = choix.locator('option:not([value=""])');
    await expect(options, 'le client n’a que ses deux affaires à facturer').toHaveCount(2);
    // Texte exact : il écarte le nom seul (ancien libellé), le numéro seul, l'ordre inversé
    // « numéro — nom » (celui de l'écran Interventions) et tout autre séparateur.
    for (const [rang, affaire] of affaires.entries()) {
      await expect(choix.locator(`option[value="${affaire.id}"]`), `l’affaire ${numerosDevis[rang]} se désigne par son nom, puis son numéro de devis`)
        .toHaveText(`${objet} — ${numerosDevis[rang]}`);
    }
    const libelles = await options.allTextContents();
    expect(new Set(libelles).size, `deux affaires homonymes portent deux libellés distincts : ${JSON.stringify(libelles)}`).toBe(2);

    // La seconde option de la liste, choisie par son libellé, comme le ferait l'utilisateur.
    const ordre = await options.evaluateAll((elements) => elements.map((element) => (element as HTMLOptionElement).value));
    const seconde = affaires.find((affaire) => affaire.id === ordre[1])!;
    const autre = affaires.find((affaire) => affaire.id === ordre[0])!;
    await choix.selectOption({ label: `${objet} — ${seconde.numeroDevis}` });
    await expect(choix).toHaveValue(seconde.id);
    const reponse = await creerLeBrouillon(page);
    const corps = reponse.request().postDataJSON() as Record<string, unknown>;
    expect(corps).toMatchObject({ clientId: client.id, origine: 'CHANTIER', chantierId: seconde.id });
    expect(corps).not.toHaveProperty('interventionId');
    expect(corps).not.toHaveProperty('contratMaintenanceId');
    const cree = await reponse.json() as { id: string };

    // Relu par l'API : un seul brouillon pour ce client, rattaché à l'affaire choisie, et à elle seule.
    const facturesDuClient = (await envoyer('get', '/factures') as Facture[]).filter((facture) => facture.clientId === client.id);
    expect(facturesDuClient).toHaveLength(1);
    expect(facturesDuClient[0]).toMatchObject({ id: cree.id, statut: 'BROUILLON', numero: null, origine: 'CHANTIER', chantierId: seconde.id, interventionId: null, contratMaintenanceId: null });
    expect(facturesDuClient[0].chantierId).not.toBe(autre.id);
    const trace = await envoyer('get', `/factures/${cree.id}/tracabilite`) as { facture: { chantier: { id: string; nom: string; numeroDevis: string | null } | null } };
    expect(trace.facture.chantier).toMatchObject({ id: seconde.id, nom: objet, numeroDevis: seconde.numeroDevis });
  });

  test('facture de contrat : des contrats homonymes se distinguent par leur site et leur date de début, sans site le segment est omis, les visites gardent leur référence, et le brouillon se rattache au contrat choisi, et à lui seul', async ({ request, session, creerClient, allerSurPageAdmin }) => {
    const envoyer = preparer(request, session.token);
    const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    // Le client de parcours a déjà un site de facturation (« Facturation ») ; deux sites d'intervention s'y
    // ajoutent, de villes différentes de leur nom : le libellé porte le nom du site, et non sa ville.
    const client = await creerClient(`homonymes-contrats ${suffixe}`);
    const siteA = await envoyer('post', `/clients/${client.id}/sites`, { nom: `Bâtiment A ${suffixe}`, adresse: '1 rue A', codePostal: '14000', ville: 'Caen' }) as { id: string; nom: string };
    const siteB = await envoyer('post', `/clients/${client.id}/sites`, { nom: `Bâtiment B ${suffixe}`, adresse: '1 rue B', codePostal: '14100', ville: 'Lisieux' }) as { id: string; nom: string };

    // Quatre contrats de même titre :
    // - A15 et B15 : même début, deux sites (un contrat par site) ;
    // - A07 : même site que A15, début antérieur, clôturé (un contrat clôturé et son successeur) ;
    // - sans site : aucun site précisé.
    const titre = `Contrat SSI ${suffixe}`;
    const contrat = (siteId: string | null, dateDebut: string) => envoyer('post', '/contrats-maintenance', { clientId: client.id, ...(siteId ? { siteId } : {}), titre, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut }) as Promise<Contrat>;
    const a15 = await contrat(siteA.id, '15-03-2026');
    const b15 = await contrat(siteB.id, '15-03-2026');
    const a07 = await contrat(siteA.id, '07-09-2025');
    const sansSite = await contrat(null, '28-02-2026');
    await envoyer('patch', `/contrats-maintenance/${a07.id}/statut`, { statut: 'TERMINE', motif: 'Remplacé par le contrat du 15-03-2026' });

    // Échéance de A15 avancée d'un an : sa première visite terminée avec un compte rendu, puis la seconde
    // générée. Sa prochaine échéance (15-03-2027) diffère alors de sa date de début (15-03-2026).
    const premiere = await envoyer('post', `/contrats-maintenance/${a15.id}/generer-intervention`) as Visite;
    for (const statut of ['PLANIFIEE', 'EN_COURS']) await envoyer('patch', `/interventions/${premiere.id}/statut`, { statut });
    await envoyer('post', `/interventions/${premiere.id}/rapports`, { contenu: 'Visite réalisée.', cleEnvoi: randomUUID() });
    await envoyer('patch', `/interventions/${premiere.id}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
    await envoyer('post', `/contrats-maintenance/${a15.id}/avancer-echeance`);
    const seconde = await envoyer('post', `/contrats-maintenance/${a15.id}/generer-intervention`) as Visite;

    // Préalable, relu par l'API : quatre contrats de même titre ; dates de début stockées à minuit UTC
    // (la veille à Gambier) ; prochaine échéance de A15 distincte de son début ; A07 clôturé, et non annulé.
    const contratsDuClient = (await envoyer('get', '/contrats-maintenance') as Contrat[]).filter((c) => c.clientId === client.id);
    expect(contratsDuClient.map((c) => c.id).sort()).toEqual([a15.id, b15.id, a07.id, sansSite.id].sort());
    const relu = (id: string) => contratsDuClient.find((c) => c.id === id)!;
    expect(relu(a15.id)).toMatchObject({ titre, statut: 'ACTIF', dateDebut: '2026-03-15T00:00:00.000Z', prochaineEcheance: '2027-03-15T00:00:00.000Z', site: { id: siteA.id, nom: siteA.nom, ville: 'Caen' } });
    expect(relu(b15.id)).toMatchObject({ titre, statut: 'ACTIF', dateDebut: '2026-03-15T00:00:00.000Z', site: { id: siteB.id, nom: siteB.nom, ville: 'Lisieux' } });
    expect(relu(a07.id)).toMatchObject({ titre, statut: 'TERMINE', dateDebut: '2025-09-07T00:00:00.000Z', site: { id: siteA.id, nom: siteA.nom } });
    expect(relu(sansSite.id)).toMatchObject({ titre, statut: 'ACTIF', dateDebut: '2026-02-28T00:00:00.000Z', site: null });
    const visites = (await envoyer('get', '/interventions') as Visite[]).filter((intervention) => intervention.contratMaintenanceId === a15.id);
    expect(visites.map((visite) => visite.id).sort()).toEqual([premiere.id, seconde.id].sort());
    for (const visite of [premiere, seconde]) expect(visite).toMatchObject({ titre: `Maintenance préventive — ${titre}` });
    expect(seconde.reference).not.toBe(premiere.reference);

    const page = await allerSurPageAdmin('/factures');
    const origine = await ouvrirBrouillon(page, client);

    // Contrats : texte exact de chacun. Pour A15, il écarte :
    // - le titre seul (ancien libellé) ;
    // - le site retiré : « … — début le 15-03-2026 », commun à A15 et B15 ;
    // - la date retirée : « … — Bâtiment A … », commun à A15 et A07 ;
    // - l'ordre inversé (date avant site, site avant titre) ;
    // - la ville au lieu du nom du site (« Caen ») ;
    // - la prochaine échéance au lieu de la date de début (« 15-03-2027 ») ;
    // - le rendu au fuseau du navigateur (« 14-03-2026 » à Gambier), le format MM-JJ-AAAA (« 03-15-2026 »)
    //   ou ISO (« 2026-03-15 »), et la date du jour.
    // Pour le contrat sans site, il écarte un segment vide ou « undefined » à la place du site.
    await origine.selectOption('CONTRAT');
    const choixContrat = page.locator('select[name="contratMaintenanceId"]');
    const optionsContrat = choixContrat.locator('option:not([value=""])');
    await expect(optionsContrat, 'le client n’a que ses quatre contrats, le clôturé compris').toHaveCount(4);
    const attendus = new Map([
      [a15.id, `${titre} — ${siteA.nom} — début le 15-03-2026`],
      [b15.id, `${titre} — ${siteB.nom} — début le 15-03-2026`],
      [a07.id, `${titre} — ${siteA.nom} — début le 07-09-2025`],
      [sansSite.id, `${titre} — début le 28-02-2026`],
    ]);
    for (const [id, libelle] of attendus) {
      await expect(choixContrat.locator(`option[value="${id}"]`), `le contrat se désigne par « ${libelle} »`).toHaveText(libelle);
    }
    const libellesContrats = await optionsContrat.allTextContents();
    expect(new Set(libellesContrats).size, `quatre contrats homonymes portent quatre libellés distincts : ${JSON.stringify(libellesContrats)}`).toBe(4);

    // Interventions : inchangées, « <référence> — <titre> » (#445), sans site ni date ajoutés.
    await origine.selectOption('INTERVENTION');
    const choixVisite = page.getByRole('combobox', { name: 'Intervention facturée' });
    await expect(choixVisite.locator('option:not([value=""])'), 'le client n’a que les deux visites de A15 à facturer').toHaveCount(2);
    for (const visite of [premiere, seconde]) {
      await expect(choixVisite.locator(`option[value="${visite.id}"]`), `la visite ${visite.reference} se désigne par sa référence, puis son titre`)
        .toHaveText(`${visite.reference} — Maintenance préventive — ${titre}`);
    }

    // Retour aux contrats : des deux contrats de même titre et de même début, sur deux sites, celui qui vient
    // en second dans la liste, choisi par son libellé, comme le ferait l'utilisateur.
    await origine.selectOption('CONTRAT');
    await expect(choixContrat).toHaveValue('');
    const ordre = await optionsContrat.evaluateAll((elements) => elements.map((element) => (element as HTMLOptionElement).value));
    const paire = [a15, b15].sort((x, y) => ordre.indexOf(x.id) - ordre.indexOf(y.id));
    const [autre, choisi] = paire;
    expect(ordre.indexOf(choisi.id), `le contrat choisi n’est pas la première option : ${JSON.stringify(ordre)}`).toBeGreaterThan(0);
    await choixContrat.selectOption({ label: attendus.get(choisi.id)! });
    await expect(choixContrat).toHaveValue(choisi.id);
    const reponse = await creerLeBrouillon(page);
    const corps = reponse.request().postDataJSON() as Record<string, unknown>;
    expect(corps).toMatchObject({ clientId: client.id, origine: 'CONTRAT', contratMaintenanceId: choisi.id });
    expect(corps).not.toHaveProperty('chantierId');
    expect(corps).not.toHaveProperty('interventionId');
    const cree = await reponse.json() as { id: string };

    // Relu par l'API : un seul brouillon pour ce client, rattaché au contrat choisi, et à lui seul.
    const facturesDuClient = (await envoyer('get', '/factures') as Facture[]).filter((facture) => facture.clientId === client.id);
    expect(facturesDuClient).toHaveLength(1);
    expect(facturesDuClient[0]).toMatchObject({ id: cree.id, statut: 'BROUILLON', numero: null, origine: 'CONTRAT', contratMaintenanceId: choisi.id, chantierId: null, interventionId: null });
    expect(facturesDuClient[0].contratMaintenanceId).not.toBe(autre.id);
    const trace = await envoyer('get', `/factures/${cree.id}/tracabilite`) as { facture: { contratMaintenance: { id: string; titre: string; siteId: string | null } | null } };
    expect(trace.facture.contratMaintenance).toMatchObject({ id: choisi.id, titre, siteId: relu(choisi.id).site!.id });
  });
});
