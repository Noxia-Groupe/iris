import { createHmac } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { test, expect, choisirClient, dateDuJour } from './fixtures';

// Aucune route de connexion par mot de passe n'existe (SSO Microsoft ou accès de secours) :
// pour ouvrir une session dans un rôle non administrateur, on signe le jeton avec le
// secret que playwright.config.ts donne au backend jetable.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test.describe('Facturation — parcours utilisateur', () => {
  test('#111 : recherche un client hors des 200 premiers, ignore une réponse périmée et exclut un inactif', async ({ allerSurPageAdmin, request, session }) => {
    const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
    const headers = { Authorization: `Bearer ${session.token}` };
    const prefix = `E2E 111 ${Date.now()}`;
    for (let index = 0; index < 201; index += 20) {
      const creations = await Promise.all(Array.from({ length: Math.min(20, 201 - index) }, (_, offset) =>
        request.post(`${api}/clients`, { headers, data: { raisonSociale: `${prefix} A ${String(index + offset).padStart(3, '0')}` } })));
      for (const creation of creations) expect(creation.status(), await creation.text()).toBe(201);
    }
    const cibleNom = `${prefix} Z cible`;
    const inactiveNom = `${prefix} Z inactive`;
    const cible = await request.post(`${api}/clients`, { headers, data: { raisonSociale: cibleNom } });
    expect(cible.status(), await cible.text()).toBe(201);
    const cibleId = (await cible.json()).id;
    const inactive = await request.post(`${api}/clients`, { headers, data: { raisonSociale: inactiveNom } });
    expect(inactive.status(), await inactive.text()).toBe(201);
    const inactiveId = (await inactive.json()).id;
    expect((await request.delete(`${api}/clients/${inactiveId}`, { headers })).status()).toBe(200);
    const liste = await request.get(`${api}/clients`, { headers });
    expect((await liste.json()).clients.some((client: { id: string }) => client.id === cibleId)).toBe(false);

    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    const recherche = page.getByRole('searchbox', { name: 'Rechercher un client' });
    const select = page.locator('select[name="clientId"]');
    await expect(select.locator(`option[value="${cibleId}"]`)).toHaveCount(0);
    await recherche.fill(prefix);
    await expect(select.locator('option')).toHaveCount(201); // 200 résultats + l'option vide
    await expect(page.getByRole('status', { name: 'Limite des résultats clients' })).toContainText('200');
    await expect(page.getByRole('status', { name: 'Limite des résultats clients' })).toContainText(/affiner.*recherche/i);
    await expect(select.locator(`option[value="${cibleId}"]`)).toHaveCount(0);
    let liberer!: () => void;
    const attente = new Promise<void>(resolve => { liberer = resolve; });
    await page.route('**/api/clients?q=*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === `${prefix} A`) await attente;
      await route.continue();
    });
    const premiereRecherche = page.waitForRequest(req => new URL(req.url()).searchParams.get('q') === `${prefix} A`);
    await recherche.fill(`${prefix} A`);
    await premiereRecherche;
    await recherche.fill(`${prefix} Z`);
    // V5 : une liste périmée ne doit pas rester sélectionnable pendant la recherche.
    await expect(page.getByText('Recherche en cours…')).toBeVisible();
    expect(await select.isDisabled(), 'le sélecteur doit être bloqué tant que la recherche est en cours').toBe(true);
    await expect(select.locator(`option[value="${cibleId}"]`)).toHaveCount(1);
    await expect(page.getByRole('status', { name: 'Limite des résultats clients' })).toHaveCount(0);
    await expect(select.locator(`option[value="${inactiveId}"]`)).toHaveCount(0);
    await select.selectOption(cibleId);
    const ancienne = page.waitForResponse(response => new URL(response.url()).searchParams.get('q') === `${prefix} A`);
    liberer();
    await (await ancienne).finished();
    // response.finished() précède parfois response.json() et le commit React.
    // Observer la sélection pendant toute la fenêtre post-réponse, pas seulement deux frames.
    await page.evaluate(async (id) => {
      const select = document.querySelector<HTMLSelectElement>('select[name="clientId"]');
      if (!select) throw new Error('Sélection client absente');
      const fin = performance.now() + 1000;
      while (performance.now() < fin) {
        if (select.value !== id || !select.querySelector(`option[value="${id}"]`)) throw new Error('Réponse périmée appliquée');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }, cibleId);
    await expect(select).toHaveValue(cibleId);
    await expect(select.locator(`option[value="${cibleId}"]`)).toHaveCount(1);
    await page.unroute('**/api/clients?q=*');

    // V6 : l'échec d'une ancienne recherche arrive après la réussite de la nouvelle.
    let libererEchec!: () => void;
    let signalerEchec!: () => void;
    const attenteEchec = new Promise<void>(resolve => { libererEchec = resolve; });
    const requeteEchec = new Promise<void>(resolve => { signalerEchec = resolve; });
    await page.route('**/api/clients?q=*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === `${prefix} A`) {
        signalerEchec();
        await attenteEchec;
        await route.fulfill({ status: 503, json: { error: 'Erreur périmée recherche #111' } });
      } else await route.continue();
    });
    const echecLivree = page.waitForResponse(response => new URL(response.url()).searchParams.get('q') === `${prefix} A` && response.status() === 503);
    await recherche.fill(`${prefix} A`);
    await requeteEchec;
    await recherche.fill(`${prefix} Z`);
    try {
      await expect(select.locator(`option[value="${cibleId}"]`)).toHaveCount(1);
      await select.selectOption(cibleId);
    } finally {
      libererEchec();
    }
    await (await echecLivree).finished();
    await page.evaluate(async (id) => {
      const select = document.querySelector<HTMLSelectElement>('select[name="clientId"]');
      if (!select) throw new Error('Sélection client absente');
      const fin = performance.now() + 400;
      while (performance.now() < fin) {
        if (document.body.textContent?.includes('Erreur périmée recherche #111') || select.value !== id)
          throw new Error('Échec périmé appliqué après la recherche réussie');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }, cibleId);
    await expect(page.getByRole('alert', { name: 'Erreur périmée recherche #111' })).toHaveCount(0);
    await page.unroute('**/api/clients?q=*');
    await page.locator('input[name="motifHorsAffaire"]').fill('Sélection au-delà de 200');
    await page.getByRole('textbox', { name: 'Désignation ligne 1' }).fill('Prestation test');
    await page.getByRole('textbox', { name: 'Prix unitaire HT ligne 1' }).fill('10');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    const factures = await request.get(`${api}/factures?page=1&pageSize=25`, { headers });
    expect((await factures.json()).items.some((facture: { clientId: string }) => facture.clientId === cibleId)).toBe(true);

    // V2 : retaper après une sélection efface l'ancien ID ; le POST doit porter le nouvel ID.
    const autres = await request.get(`${api}/clients?q=${encodeURIComponent(`${prefix} A 00`)}`, { headers });
    expect(autres.ok()).toBeTruthy();
    const correspondances = (await autres.json() as { clients: { id: string; raisonSociale: string }[] }).clients;
    const ancienId = correspondances.find(client => client.raisonSociale === `${prefix} A 000`)?.id;
    const autreId = correspondances.find(client => client.raisonSociale === `${prefix} A 001`)?.id;
    expect(ancienId).toBeTruthy();
    expect(autreId).toBeTruthy();
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await recherche.fill(`${prefix} A 000`);
    await expect(select.locator(`option[value="${ancienId}"]`)).toHaveCount(1);
    await select.selectOption(ancienId!);
    // La recherche élargie inclut l'ancien client : le DOM ne peut pas effacer
    // implicitement une option disparue. Seule la remise à zéro de l'état le fait.
    await recherche.fill(`${prefix} A 00`);
    await expect(select).toHaveValue('');
    await expect(select).toBeDisabled();
    await expect(select.locator(`option[value="${autreId}"]`)).toHaveCount(1);
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('');
    await select.selectOption(autreId!);
    await page.locator('input[name="motifHorsAffaire"]').fill('Nouvelle sélection #111');
    await page.getByRole('textbox', { name: 'Désignation ligne 1' }).fill('Prestation nouvelle sélection');
    await page.getByRole('textbox', { name: 'Prix unitaire HT ligne 1' }).fill('10');
    const creationAutre = page.waitForResponse(response => response.url().endsWith('/api/factures') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    const reponseAutre = await creationAutre;
    expect(reponseAutre.status(), await reponseAutre.text()).toBe(201);
    const factureId = (await reponseAutre.json() as { id: string }).id;
    let clientEnregistre: string | undefined;
    for (let numeroPage = 1; ; numeroPage++) {
      const liste = await request.get(`${api}/factures?page=${numeroPage}&pageSize=100`, { headers });
      expect(liste.ok()).toBeTruthy();
      const donnees = await liste.json() as { total: number; items: { id: string; clientId: string }[] };
      clientEnregistre = donnees.items.find(item => item.id === factureId)?.clientId;
      if (clientEnregistre || numeroPage * 100 >= donnees.total) break;
    }
    expect(clientEnregistre).toBe(autreId);
  });
  const afficherFacture = async (page: Page, raisonSociale: string) => {
    const ligne = page.locator('tbody tr', { hasText: raisonSociale });
    // Signal positif d'abord : le compte n'apparaît qu'une fois une réponse reçue (#211), même si la
    // page n'est pas encore montée quand le parcours arrive ici. Il reste affiché pendant un
    // changement de page : chaque clic attend ensuite la fin du chargement.
    await expect(page.getByTestId('pagination-factures')).toContainText('document(s)');
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    // Deux factures créées à la suite peuvent tomber de part et d'autre d'une frontière
    // de page ; repartir du début aussi bien pour l'ancienne que pour la nouvelle.
    const precedente = page.getByRole('button', { name: 'Page précédente' });
    while (await precedente.isEnabled()) {
      await precedente.click();
      await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    }
    while (!(await ligne.count())) {
      const suivante = page.getByRole('button', { name: 'Page suivante' });
      expect(await suivante.isEnabled(), `facture ${raisonSociale} absente de la pagination`).toBeTruthy();
      await suivante.click();
      await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    }
    return ligne;
  };
  // #211 : tant que la première réponse n'est pas arrivée, la page ne se dit pas vide, ne donne pas de
  // compte et ne propose pas de date ; les parcours qui attendent la fin du chargement l'attendent bien.
  // Un observateur installé avant le premier rendu relève tout état vide affiché, même fugace (un
  // rendu initial remplacé aussitôt par l'effet de chargement échapperait aux sondages).
  test('#211 : la liste n’affiche ni vide, ni compte, ni date proposée avant sa première réponse', async ({ allerSurPageAdmin }) => {
    const page = await allerSurPageAdmin('/');
    let liberer!: () => void;
    const attente = new Promise<void>(resolve => { liberer = resolve; });
    const listeFactures = (url: URL) => url.pathname === '/api/factures';
    await page.route(listeFactures, async route => { await attente; await route.continue(); });
    await page.addInitScript(() => {
      const releves: string[] = [];
      (window as unknown as { etatsVidesReleves: string[] }).etatsVidesReleves = releves;
      const relever = (etat: string, present: boolean) => { if (present && !releves.includes(etat)) releves.push(etat); };
      new MutationObserver(() => {
        const texte = document.body?.textContent ?? '';
        relever('liste vide', texte.includes('Aucune facture.'));
        relever('compte', /\d+ document\(s\)/.test(texte));
        relever('aucune facture numérotée', texte.includes('Dernière facture numérotée : aucune'));
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    const pagination = page.getByTestId('pagination-factures');
    const dateEmission = page.locator('input[name="dateEmission"]');
    try {
      await page.goto('/factures');
      await expect(page.locator('tbody [role="status"]')).toHaveText('Chargement des factures…');
      await expect(pagination.locator('span')).toHaveText('Page 1');
      await expect(page.getByTestId('derniere-date-facture')).toHaveText('Dernière facture numérotée : en cours de chargement.');
      await page.getByRole('button', { name: /Nouvelle facture/ }).click();
      await expect(dateEmission).toBeDisabled();
      await expect(dateEmission).toHaveValue('');
      expect(await page.evaluate(() => (window as unknown as { etatsVidesReleves: string[] }).etatsVidesReleves)).toEqual([]);
    } finally {
      liberer();
    }
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    await expect(pagination).toContainText(/Page 1 sur \d+ — \d+ document\(s\)/);
    await expect(page.getByTestId('derniere-date-facture')).not.toContainText('en cours de chargement');
    await expect(dateEmission).toBeEnabled();
    await expect(dateEmission).toHaveValue(/^\d{2}-\d{2}-\d{4}$/);
    await page.unroute(listeFactures);
  });

  test('#105 : consulte la chaîne de l’affaire depuis la facture puis navigue vers la fiche affaire', async ({ allerSurPageAdmin, creerClient, request, session }) => {
    const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
    const headers = { Authorization: `Bearer ${session.token}` };
    const client = await creerClient('origine-affaire');
    const post = async (path: string, data: object) => {
      const response = await request.post(`${api}${path}`, { headers, data });
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const devis = await post('/devis', { clientId: client.id, objet: 'Chaîne affaire E2E', lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
    const envoi = await request.put(`${api}/devis/${devis.id}/statut`, { headers, data: { statut: 'ENVOYE' } });
    expect(envoi.ok(), await envoi.text()).toBeTruthy();
    await post(`/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    const chantier = await post(`/devis/${devis.id}/convertir`, { cible: 'CHANTIER' });
    const intervention = await post('/interventions', { clientId: client.id, chantierId: chantier.id, titre: 'SAV lié #105' });
    const interventionLiee = await post('/interventions', { clientId: client.id, chantierId: chantier.id, titre: 'SAV non facturé #105' });
    await post('/factures', { clientId: client.id, origine: 'INTERVENTION', interventionId: intervention.id, dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'SAV', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
    const page = await allerSurPageAdmin('/factures');
    const ligne = await afficherFacture(page, client.raisonSociale);
    await expect(page.getByRole('region', { name: 'Origine de la facture' })).toHaveCount(0);
    await ligne.getByRole('button', { name: 'Voir l’origine' }).click();
    const detail = page.getByRole('region', { name: 'Origine de la facture' });
    await expect(detail).toContainText('Chaîne affaire E2E');
    await expect(detail.locator('p').filter({ hasText: /^Affaire :/ })).toContainText(chantier.nom);
    await expect(detail.locator('p').filter({ hasText: /^Affaire :/ })).toContainText(devis.numero);
    await expect(detail).not.toContainText('Affaire rattachée à l’intervention');
    await expect(detail).toContainText('SAV lié #105');
    const listitems = detail.getByRole('listitem');
    await expect(listitems).toHaveCount(2);
    await expect(listitems.filter({ hasText: 'SAV non facturé #105' })).toContainText(interventionLiee.reference);
    await expect(listitems.filter({ hasText: 'SAV lié #105' })).toContainText(intervention.reference);
    await expect(detail).toContainText(client.raisonSociale);
    await detail.getByRole('button', { name: 'Fermer' }).click();
    await page.route('**/api/factures/*/tracabilite', async route => {
      const response = await route.fetch();
      const trace = await response.json();
      await route.fulfill({ response, json: { ...trace, devis: null, devisAmbigu: true } });
    });
    await ligne.getByRole('button', { name: 'Voir l’origine' }).click();
    await expect(detail.getByRole('alert')).toContainText('Plusieurs devis');
    await expect(detail).not.toContainText('Aucun devis lié.');
    await expect(detail.locator('p').filter({ hasText: /^Devis :/ })).not.toContainText(devis.numero);
    await detail.getByRole('link', { name: /Voir l’affaire/ }).click();
    await expect(page).toHaveURL(new RegExp(`/chantiers/${chantier.id}$`));
    await expect(page.getByRole('heading', { name: chantier.nom })).toBeVisible();
  });

  test('#105 : hors affaire, chargement, erreur et réponse périmée ne fabriquent pas d’affaire', async ({ allerSurPageAdmin, creerClient, request, session }) => {
    const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
    const client = await creerClient('origine-hors-affaire');
    const headers = { Authorization: `Bearer ${session.token}` };
    const creer = async (motif: string) => {
      const response = await request.post(`${api}/factures`, { headers, data: { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: motif, quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] } });
      expect(response.status(), await response.text()).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    const marqueur = Date.now();
    const motifAncien = `Exception ancienne #105 ${marqueur}`;
    const motifActuel = `Exception actuelle #105 ${marqueur}`;
    const ancien = await creer(motifAncien);
    const actuel = await creer(motifActuel);
    const page = await allerSurPageAdmin('/factures');
    let liberer!: () => void;
    const attente = new Promise<void>(resolve => { liberer = resolve; });
    await page.route(`**/api/factures/${ancien}/tracabilite`, async route => {
      await attente;
      await route.continue();
    });
    await (await afficherFacture(page, motifAncien)).getByRole('button', { name: 'Voir l’origine' }).click();
    const detail = page.getByRole('region', { name: 'Origine de la facture' });
    await expect(detail).toContainText('Chargement');
    await page.route(`**/api/factures/${actuel}/tracabilite`, async route => { await route.fulfill({ status: 503, json: { error: 'Lecture temporairement indisponible.' } }); });
    await (await afficherFacture(page, motifActuel)).getByRole('button', { name: 'Voir l’origine' }).click();
    await expect(detail).toContainText('Lecture temporairement indisponible.');
    const ancienneLivree = page.waitForResponse(response => response.url().endsWith(`/api/factures/${ancien}/tracabilite`));
    liberer();
    const ancienneReponse = await ancienneLivree;
    expect(ancienneReponse.ok()).toBeTruthy();
    await ancienneReponse.finished();
    await expect(detail.getByRole('alert')).toContainText('Lecture temporairement indisponible.');
    await expect(detail).not.toContainText('Exception ancienne #105');
    await page.unroute(`**/api/factures/${actuel}/tracabilite`);
    await detail.getByRole('button', { name: 'Réessayer' }).click();
    await expect(detail).toContainText('Exception actuelle #105');
    await expect(detail).toContainText('Aucune affaire liée');
    await expect(detail.getByRole('link', { name: /Voir l’affaire/ })).toHaveCount(0);

    // Une erreur du premier chargement ne doit pas remplacer la trace du second.
    let libererErreur!: () => void;
    const attenteErreur = new Promise<void>(resolve => { libererErreur = resolve; });
    await page.unroute(`**/api/factures/${ancien}/tracabilite`);
    await page.route(`**/api/factures/${ancien}/tracabilite`, async route => {
      await attenteErreur;
      await route.fulfill({ status: 503, json: { error: 'Erreur ancienne #105' } });
    });
    await (await afficherFacture(page, motifAncien)).getByRole('button', { name: 'Voir l’origine' }).click();
    await expect(detail).toContainText('Chargement');
    await (await afficherFacture(page, motifActuel)).getByRole('button', { name: 'Voir l’origine' }).click();
    await expect(detail).toContainText(motifActuel);
    const erreurLivree = page.waitForResponse(response => response.url().endsWith(`/api/factures/${ancien}/tracabilite`) && response.status() === 503);
    libererErreur();
    const erreurReponse = await erreurLivree;
    await erreurReponse.finished();
    await expect(detail).toContainText(motifActuel);
    await expect(detail).not.toContainText('Erreur ancienne #105');
    await expect(detail.getByRole('alert')).toHaveCount(0);
  });
  const hier = () => {
    const [jour, mois, annee] = dateDuJour().split('-').map(Number);
    const date = new Date(Date.UTC(annee, mois - 1, jour - 1));
    return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
  };
  const apiChronologie = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
  const brouillonChronologie = async (request: import('@playwright/test').APIRequestContext, token: string, clientId: string, date: string) => {
    const reponse = await request.post(`${apiChronologie}/factures`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Chronologie E2E', dateEmission: date, dateEcheance: dateDuJour(), lignes: [{ designation: 'Contrôle chronologie', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] },
    });
    expect(reponse.status(), await reponse.text()).toBe(201);
    return (await reponse.json() as { id: string }).id;
  };

  test('chronologie #101 : recharge après un 409 concurrent et conserve le motif serveur', async ({ allerSurPageAdmin, creerClient, request, session, page }) => {
    const ancien = await creerClient('chronologie-concurrent');
    const nouveau = await creerClient('chronologie-reference');
    const ancienId = await brouillonChronologie(request, session.token, ancien.id, hier());
    const nouveauId = await brouillonChronologie(request, session.token, nouveau.id, dateDuJour());
    await page.route('**/api/factures/chronologie', async route => {
      await route.fulfill({ json: { derniereDateEmission: null } });
    });
    await allerSurPageAdmin('/factures');
    const ligne = await afficherFacture(page, ancien.raisonSociale);
    await expect(ligne.getByRole('button', { name: 'Émettre' })).toBeEnabled();
    const emission = await request.post(`${apiChronologie}/factures/${nouveauId}/emettre`, { headers: { Authorization: `Bearer ${session.token}` } });
    expect(emission.status(), await emission.text()).toBe(200);
    await page.unroute('**/api/factures/chronologie');
    const refus = page.waitForResponse(response => response.url().endsWith(`/factures/${ancienId}/emettre`));
    await ligne.getByRole('button', { name: 'Émettre' }).click();
    expect((await refus).status()).toBe(409);
    await expect(page.getByText(/La numérotation est chronologique : la dernière facture émise porte la date du/)).toBeVisible();
    await expect(page.getByTestId('derniere-date-facture')).toContainText(dateDuJour());
    await expect(ligne.getByRole('button', { name: /Émission impossible/ })).toBeDisabled();
    await expect(page.getByText(/La numérotation est chronologique : la dernière facture émise porte la date du/)).toBeVisible();
  });

  test('chronologie #101 : affiche la date et désactive le brouillon antérieur, pas celui du même jour', async ({ allerSurPageAdmin, creerClient, request, session }) => {
    const ancien = await creerClient('chronologie-ancien');
    const egal = await creerClient('chronologie-egal');
    await brouillonChronologie(request, session.token, ancien.id, hier());
    await brouillonChronologie(request, session.token, egal.id, dateDuJour());
    const page = await allerSurPageAdmin('/factures');
    await expect(page.getByTestId('derniere-date-facture')).toContainText(dateDuJour());
    const ligneAncienne = await afficherFacture(page, ancien.raisonSociale);
    await expect(ligneAncienne.getByRole('button', { name: /Émission impossible/ })).toBeDisabled();
    await expect(ligneAncienne).toContainText(dateDuJour());
    while (await page.getByRole('button', { name: 'Page précédente' }).isEnabled()) {
      await page.getByRole('button', { name: 'Page précédente' }).click();
      await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    }
    await expect((await afficherFacture(page, egal.raisonSociale)).getByRole('button', { name: 'Émettre' })).toBeEnabled();
  });

  // Prépare une facture émise hors affaire et rend sa ligne de tableau.
  const emettreFactureSource = async (page: Page, client: { id: string; raisonSociale: string }, lignes: Array<[string, string, string]>) => {
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours avoir partiel');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    for (let index = 1; index < lignes.length; index += 1) await page.getByRole('button', { name: /Ajouter une ligne$/ }).click();
    for (const [rang, [quantite, prix, taux]] of lignes.entries()) {
      const index = rang + 1;
      await page.locator(`input[aria-label="Désignation ligne ${index}"]`).fill(`Prestation à créditer ${index}`);
      for (const [label, valeur] of [['Quantité', quantite], ['Prix unitaire HT', prix], ['TVA', taux]] as const) {
        const champ = page.locator(`input[aria-label="${label} ligne ${index}"]`);
        await champ.click();
        await champ.press('Control+a');
        await champ.pressSequentially(valeur, { delay: 10 });
      }
    }
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    const facture = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    // Un brouillon n'est pas créditable : attendre sa ligne rend l'assertion d'absence
    // significative, plutôt que vraie sur une ligne pas encore rendue.
    await expect(facture).toContainText('BROUILLON');
    await expect(facture.getByRole('button', { name: /Créer un avoir partiel/ })).toHaveCount(0);
    await facture.getByRole('button', { name: /Émettre/ }).click();
    await expect(facture).toContainText('EMISE');
    return facture;
  };

  // Remplit la ligne d'avoir `index` du formulaire ouvert.
  const remplirLigneAvoir = async (page: Page, index: number, quantite: string, prix: string, taux: string) => {
    await page.locator(`input[aria-label="Désignation ligne avoir ${index}"]`).fill(`Geste commercial ${index}`);
    await page.locator(`select[aria-label="Nature ligne avoir ${index}"]`).selectOption('PRESTATION');
    // Simule la saisie réelle : fill() n'exerce pas la régression des virgules dans les
    // champs décimaux que ces parcours doivent retenir.
    for (const [label, valeur] of [['Quantité', quantite], ['Prix unitaire HT', prix], ['TVA', taux]] as const) {
      const champ = page.locator(`input[aria-label="${label} ligne avoir ${index}"]`);
      await champ.click();
      await champ.press('Control+a');
      await champ.pressSequentially(valeur, { delay: 10 });
    }
  };

  test('saisit plusieurs lignes à la virgule et conserve les totaux exacts', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('multi-lignes');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours multi-lignes');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.getByRole('button', { name: /Ajouter une ligne/ }).click();
    await page.getByRole('button', { name: /Ajouter une ligne/ }).click();

    const remplir = async (index: number, designation: string, nature: string, quantite: string, prix: string, taux: string) => {
      await page.locator(`input[aria-label="Désignation ligne ${index}"]`).fill(designation);
      await page.locator(`select[aria-label="Nature ligne ${index}"]`).selectOption(nature);
      // Il faut simuler les touches : fill() n'exerce pas le comportement navigateur qui
      // rejetait auparavant la virgule avec <input type="number">.
      for (const [label, valeur] of [['Quantité', quantite], ['Prix unitaire HT', prix], ['TVA', taux]] as const) {
        const champ = page.locator(`input[aria-label="${label} ligne ${index}"]`);
        await champ.click();
        await champ.press('Control+a');
        await champ.pressSequentially(valeur, { delay: 10 });
      }
    };
    await remplir(1, 'Pose de centrale incendie', 'PRESTATION', '2', '1234,56', '20');
    await remplir(2, 'Détecteur optique', 'ARTICLE', '3', '49,90', '10');
    await remplir(3, 'Mise en service', 'PRESTATION', '1', '250', '20');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();

    const ligne = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await expect(ligne).toHaveCount(1);
    await expect(ligne).toContainText(/3\s*427,61\s*€/);
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ client: { id: string }; lignes: Array<{ ordre: number; nature: string; prixUnitaireHt: number }>; totalHt: number; totalTva: number; totalTtc: number }>;
    const facture = factures.find((item) => item.client.id === client.id);
    if (!facture) throw new Error('Facture multi-lignes absente de l’API');
    expect(facture.lignes.map((item) => [item.ordre, item.nature, item.prixUnitaireHt])).toEqual([
      [0, 'PRESTATION', 1234.56], [1, 'ARTICLE', 49.9], [2, 'PRESTATION', 250],
    ]);
    expect([facture.totalHt, facture.totalTva, facture.totalTtc]).toEqual([2868.82, 558.79, 3427.61]);
  });

  test('crée un avoir partiel depuis une facture émise et actualise la liste', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-partiel');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours avoir partiel');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Prestation à créditer');
    await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    const facture = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await facture.getByRole('button', { name: /Émettre/ }).click();
    await expect(facture).toContainText('EMISE');

    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toBeVisible();
    await page.getByRole('button', { name: /Ajouter une ligne d’avoir/ }).click();
    await page.getByRole('button', { name: /Supprimer la ligne d’avoir 2/ }).click();
    await page.locator('input[aria-label="Désignation ligne avoir 1"]').fill('Geste commercial');
    await page.locator('select[aria-label="Nature ligne avoir 1"]').selectOption('PRESTATION');
    await page.locator('input[aria-label="Quantité ligne avoir 1"]').fill('0,5');
    await page.locator('input[aria-label="Prix unitaire HT ligne avoir 1"]').fill('100');
    await page.locator('input[aria-label="TVA ligne avoir 1"]').fill('20');
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/50,00\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/10,00\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/60,00\s*€/);
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/Avoir .* créé et émis/)).toBeVisible();

    const avoir = (await afficherFacture(page, client.raisonSociale)).filter({ has: page.getByText('Avoir', { exact: true }) });
    await expect(avoir).toHaveCount(1);
    await expect(avoir).toContainText(/60,00\s*€/);
    await expect(avoir).toContainText(/\d{2}[-/]\d{2}[-/]\d{4}/);
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; factureOrigine?: { id: string }; client: { id: string }; totalHt: number; totalTva: number; totalTtc: number }>;
    const avoirApi = factures.find((item) => item.type === 'AVOIR' && item.client.id === client.id);
    if (!avoirApi) throw new Error('Avoir partiel absent de l’API');
    expect([avoirApi.totalHt, avoirApi.totalTva, avoirApi.totalTtc]).toEqual([50, 10, 60]);
  });

  // #247 : un avoir émis est figé. Un double clic, ou deux soumissions du même instant, n'en émettent
  // qu'un : le bouton est désactivé pendant l'envoi, et une seconde soumission est ignorée.
  test('un double envoi du formulaire d’avoir partiel n’émet qu’un avoir', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-double-envoi');
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['1', '100', '20']]);
    const avoirsDuClient = async () => {
      const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string }; totalHt: number; totalTtc: number }>;
      return factures.filter((item) => item.type === 'AVOIR' && item.client.id === client.id).map((avoir) => [avoir.totalHt, avoir.totalTtc]);
    };
    const ouvrir = async () => {
      await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
      await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toBeVisible();
      await remplirLigneAvoir(page, 1, '1', '10', '20');
    };
    // Chaque envoi est retenu jusqu'à ce que le parcours le libère : le bouton est observé pendant
    // l'envoi sans dépendre d'un délai, et chaque POST est compté.
    let envois = 0;
    let liberer!: () => void;
    let barriere = Promise.resolve();
    const retenir = () => { barriere = new Promise<void>((resolve) => { liberer = resolve; }); };
    await page.route('**/api/factures/*/avoirs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      envois += 1;
      await barriere;
      await route.continue();
    });
    const bouton = page.getByRole('button', { name: /Créer l’avoir partiel/ });

    // Double clic.
    retenir();
    await ouvrir();
    await bouton.dblclick();
    // Souple : sans garde, le parcours continue et montre aussi le second envoi et le second avoir.
    await expect.soft(bouton).toBeDisabled();
    liberer();
    await expect(page.getByText(/Avoir .* créé et émis/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toHaveCount(0);
    expect(envois).toBe(1);
    expect(await avoirsDuClient()).toEqual([[10, 12]]);

    // Deux soumissions du même instant, avant tout nouveau rendu.
    retenir();
    await ouvrir();
    await page.locator('form', { has: page.getByRole('heading', { name: /Nouvel avoir partiel/ }) }).evaluate((formulaire: HTMLFormElement) => {
      formulaire.requestSubmit();
      formulaire.requestSubmit();
    });
    liberer();
    await expect(page.getByText(/Avoir .* créé et émis/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toHaveCount(0);
    expect(envois).toBe(2);
    expect(await avoirsDuClient()).toEqual([[10, 12], [10, 12]]);
    await page.unroute('**/api/factures/*/avoirs');
  });

  // #247 : sans réponse de l'API, l'avoir a pu être émis. L'écran ne l'affirme ni ne le nie, relit la
  // liste, puis libère le formulaire : une nouvelle soumission reste possible, en connaissance de cause.
  // Même conduite pour une réponse perdue en chemin, une erreur de passerelle sans message et une
  // erreur serveur (5xx), même accompagnée d'un message.
  const reponsesSansIssue = [
    { cas: 'une réponse perdue', client: 'avoir-reponse-perdue', cause: /impossible de joindre le serveur/, perdre: (route: Route) => route.abort('connectionreset') },
    { cas: 'une erreur de passerelle sans message', client: 'avoir-reponse-passerelle', cause: /réponse inattendue du serveur \(502\)/, perdre: (route: Route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }) },
    { cas: 'une erreur serveur avec message', client: 'avoir-reponse-erreur-serveur', cause: /réponse inattendue du serveur \(500\)/, perdre: (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Création de l’avoir impossible.' }) }) },
  ];
  for (const { cas, client: nomClient, cause, perdre } of reponsesSansIssue) test(`${cas} à la création d’un avoir partiel relit la liste puis libère le formulaire`, async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient(nomClient);
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['1', '100', '20']]);
    const avoirsDuClient = async () => {
      const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string }; totalTtc: number }>;
      return factures.filter((item) => item.type === 'AVOIR' && item.client.id === client.id).map((avoir) => avoir.totalTtc);
    };
    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await remplirLigneAvoir(page, 1, '1', '10', '20');
    // Le serveur émet l'avoir, mais sa réponse n'arrive pas au navigateur.
    await page.route('**/api/factures/*/avoirs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await perdre(route);
    });
    const bouton = page.getByRole('button', { name: /Créer l’avoir partiel/ });
    await bouton.click();
    const message = page.getByText(/La création de l’avoir n’a pas pu être confirmée/);
    await expect(message).toBeVisible();
    await expect(message).toContainText(cause);
    await expect(message).toContainText('Vérifiez les avoirs de la facture dans la liste avant de réessayer.');
    await expect(facture).toContainText(/Annulation totale impossible : 1 avoir\(s\) partiel\(s\)/);
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toBeVisible();
    await expect(bouton).toBeEnabled();
    expect(await avoirsDuClient()).toEqual([12]);
    await page.unroute('**/api/factures/*/avoirs');

    await bouton.click();
    await expect(page.getByText(/Avoir .* créé et émis/)).toBeVisible();
    expect(await avoirsDuClient()).toEqual([12, 12]);
  });

  // #247 : la liste est relue AVANT de libérer le formulaire. Si cette relecture échoue aussi (réseau
  // toujours coupé, serveur en redémarrage), la liste affichée est périmée : le bouton reste désactivé
  // jusqu'à une actualisation réussie, qui montre l'avoir émis.
  test('après une issue inconnue, l’avoir partiel attend une relecture réussie de la liste', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-relecture-echouee');
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['1', '100', '20']]);
    const avoirsDuClient = async () => {
      const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string }; totalTtc: number }>;
      return factures.filter((item) => item.type === 'AVOIR' && item.client.id === client.id).map((avoir) => avoir.totalTtc);
    };
    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await remplirLigneAvoir(page, 1, '1', '10', '20');
    // Le serveur émet l'avoir, la réponse se perd, puis la relecture de la liste est retenue et échoue.
    let perdue = false;
    let libererRelecture!: () => void;
    const relecture = new Promise<void>((resolve) => { libererRelecture = resolve; });
    let signalerRelecture!: () => void;
    const relectureDemandee = new Promise<void>((resolve) => { signalerRelecture = resolve; });
    await page.route('**/api/**', async (route) => {
      const requete = route.request();
      if (requete.method() === 'POST' && /\/api\/factures\/[^/]+\/avoirs$/.test(requete.url())) {
        await route.fetch();
        perdue = true;
        return route.abort('connectionreset');
      }
      if (perdue && /\/api\/factures\?page=/.test(requete.url())) {
        signalerRelecture();
        await relecture;
        return route.abort('internetdisconnected');
      }
      return route.continue();
    });
    const bouton = page.getByRole('button', { name: /Créer l’avoir partiel/ });
    await bouton.click();
    await relectureDemandee;
    // Souple : sans attente de la relecture, le parcours montre aussi la suite.
    await expect.soft(bouton).toBeDisabled();
    libererRelecture();
    await expect(page.getByText(/La création de l’avoir n’a pas pu être confirmée/)).toBeVisible();
    await expect(page.getByText(/La liste n’a pas pu être relue : actualisez-la/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toBeVisible();
    await expect(bouton).toBeDisabled();
    expect(await avoirsDuClient()).toEqual([12]);
    await page.unroute('**/api/**');

    await page.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await expect(facture).toContainText(/Annulation totale impossible : 1 avoir\(s\) partiel\(s\)/);
    await expect(page.getByText(/La liste n’a pas pu être relue/)).toHaveCount(0);
    await expect(bouton).toBeEnabled();
  });

  // 0,5 × 4,27 = 2,135 € : l'aperçu doit annoncer le montant réellement émis,
  // y compris lorsque l'arrondi navigateur et celui du serveur divergent.
  test('l’aperçu d’avoir annonce au centime le montant réellement émis', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-arrondi');
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['10', '4,27', '20']]);
    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await remplirLigneAvoir(page, 1, '0,5', '4,27', '20');
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/2,14\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).not.toContainText(/2,13\s*€/);
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/créé et émis/)).toBeVisible();
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string }; totalHt: number; totalTva: number; totalTtc: number }>;
    const avoir = factures.find((item) => item.type === 'AVOIR' && item.client.id === client.id);
    if (!avoir) throw new Error('Avoir partiel absent de l’API');
    expect([avoir.totalHt, avoir.totalTva, avoir.totalTtc]).toEqual([2.14, 0.43, 2.57]);
  });

  // Deux lignes et deux taux exercent l'agrégation de l'aperçu, et vérifient que le
  // payload envoie bien toutes les lignes au serveur.
  test('crédite deux taux en un seul avoir et agrège l’aperçu par taux', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-deux-taux');
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['10', '100', '20'], ['10', '100', '10']]);
    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    await page.getByRole('button', { name: /Ajouter une ligne d’avoir/ }).click();
    await remplirLigneAvoir(page, 1, '1', '33,33', '20');
    await remplirLigneAvoir(page, 2, '2', '16,67', '10');
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/66,67\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/10,00\s*€/);
    await expect(page.getByTestId('aperçu-avoir')).toContainText(/76,67\s*€/);
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/créé et émis/)).toBeVisible();
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string }; lignes: Array<{ tauxTva: number }>; totalHt: number; totalTva: number; totalTtc: number }>;
    const avoir = factures.find((item) => item.type === 'AVOIR' && item.client.id === client.id);
    if (!avoir) throw new Error('Avoir à deux taux absent de l’API');
    expect(avoir.lignes.map((ligne) => ligne.tauxTva).sort((a, b) => a - b)).toEqual([10, 20]);
    expect([avoir.totalHt, avoir.totalTva, avoir.totalTtc]).toEqual([66.67, 10, 76.67]);
  });

  // Les refus métier restent visibles et conservent la saisie. Une création réussie
  // referme ensuite le formulaire et masque l'annulation totale désormais impossible.
  test('affiche les refus métier, conserve la saisie puis ferme le formulaire après succès', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('avoir-plafond');
    const page = await allerSurPageAdmin('/factures');
    const facture = await emettreFactureSource(page, client, [['10', '100', '20']]);
    await facture.getByRole('button', { name: /Créer un avoir partiel/ }).click();
    // Un refus de saisie, avant tout envoi, ne verrouille pas le formulaire (#247).
    await remplirLigneAvoir(page, 1, '0', '100', '20');
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/Ligne d’avoir 1 : désignation obligatoire, quantité supérieure à zéro/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Créer l’avoir partiel/ })).toBeEnabled();
    await remplirLigneAvoir(page, 1, '20', '100', '20');
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/Cet avoir dépasse le montant total restant à créditer/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toBeVisible();
    await expect(page.locator('input[aria-label="Prix unitaire HT ligne avoir 1"]')).toHaveValue('100');
    const refuse = await (await apiAdmin.get('/factures')).json() as Array<{ type: string; client: { id: string } }>;
    expect(refuse.filter((item) => item.type === 'AVOIR' && item.client.id === client.id)).toEqual([]);

    await remplirLigneAvoir(page, 1, '1', '10', '10');
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/Le taux de TVA d’une ligne d’avoir doit être présent/)).toBeVisible();

    await remplirLigneAvoir(page, 1, '1', '10', '20');
    await page.getByRole('button', { name: /Créer l’avoir partiel/ }).click();
    await expect(page.getByText(/créé et émis/)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Nouvel avoir partiel/ })).toHaveCount(0);
    await expect(facture.getByRole('button', { name: /Annuler la facture/ })).toHaveCount(0);
    await expect(facture).toContainText(/Annulation totale impossible : 1 avoir\(s\) partiel\(s\)/);
    await expect(facture.getByRole('link', { name: /Enregistrer un règlement/ })).toBeVisible();
  });

  test('émet un brouillon, attribue un numéro et rend le PDF disponible', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('emission');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours émission');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle annuel');
    const prix = page.locator('input[aria-label="Prix unitaire HT ligne 1"]');
    await prix.click();
    await prix.pressSequentially('480,50', { delay: 10 });
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    const ligne = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await ligne.getByRole('button', { name: /Émettre/ }).click();
    await expect(page.getByText(/émise et figée/)).toBeVisible();
    await expect(ligne).toContainText(/\d{4}-\d{4}/);
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ id: string; client: { id: string } }>;
    const facture = factures.find((item) => item.client.id === client.id);
    if (!facture) throw new Error('Facture émise absente de l’API');
    const document = await apiAdmin.get(`/factures/${facture.id}/document.pdf`);
    expect(document.status()).toBe(200);
    expect((await document.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('règle une facture en deux règlements, puis rouvre son reste dû par contre-passation', async ({ allerSurPageAdmin, creerClient }) => {
    const client = await creerClient('règlement');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours règlement');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle règlement');
    await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    const ligne = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await ligne.getByRole('button', { name: /Émettre/ }).click();
    await expect(page.getByText(/émise et figée/)).toBeVisible();
    // « Réglée » ne se coche plus : elle se déduit des règlements enregistrés.
    await expect(ligne.getByRole('button', { name: /Marquer comme réglée/ })).toHaveCount(0);
    await ligne.getByRole('link', { name: /Enregistrer un règlement/ }).click();
    await expect(page).toHaveURL(/\/reglements\?facture=/);

    // Le formulaire s'ouvre sur la facture, pour son reste dû.
    const formulaire = page.getByRole('form', { name: 'Nouveau règlement' });
    const montant = formulaire.getByLabel('Montant reçu');
    const part = formulaire.getByRole('textbox', { name: /Montant affecté à la facture/ });
    const envoyer = formulaire.getByRole('button', { name: 'Enregistrer le règlement' });
    await expect(formulaire.getByLabel('Client du règlement')).toHaveValue(client.id);
    await expect(montant).toHaveValue('120,00');
    await expect(part).toHaveValue('120,00');
    // Un règlement entièrement affecté seulement : l'écart bloque l'envoi.
    await montant.fill('50');
    await expect(formulaire.getByRole('status', { name: 'Affectation du règlement' })).toContainText('affecté en trop : 70,00 €');
    await expect(envoyer).toBeDisabled();
    await formulaire.getByRole('button', { name: 'Répartir le montant' }).click();
    await expect(part).toHaveValue('50,00');
    await formulaire.getByLabel('Moyen de paiement').selectOption('CHEQUE');
    // Référence unique : la base E2E est rejouée sans être vidée.
    const referenceCheque = `CHQ ${Date.now()}`;
    await formulaire.getByLabel('Référence du règlement').fill(referenceCheque);
    await envoyer.click();
    await expect(page.getByText(/Règlement de 50,00\s€ enregistré/)).toBeVisible();
    const reglements = page.getByRole('table', { name: 'Règlements enregistrés' });
    const cheque = reglements.locator('tr', { hasText: referenceCheque });
    await expect(cheque).toContainText(client.raisonSociale);
    await expect(cheque).toContainText('Chèque');
    await expect(cheque).toContainText('Enregistré');

    await page.goto('/factures');
    let apres = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await expect(apres).toContainText('EMISE');
    await expect(apres).toContainText('Partiellement réglée');
    await expect(apres).toContainText(/70,00\s€/);
    await expect(apres.getByRole('button', { name: /Annuler la facture/ })).toHaveCount(0);
    await expect(apres).toContainText('Annulation totale impossible : un règlement a été reçu');

    await apres.getByRole('link', { name: /Enregistrer un règlement/ }).click();
    await expect(montant).toHaveValue('70,00');
    await envoyer.click();
    await expect(page.getByText(/Règlement de 70,00\s€ enregistré/)).toBeVisible();
    await page.goto('/factures');
    apres = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await expect(apres).toContainText('REGLEE');
    await expect(apres.getByRole('link', { name: /Enregistrer un règlement/ })).toHaveCount(0);

    // Le chèque revient impayé : la contre-passation, motivée, rouvre le reste dû.
    await page.goto('/reglements');
    await cheque.getByRole('button', { name: 'Contre-passer' }).click();
    await cheque.getByLabel('Motif de la contre-passation').fill('Chèque refusé par la banque');
    await cheque.getByRole('button', { name: 'Confirmer la contre-passation' }).click();
    await expect(page.getByText(/contre-passé : le reste dû de ses factures est rouvert/)).toBeVisible();
    await expect(cheque).toContainText('Contre-passé');
    await expect(cheque).toContainText('Motif : Chèque refusé par la banque');
    await expect(cheque.getByRole('button', { name: 'Contre-passer' })).toHaveCount(0);
    await page.goto('/factures');
    apres = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await expect(apres).toContainText('EMISE');
    await expect(apres).toContainText('Partiellement réglée');
    await expect(apres).toContainText(/50,00\s€/);
  });

  // Ce parcours couvre confirmation, statut et téléchargement ; le contenu du PDF est
  // extrait et vérifié par les tests serveur avec pdf-parse.
  test('annule une facture après confirmation et garde son document téléchargeable', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('annulation');
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours annulation');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle annulation');
    await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    const ligne = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await ligne.getByRole('button', { name: /Émettre/ }).click();
    let confirmationDemandee = '';
    page.once('dialog', (dialog) => { confirmationDemandee = dialog.message(); void dialog.accept(); });
    await ligne.getByRole('button', { name: /Annuler la facture/ }).click();
    await expect(page.getByText(/annulée ; avoir .* disponible/i)).toBeVisible();
    expect(confirmationDemandee).toMatch(/Annuler la facture/);
    await expect(ligne).toContainText('ANNULEE');
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ id: string; client: { id: string } }>;
    const facture = factures.find((item) => item.client.id === client.id);
    if (!facture) throw new Error('Facture annulée absente de l’API');
    const document = await apiAdmin.get(`/factures/${facture.id}/document.pdf`);
    expect(document.status()).toBe(200);
    expect((await document.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('refuse la ligne invalide sans créer de facture', async ({ allerSurPageAdmin, creerClient, apiAdmin }) => {
    const client = await creerClient('invalide'); const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click(); await choisirClient(page, client);
    await page.locator('input[name="motifHorsAffaire"]').fill('Validation client'); await page.getByRole('button', { name: /Ajouter une ligne/ }).click();
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Correcte'); await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('10');
    await page.locator('input[aria-label="Désignation ligne 2"]').fill('Invalide'); await page.locator('input[aria-label="Prix unitaire HT ligne 2"]').pressSequentially('douze');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click(); await expect(page.getByText(/^Ligne 2 :/)).toBeVisible();
    const factures = await (await apiAdmin.get('/factures')).json() as Array<{ client: { id: string } }>; expect(factures.filter((item) => item.client.id === client.id)).toHaveLength(0);
  });

  test('affiche le refus d’émission sans adresse et ne consomme pas de numéro', async ({ allerSurPageAdmin, creerClient }) => {
    const client = await creerClient('sans-site', false);
    const page = await allerSurPageAdmin('/factures');
    await page.getByRole('button', { name: /Nouvelle facture/ }).click();
    await choisirClient(page, client);
    await page.locator('input[name="motifHorsAffaire"]').fill('Parcours sans adresse');
    await page.locator('input[name="dateEmission"]').fill(dateDuJour());
    await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
    await page.locator('input[aria-label="Désignation ligne 1"]').fill('Prestation refusée');
    const prix = page.locator('input[aria-label="Prix unitaire HT ligne 1"]');
    await prix.click();
    await prix.pressSequentially('100');
    await page.getByRole('button', { name: /Créer le brouillon/ }).click();
    await expect(page.getByText(/Brouillon créé/)).toBeVisible();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
    const ligne = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
    await ligne.getByRole('button', { name: /Émettre/ }).click();
    await expect(page.getByText(/adresse de facturation/i)).toBeVisible();
    await expect(ligne).toContainText('Brouillon');
  });

  test('ne bloque pas la facturation lorsqu’un contrôle non bloquant manque', async ({ allerSurPageAdmin }) => {
    const page = await allerSurPageAdmin('/prete-a-facturer');
    await expect(page.getByRole('heading', { name: 'Prêt à facturer' })).toBeVisible();
    await expect(page.getByText('Configuration prête pour la facturation.')).toBeVisible();
    const prefixe = page.locator('article', { hasText: 'Préfixe de facture' });
    await expect(prefixe).toContainText('Non bloquant');
    await expect(prefixe.getByRole('link', { name: 'Configurer' })).toHaveCount(0);
  });

  test('n’expose pas d’acceptation manuelle : seule la signature peut accepter un devis envoyé', async ({ allerSurPageAdmin, apiAdmin, creerClient, request, session }) => {
    const client = await creerClient('devis-signature', false);
    const apiResponse = await apiAdmin.get('/company');
    expect(apiResponse.ok(), await apiResponse.text()).toBeTruthy();
    const api = new URL('/api', apiResponse.url()).toString().replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${session.token}` };
    const objet = `Devis E2E signature ${Date.now()}`;
    const creation = await request.post(`${api}/devis`, {
      headers,
      data: { clientId: client.id, objet, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
    });
    expect(creation.ok(), await creation.text()).toBeTruthy();
    const { id } = await creation.json() as { id: string };
    const envoi = await request.put(`${api}/devis/${id}/statut`, { headers, data: { statut: 'ENVOYE' } });
    expect(envoi.ok(), await envoi.text()).toBeTruthy();

    const page = await allerSurPageAdmin('/devis');
    const ligne = page.locator('li', { hasText: objet });
    await expect(ligne).toContainText('ENVOYE');
    await expect(ligne.getByRole('button', { name: 'Accepter' })).toHaveCount(0);
    await expect(ligne.getByRole('button', { name: 'Faire signer le client' })).toBeVisible();
  });

  test('fait signer le client désigné et identifie l’employé qui enregistre', async ({ allerSurPageAdmin, apiAdmin, creerClient, request, session }) => {
    const client = await creerClient('signataire-client', false);
    const apiResponse = await apiAdmin.get('/company');
    expect(apiResponse.ok(), await apiResponse.text()).toBeTruthy();
    const api = new URL('/api', apiResponse.url()).toString().replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${session.token}` };
    const contact = await request.post(`${api}/clients/${client.id}/contacts`, { headers, data: { prenom: 'Claire', nom: 'Cliente', estSignataire: true } });
    expect(contact.status(), await contact.text()).toBe(201);
    const objet = `Devis E2E signataire client ${Date.now()}`;
    const creation = await request.post(`${api}/devis`, {
      headers,
      data: { clientId: client.id, objet, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
    });
    expect(creation.ok(), await creation.text()).toBeTruthy();

    const page = await allerSurPageAdmin('/devis');
    const ligne = page.locator('li', { hasText: objet });
    await ligne.getByRole('button', { name: 'Faire signer le client' }).click();
    const formulaire = page.getByRole('dialog', { name: 'Signature client' });
    await expect(formulaire.getByLabel('Enregistré par')).not.toHaveValue('');
    await expect(formulaire.getByLabel('Autre signataire client')).toBeVisible();
    await formulaire.getByLabel('Signataire client', { exact: true }).selectOption({ label: 'Claire Cliente' });
    await formulaire.getByLabel('Confirmation du client').check();
    await formulaire.getByRole('button', { name: 'Enregistrer la signature client' }).click();
    await expect(ligne).toContainText('Signature client : Claire Cliente');
  });

  test('réserve aux administrateurs le PDF des factures liées de la fiche affaire', async ({ page, apiAdmin, creerClient, request, session }) => {
    const apiResponse = await apiAdmin.get('/company');
    expect(apiResponse.ok(), await apiResponse.text()).toBeTruthy();
    const api = new URL('/api', apiResponse.url()).toString().replace(/\/$/, '');
    const client = await creerClient('factures-liees');
    const headers = { Authorization: `Bearer ${session.token}` };
    const devis = await request.post(`${api}/devis`, {
      headers,
      data: { clientId: client.id, objet: `Affaire E2E facturée ${Date.now()}`, lignes: [{ designation: 'Pose facturée', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
    });
    expect(devis.ok(), await devis.text()).toBeTruthy();
    const { id: devisId } = await devis.json() as { id: string };
    const envoi = await request.put(`${api}/devis/${devisId}/statut`, { headers, data: { statut: 'ENVOYE' } });
    expect(envoi.ok(), await envoi.text()).toBeTruthy();
    const signature = await request.post(`${api}/devis/${devisId}/signature`, { headers, data: { signataire: 'Signataire E2E', confirme: true } });
    expect(signature.ok(), await signature.text()).toBeTruthy();
    const conversion = await request.post(`${api}/devis/${devisId}/convertir`, { headers, data: { cible: 'CHANTIER' } });
    expect(conversion.ok(), await conversion.text()).toBeTruthy();
    const { id: chantierId } = await conversion.json() as { id: string };
    // Conducteur désigné responsable, et laissé destinataire de la rentabilité (réglage par
    // défaut, rappelé ici car la base est partagée) : c'est la configuration où le serveur
    // lui livre le bloc facturation. Le tableau visible rend l'absence du PDF significative.
    const reglage = await request.put(`${api}/parametres`, { headers, data: { rentabiliteConducteur: true } });
    expect(reglage.ok(), await reglage.text()).toBeTruthy();
    const nom = 'Conducteur factures liées';
    const creation = await request.post(`${api}/users`, {
      headers,
      data: { email: `conducteur.factures.${Date.now()}@iris.test`, name: nom, role: 'CONDUCTEUR_TRAVAUX' },
    });
    expect(creation.status(), await creation.text()).toBe(201);
    const { id: conducteurId } = await creation.json() as { id: string };
    const affectation = await request.patch(`${api}/chantiers/${chantierId}`, {
      headers,
      data: { responsableId: conducteurId },
    });
    expect(affectation.ok(), await affectation.text()).toBeTruthy();
    const brouillon = await request.post(`${api}/factures`, {
      headers,
      data: { clientId: client.id, origine: 'CHANTIER', chantierId, dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Pose facturée', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
    });
    expect(brouillon.ok(), await brouillon.text()).toBeTruthy();
    const { id: factureId } = await brouillon.json() as { id: string };
    const emission = await request.post(`${api}/factures/${factureId}/emettre`, { headers });
    expect(emission.ok(), await emission.text()).toBeTruthy();
    const { numero } = await emission.json() as { numero: string };

    const jeton = jetonPour(conducteurId);
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jeton, JSON.stringify({ id: conducteurId, name: nom, email: 'conducteur@iris.test', role: 'CONDUCTEUR_TRAVAUX', permissions: [] })]);
    await page.goto(`/chantiers/${chantierId}`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').role)).toBe('CONDUCTEUR_TRAVAUX');
    const liste = page.getByRole('region', { name: 'Factures liées' });
    await expect(liste).toBeVisible();
    const ligne = liste.locator('tr', { hasText: numero });
    // Ancrer le tableau avant l'absence du bouton : zéro bouton sur zéro ligne passerait
    // aussi, et masquerait une régression de rendu ou de périmètre du conducteur.
    await expect(liste.locator('th')).toHaveCount(6);
    await expect(ligne.locator('td').nth(0)).toHaveText(numero);
    await expect(ligne.locator('td').nth(4)).toHaveText(/^100\s*€$/);
    await expect(ligne.locator('td')).toHaveCount(6);
    // L'en-tête et les cellules suivent la même garde administrateur : sans ces comptes,
    // une colonne « Action » orpheline rendrait le tableau désaligné sans fuite de données.
    await expect(ligne.getByRole('button', { name: 'PDF' })).toHaveCount(0);
    const pdf = await request.get(`${api}/factures/${factureId}/document.pdf`, { headers: { Authorization: `Bearer ${jeton}` } });
    expect(pdf.status(), await pdf.text()).toBe(403);
  });

  test.describe('navigateur Pacific/Gambier', () => {
    test.use({ timezoneId: 'Pacific/Gambier' });

    // dateEmission est une date-seule stockée à minuit UTC : à l'ouest de Greenwich,
    // un rendu qui passerait par le fuseau du navigateur afficherait la veille.
    test('affiche sur la fiche affaire les factures émises liées et leur PDF', async ({ allerSurPageAdmin, apiAdmin, creerClient, request, session }) => {
      const apiResponse = await apiAdmin.get('/company');
      expect(apiResponse.ok(), await apiResponse.text()).toBeTruthy();
      const api = new URL('/api', apiResponse.url()).toString().replace(/\/$/, '');
      const client = await creerClient('factures-liees');
      const headers = { Authorization: `Bearer ${session.token}` };
      const devis = await request.post(`${api}/devis`, {
        headers,
        data: { clientId: client.id, objet: `Affaire E2E facturée ${Date.now()}`, lignes: [{ designation: 'Pose facturée', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
      });
      expect(devis.ok(), await devis.text()).toBeTruthy();
      const { id: devisId } = await devis.json() as { id: string };
      const envoi = await request.put(`${api}/devis/${devisId}/statut`, { headers, data: { statut: 'ENVOYE' } });
      expect(envoi.ok(), await envoi.text()).toBeTruthy();
      const signature = await request.post(`${api}/devis/${devisId}/signature`, { headers, data: { signataire: 'Signataire E2E', confirme: true } });
      expect(signature.ok(), await signature.text()).toBeTruthy();
      const conversion = await request.post(`${api}/devis/${devisId}/convertir`, { headers, data: { cible: 'CHANTIER' } });
      expect(conversion.ok(), await conversion.text()).toBeTruthy();
      const { id: chantierId } = await conversion.json() as { id: string };
      const brouillon = await request.post(`${api}/factures`, {
        headers,
        data: { clientId: client.id, origine: 'CHANTIER', chantierId, dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Pose facturée', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] },
      });
      expect(brouillon.ok(), await brouillon.text()).toBeTruthy();
      const { id: factureId } = await brouillon.json() as { id: string };
      const emission = await request.post(`${api}/factures/${factureId}/emettre`, { headers });
      expect(emission.ok(), await emission.text()).toBeTruthy();
      const { numero } = await emission.json() as { numero: string };

      const page = await allerSurPageAdmin(`/chantiers/${chantierId}`);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Pacific/Gambier');
      const liste = page.getByRole('region', { name: 'Factures liées' });
      await expect(liste).toBeVisible();
      const ligne = liste.locator('tr', { hasText: numero });
      // L'administrateur reçoit la colonne PDF ; son en-tête fait partie du contrat de table.
      await expect(liste.locator('th')).toHaveCount(7);
      const cellules = ligne.locator('td');
      await expect(cellules.nth(0)).toHaveText(numero);
      await expect(cellules.nth(1)).toHaveText('Facture');
      await expect(cellules.nth(2)).toHaveText('EMISE');
      await expect(cellules.nth(3)).toHaveText(dateDuJour());
      await expect(cellules.nth(4)).toHaveText(/^100\s*€$/);
      await expect(cellules.nth(5)).toHaveText(/^120\s*€$/);
      await expect(ligne.getByRole('button', { name: 'PDF' })).toBeVisible();
      const pdf = await apiAdmin.get(`/factures/${factureId}/document.pdf`);
      expect(pdf.status(), await pdf.text()).toBe(200);
      expect(pdf.headers()['content-type']).toContain('application/pdf');
    });

    test('émet la facture au jour proposé et conserve ce jour dans la ligne', async ({ allerSurPageAdmin, creerClient, page }) => {
      const client = await creerClient('fuseau-gambier');
      await allerSurPageAdmin('/factures');
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Pacific/Gambier');

      await page.getByRole('button', { name: /Nouvelle facture/ }).click();
      const dateEmission = page.locator('input[name="dateEmission"]');
      // Le champ n'est prérempli qu'une fois le fuseau de la société lu (#211) : il est actif alors.
      await expect(dateEmission).toBeEnabled();
      const jourPropose = await dateEmission.inputValue();
      expect(jourPropose).toMatch(/^\d{2}-\d{2}-\d{4}$/);
      await choisirClient(page, client);
      await page.locator('input[name="motifHorsAffaire"]').fill('Parcours fuseau Gambier');
      await page.locator('input[aria-label="Désignation ligne 1"]').fill('Contrôle de la date proposée');
      await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
      const rechargement = page.waitForResponse(response => response.url().includes('/api/factures?page=1&pageSize=25') && response.ok());
      await page.getByRole('button', { name: /Créer le brouillon/ }).click();
      await (await rechargement).finished();
      await expect(page.getByText(/Brouillon créé/)).toBeVisible();
      await expect(page.locator('tbody [role="status"]')).toHaveCount(0);

      const ligne = (await afficherFacture(page, client.raisonSociale)).filter({ hasText: 'Facture' });
      await expect(ligne).toContainText('BROUILLON');
      await ligne.getByRole('button', { name: /Émettre/ }).click();
      await expect(ligne).toContainText('EMISE');
      await expect(ligne).toContainText(jourPropose);
    });
  });

  test.describe('fuseau horaire entreprise', () => {
    test.use({ timezoneId: 'Pacific/Gambier' });

    test('préremplit Achats, Heures et Factures au jour de Pacific/Wallis, distinct du navigateur', async ({ allerSurPageAdmin, apiAdmin, page, request, session }) => {
      await page.clock.install({ time: new Date('2027-01-01T13:30:00Z') });
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Pacific/Gambier');
      expect(await page.evaluate(() => new Date().toISOString().startsWith('2027-01-01T13:30:00.'))).toBeTruthy();
      // Ce garde-fou rend le scénario discriminant : Gambier est encore le 01, Wallis est déjà le 02.
      expect(await page.evaluate(() => new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date()).map((partie) => partie.value).join(''))).toBe('2027-01-01');
      const reponseSociete = await apiAdmin.get('/company');
      expect(reponseSociete.ok(), await reponseSociete.text()).toBeTruthy();
      const societeInitiale = await reponseSociete.json() as { fuseauHoraire?: string | null };
      const api = new URL('/api', reponseSociete.url()).toString().replace(/\/$/, '');
      const mettreAJourFuseau = (fuseauHoraire: string) => request.put(`${api}/company`, {
        headers: { Authorization: `Bearer ${session.token}` },
        data: { fuseauHoraire },
      });

      try {
        const miseAJour = await mettreAJourFuseau('Pacific/Wallis');
        expect(miseAJour.ok(), await miseAJour.text()).toBeTruthy();
        expect((await miseAJour.json() as { fuseauHoraire: string }).fuseauHoraire).toBe('Pacific/Wallis');

        await allerSurPageAdmin('/achats');
        await expect(page.locator('input[name="date"]')).toHaveValue('02-01-2027');

        await allerSurPageAdmin('/heures');
        await expect(page.locator('input[name="date"]')).toHaveValue('02-01-2027');

        await allerSurPageAdmin('/factures');
        await page.getByRole('button', { name: /Nouvelle facture/ }).click();
        await expect(page.locator('input[name="dateEmission"]')).toHaveValue('02-01-2027');
        await expect(page.locator('input[name="dateEcheance"]')).toHaveValue('02-01-2027');
      } finally {
        const restauration = await mettreAJourFuseau(societeInitiale.fuseauHoraire || 'Europe/Paris');
        expect(restauration.ok(), await restauration.text()).toBeTruthy();
      }
    });
  });
});

// Si les paramètres de la société ne se chargent pas, les dates restent vides et désactivées :
// la création est refusée avec un message, sans envoi, plutôt que par une « date invalide ».
test('sans le fuseau de la société, une facture n’est pas créée sans ses dates', async ({ creerClient, page, session }) => {
  const client = await creerClient('Client fuseau indisponible');
  await page.route('**/api/company', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ status: 500, json: { error: 'Paramètres indisponibles.' } })
    : route.continue()));
  let envois = 0;
  page.on('request', (requete) => {
    if (requete.method() === 'POST' && new URL(requete.url()).pathname === '/api/factures') envois += 1;
  });
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [session.token, JSON.stringify(session.user)]);
  await page.goto('/factures', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Paramètres indisponibles.')).toBeVisible();
  await page.getByRole('button', { name: /Nouvelle facture/ }).click();
  const emission = page.locator('input[name="dateEmission"]');
  await expect(emission).toBeDisabled();
  await expect(emission).toHaveAttribute('placeholder', 'Actualisez la liste');
  await choisirClient(page, client);
  await page.getByPlaceholder('Motif obligatoire').fill('Test du fuseau indisponible');
  await page.getByLabel('Désignation ligne 1').fill('Prestation');
  await page.getByLabel('Prix unitaire HT ligne 1').fill('100');
  await page.getByRole('button', { name: /Créer le brouillon/ }).click();
  await expect(page.getByText(/Les paramètres de la société ne sont pas chargés/)).toBeVisible();
  expect(envois).toBe(0);
});
