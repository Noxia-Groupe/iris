import { randomUUID } from 'node:crypto';
import { test, expect, choisirClient } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

type Visite = { id: string; reference: string; titre: string; statut: string; contratMaintenanceId: string | null };

// Correctif R1 du passage hebdomadaire du contrôle de cohérence du 02-11-2026 (#444) : à la création d'une
// facture d'intervention, le sélecteur « Intervention facturée » désignait chaque intervention par son seul
// titre. Or toutes les visites d'un même contrat portent le même titre (« Maintenance préventive — <titre du
// contrat> »), et le rattachement choisi est figé à l'émission (règle 2 de la méthode : factures et documents
// figés). Une intervention se désigne désormais par « <référence> — <titre> », comme dans « Origine de la
// facture » du même écran ; sa liste, sa fiche, son compte rendu et la file du planning l'identifient aussi par
// sa référence. Les affaires et les contrats, sans référence, se désignent depuis #448 par « <nom> — <numéro de
// devis> » et par « <titre> — <site> — début le <JJ-MM-AAAA> » (homonymes : facture-designation-homonymes.spec.ts).
// Scénario de R1, préparé par l'API : un contrat trimestriel, sa première visite terminée avec un compte rendu,
// l'échéance avancée, puis la seconde visite générée. Aucun montant n'est en jeu : la ligne saisie n'est que
// celle qu'exige un brouillon. Le début du contrat est fixe et les références sont relues par l'API : rien ne
// dépend du jour, de l'heure ni du fuseau du passage (une visite créée le 31-12 et l'autre le 01-01 auraient
// deux préfixes d'année, toujours distincts).
test('facture d’intervention : deux visites d’un même contrat, de même titre, se distinguent par leur référence, et le brouillon se rattache à la visite choisie', async ({ request, session, creerClient, allerSurPageAdmin }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'get' | 'post' | 'patch', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${methode.toUpperCase()} ${path} : ${response.status()} ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const client = await creerClient(`reference-intervention ${suffixe}`);

  // Contrat trimestriel, début fixe : première échéance au 01-01-2026, seconde au 01-04-2026.
  const titreContrat = `Contrat R1 ${suffixe}`;
  const contrat = await envoyer('post', '/contrats-maintenance', { clientId: client.id, titre: titreContrat, periodiciteMois: 3, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2026' }) as { id: string; titre: string };
  const premiere = await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`) as Visite;
  for (const statut of ['PLANIFIEE', 'EN_COURS']) await envoyer('patch', `/interventions/${premiere.id}/statut`, { statut });
  await envoyer('post', `/interventions/${premiere.id}/rapports`, { contenu: 'Visite réalisée.', cleEnvoi: randomUUID() });
  await envoyer('patch', `/interventions/${premiere.id}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
  await envoyer('post', `/contrats-maintenance/${contrat.id}/avancer-echeance`);
  const seconde = await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`) as Visite;

  // Témoin des chantiers : une affaire du même client, ouverte par la conversion d'un devis signé (seule voie
  // de création d'un chantier).
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Affaire R1 ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string; numeroDevis: string };
  expect(chantier.nom).toBe(`Affaire R1 ${suffixe}`);

  // Préalable du constat R1, relu par l'API : deux visites du contrat, même titre, deux références distinctes.
  const visites = (await envoyer('get', '/interventions') as Visite[]).filter((intervention) => intervention.contratMaintenanceId === contrat.id);
  expect(visites.map((visite) => visite.id).sort()).toEqual([premiere.id, seconde.id].sort());
  expect(visites.find((visite) => visite.id === premiere.id)).toMatchObject({ reference: premiere.reference, titre: `Maintenance préventive — ${titreContrat}`, statut: 'TERMINEE' });
  expect(visites.find((visite) => visite.id === seconde.id)).toMatchObject({ reference: seconde.reference, titre: `Maintenance préventive — ${titreContrat}`, statut: 'A_PLANIFIER' });
  for (const visite of [premiere, seconde]) expect(visite.reference).toMatch(/^I\d{2}-\d{4,}$/);
  expect(seconde.reference).not.toBe(premiere.reference);

  const page = await allerSurPageAdmin('/factures');
  await page.getByRole('button', { name: /Nouvelle facture/ }).click();
  await choisirClient(page, client);
  const origine = page.locator('select[name="origine"]');

  // Une affaire se désigne par son nom et son numéro de devis ; un contrat sans site, par son titre et sa date de début.
  await origine.selectOption('CHANTIER');
  await expect(page.locator(`select[name="chantierId"] option[value="${chantier.id}"]`), 'l’affaire se désigne par son nom, puis son numéro de devis').toHaveText(`${chantier.nom} — ${chantier.numeroDevis}`);
  await origine.selectOption('CONTRAT');
  await expect(page.locator(`select[name="contratMaintenanceId"] option[value="${contrat.id}"]`), 'le contrat se désigne par son titre, puis sa date de début').toHaveText(`${titreContrat} — début le 01-01-2026`);

  // Les deux visites sont proposées, chacune sous sa référence suivie de son titre, et leurs libellés diffèrent.
  await origine.selectOption('INTERVENTION');
  const choix = page.getByRole('combobox', { name: 'Intervention facturée' });
  const options = choix.locator('option:not([value=""])');
  await expect(options, 'le client n’a que les deux visites du contrat à facturer').toHaveCount(2);
  for (const visite of [premiere, seconde]) {
    await expect(choix.locator(`option[value="${visite.id}"]`), `l’option de la visite ${visite.reference} porte sa référence, puis son titre`)
      .toHaveText(`${visite.reference} — Maintenance préventive — ${titreContrat}`);
  }
  const libelles = await options.allTextContents();
  expect(new Set(libelles).size, `deux visites du même contrat portent deux libellés distincts : ${JSON.stringify(libelles)}`).toBe(2);

  // Choisie par son libellé, comme le ferait l'utilisateur : la seconde visite, qui n'est pas la première
  // de la liste (triée par date souhaitée).
  await choix.selectOption({ label: `${seconde.reference} — ${seconde.titre}` });
  await expect(choix).toHaveValue(seconde.id);
  await page.getByRole('textbox', { name: 'Désignation ligne 1' }).fill('Visite préventive');
  await page.getByRole('textbox', { name: 'Prix unitaire HT ligne 1' }).fill('100');
  const creation = page.waitForResponse((response) => response.url().endsWith('/api/factures') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Créer le brouillon', exact: true }).click();
  const reponse = await creation;
  expect(reponse.status(), await reponse.text()).toBe(201);
  expect(reponse.request().postDataJSON()).toMatchObject({ clientId: client.id, origine: 'INTERVENTION', interventionId: seconde.id });
  const cree = await reponse.json() as { id: string };
  await expect(page.getByText(/Brouillon créé/)).toBeVisible();

  // Relu par l'API : un seul brouillon pour ce client, rattaché à la visite choisie, et à elle seule.
  const facturesDuClient = (await envoyer('get', '/factures') as { id: string; clientId: string }[]).filter((facture) => facture.clientId === client.id);
  expect(facturesDuClient).toHaveLength(1);
  expect(facturesDuClient[0]).toMatchObject({ id: cree.id, statut: 'BROUILLON', numero: null, origine: 'INTERVENTION', interventionId: seconde.id, chantierId: null, contratMaintenanceId: null });
  const trace = await envoyer('get', `/factures/${cree.id}/tracabilite`) as { facture: { intervention: { id: string; reference: string } | null } };
  expect(trace.facture.intervention).toMatchObject({ id: seconde.id, reference: seconde.reference });
});
