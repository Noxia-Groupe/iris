import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Intervention de suivi liée, seconde PR (décisions de Nelson du 24-10-2026, points 13 et 23, et de la nuit
// du 26 au 27-10-2026, points 1 et 2) : les coûts des suites d'une affaire comptent dans le réel du
// chantier ; une intervention issue d'un devis, sans chantier, montre à l'administration sa marge, suites
// comprises ; la suite d'une intervention hors contrat rappelle d'informer le client.

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable agit au nom du
// technicien pour saisir ses heures.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

const RAPPEL = 'Intervention hors contrat : cette suite n’était pas prévue au départ et peut coûter au client. Prévenez-le qu’elle sera facturée ou non.';

async function preparer(request: APIRequestContext, token: string, creerClient: (libelle: string) => Promise<{ id: string }>, libelle: string) {
  const envoyer = async (methode: 'post' | 'put' | 'patch', path: string, data?: object, auth = token) => {
    const response = await request[methode](`${api}${path}`, { headers: { Authorization: `Bearer ${auth}` }, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const technicien = await envoyer('post', '/users', { email: `${libelle}.${suffixe}@iris.test`, name: `Technicien ${libelle} ${suffixe}`, role: 'TECHNICIEN' }) as { id: string };
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche ${libelle} ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 }) as { id: string };
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const client = await creerClient(`${libelle} ${suffixe}`);
  const jour = dateDuJour();
  const jourIso = jour.split('-').reverse().join('-');
  // Placée avec le technicien, qui y déclare `heures` heures (40 € de l'heure, taux de sa fiche).
  const heuresDuTechnicien = async (interventionId: string, heures: number) => {
    await envoyer('put', `/interventions/${interventionId}/planning`, { dateDebut: jourIso, creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30', intervenantIds: [fiche.id] });
    await envoyer('post', `/interventions/${interventionId}/couts/heures`, { date: jour, nbrHeures: heures }, jetonPour(technicien.id));
  };
  const devisSigne = async (objet: string) => {
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `${objet} ${suffixe}`, lignes: [
      { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 150, tauxTva: 20 },
      { designation: 'Fourniture', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
    ] }) as { id: string; numero: string };
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    return devis;
  };
  return { envoyer, client, suffixe, heuresDuTechnicien, devisSigne };
}

test('intervention issue d’un devis : l’administration voit sa marge, suites comprises ; la suite d’une curative rappelle d’informer le client', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, heuresDuTechnicien, devisSigne } = await preparer(request, session.token, creerClient, 'marge-devis');
  const devis = await devisSigne('Dépannage chiffré');
  const intervention = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'INTERVENTION' }) as { id: string; reference: string; titre: string };
  await heuresDuTechnicien(intervention.id, 1.5);

  const page = await allerSurPageAdmin(`/interventions/${intervention.id}`);
  const carte = page.locator('article', { hasText: intervention.titre });
  const marge = carte.locator('[data-marge-devis]');
  // Total HT du devis 400 €, moins 1,5 h à 40 € : 340 €.
  await expect(marge).toContainText(new RegExp(`Marge sur le devis ${devis.numero} : 340,00\\s€ HT`));
  await expect(marge).toContainText('aucune suite pour l’instant');

  // À l'ouverture de la suite d'une curative, le dialogue rappelle d'informer le client.
  await carte.getByRole('button', { name: 'Créer la suite' }).click();
  const dialogue = page.getByRole('dialog', { name: `Créer la suite de ${intervention.reference}` });
  await expect(dialogue.getByRole('note')).toHaveText(RAPPEL);
  const creation = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interventions/${intervention.id}/suites`));
  await dialogue.getByRole('button', { name: 'Créer la suite' }).click();
  const suite = await (await creation).json() as { id: string; reference: string };
  await expect(dialogue).toHaveCount(0);
  await expect(marge).toContainText(/et de sa suite \(0,00\s€ HT\)/);

  // Les heures de la suite pèsent sur la marge de l'intervention initiale.
  await heuresDuTechnicien(suite.id, 0.5);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(marge).toContainText(/Marge sur le devis .* : 320,00\s€ HT/);
  await expect(marge).toContainText(/et de sa suite \(20,00\s€ HT\)/);

  // La fiche de la suite porte le même rappel, sans marge propre.
  await page.goto(`/interventions/${suite.id}`, { waitUntil: 'networkidle' });
  const carteSuite = page.locator('article', { hasText: suite.reference });
  await expect(carteSuite.getByRole('note')).toHaveText(RAPPEL);
  await expect(carteSuite.locator('[data-marge-devis]')).toHaveCount(0);
});

test('la suite d’une visite de contrat ne porte pas le rappel du hors contrat', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, client, suffixe } = await preparer(request, session.token, creerClient, 'marge-visite');
  const contrat = await envoyer('post', '/contrats-maintenance', { clientId: client.id, titre: `Contrat suite ${suffixe}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2099' }) as { id: string };
  const visite = await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`) as { id: string; reference: string; titre: string };
  const page = await allerSurPageAdmin(`/interventions/${visite.id}`);
  const carte = page.locator('article', { hasText: visite.titre });
  await carte.getByRole('button', { name: 'Créer la suite' }).click();
  const dialogue = page.getByRole('dialog', { name: `Créer la suite de ${visite.reference}` });
  await expect(dialogue.getByRole('heading', { name: `Créer la suite de ${visite.reference}` })).toBeVisible();
  await expect(dialogue.getByRole('note')).toHaveCount(0);
  await dialogue.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialogue).toHaveCount(0);
});

test('fiche chantier : les coûts des suites de l’affaire sont comptés dans le réel, et l’écran le dit', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, client, heuresDuTechnicien, devisSigne } = await preparer(request, session.token, creerClient, 'marge-chantier');
  const devis = await devisSigne('Affaire avec suites');
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  const initiale = await envoyer('post', '/interventions', { clientId: client.id, titre: 'Dépannage de l’affaire', chantierId: chantier.id }) as { id: string };
  const suite = await envoyer('post', `/interventions/${initiale.id}/suites`, {}) as { id: string };
  await heuresDuTechnicien(initiale.id, 3); // l'intervention initiale reste hors du réel du chantier
  await heuresDuTechnicien(suite.id, 2);

  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await expect(page.locator('[data-couts-suites]')).toHaveText(/Dont suites SAV de l’affaire, comptées dans le réel : 2 h · matériel 0,00\s€ · main-d’œuvre 80,00\s€\./);
  // Le réel du chantier comprend les 2 h de la suite, et elles seules.
  await expect(page.getByText('2.00 h', { exact: true })).toBeVisible();
});

// Audit interne 1 de #339 : l'écran suit l'API pour le conducteur, et le rappel ouvert depuis la file du
// planning ne vaut que pour une intervention sans contrat.
test('fiche chantier vue du conducteur : la part des suites, sans coût de main-d’œuvre', async ({ session, request, creerClient, browser }) => {
  const { envoyer, client, suffixe, heuresDuTechnicien, devisSigne } = await preparer(request, session.token, creerClient, 'marge-conducteur');
  const conducteur = await envoyer('post', '/users', { email: `marge-conducteur.cond.${suffixe}@iris.test`, name: `Conducteur ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as { id: string; name: string; email: string; role: string };
  const devis = await devisSigne('Affaire du conducteur');
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: conducteur.id });
  const initiale = await envoyer('post', '/interventions', { clientId: client.id, titre: 'Dépannage du conducteur', chantierId: chantier.id }) as { id: string };
  const suite = await envoyer('post', `/interventions/${initiale.id}/suites`, {}) as { id: string };
  await heuresDuTechnicien(suite.id, 2);

  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(conducteur.id), JSON.stringify({ ...conducteur, permissions: ['chantiers:read', 'clients:read'] })]);
  await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
  // Le serveur ne lui envoie pas le coût de main-d'œuvre : l'écran ne l'affiche pas, même à zéro.
  await expect(page.locator('[data-couts-suites]')).toHaveText(/Dont suites SAV de l’affaire, comptées dans le réel : 2 h · matériel 0,00\s€\.$/);
  await contexte.close();
});

test('file du planning : « Créer la suite » d’une visite à suivre sans rappel, d’une curative à suivre avec rappel', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, client, suffixe, heuresDuTechnicien } = await preparer(request, session.token, creerClient, 'marge-file');
  // Placée avec le technicien, en cours, terminée avec un compte rendu, puis marquée « à suivre ».
  const terminerASuivre = async (id: string) => {
    await heuresDuTechnicien(id, 0.5);
    await envoyer('patch', `/interventions/${id}/statut`, { statut: 'EN_COURS' });
    await envoyer('post', `/interventions/${id}/rapports`, { contenu: 'Retour nécessaire.', cleEnvoi: randomUUID() });
    await envoyer('patch', `/interventions/${id}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
    await envoyer('put', `/interventions/${id}/a-suivre`, { aSuivre: true });
  };
  const contrat = await envoyer('post', '/contrats-maintenance', { clientId: client.id, titre: `Contrat file ${suffixe}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: dateDuJour() }) as { id: string };
  const visite = await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`) as { id: string; reference: string };
  await terminerASuivre(visite.id);
  const curative = await envoyer('post', '/interventions', { clientId: client.id, titre: `Curative file ${suffixe}` }) as { id: string; reference: string };
  await terminerASuivre(curative.id);

  const page = await allerSurPageAdmin('/planning');
  const file = page.getByRole('region', { name: 'Interventions à planifier' });
  for (const [intervention, rappels] of [[visite, 0], [curative, 1]] as const) {
    await file.getByRole('row', { name: new RegExp(intervention.reference) }).getByRole('button', { name: 'Créer la suite' }).click();
    const dialogue = page.getByRole('dialog', { name: `Créer la suite de ${intervention.reference}` });
    await expect(dialogue.getByRole('heading', { name: `Créer la suite de ${intervention.reference}` })).toBeVisible();
    await expect(dialogue.getByRole('note')).toHaveCount(rappels);
    await dialogue.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialogue).toHaveCount(0);
  }
});

// Audit interne 2 de #339 : l'écran du technicien suit l'API (heures seules, aucun montant), et le rappel
// est annoncé à l'ouverture du dialogue sans figurer sur la fiche de l'intervention initiale.
test('fiche chantier vue du technicien titulaire : la part des suites en heures seules, sans montant', async ({ session, request, creerClient, browser }) => {
  const { envoyer, client, suffixe, heuresDuTechnicien, devisSigne } = await preparer(request, session.token, creerClient, 'marge-technicien');
  const titulaire = await envoyer('post', '/users', { email: `marge-technicien.tit.${suffixe}@iris.test`, name: `Titulaire ${suffixe}`, role: 'TECHNICIEN' }) as { id: string; name: string; email: string; role: string };
  const devis = await devisSigne('Affaire du technicien');
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: titulaire.id });
  const initiale = await envoyer('post', '/interventions', { clientId: client.id, titre: 'Dépannage du technicien', chantierId: chantier.id }) as { id: string };
  const suite = await envoyer('post', `/interventions/${initiale.id}/suites`, {}) as { id: string };
  await heuresDuTechnicien(suite.id, 2);
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(titulaire.id), JSON.stringify({ ...titulaire, permissions: ['chantiers:read'] })]);
  await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
  // Le serveur ne lui envoie ni matériel ni main-d'œuvre : l'écran ne dit que les heures, sans « 0,00 € ».
  await expect(page.locator('[data-couts-suites]')).toHaveText(/Dont suites SAV de l’affaire, comptées dans le réel : 2 h\.$/);
  await contexte.close();
});

test('rappel annoncé par le dialogue et absent de la fiche de l’intervention initiale', async ({ session, request, creerClient, allerSurPageAdmin }) => {
  const { envoyer, client, suffixe } = await preparer(request, session.token, creerClient, 'marge-annonce');
  const curative = await envoyer('post', '/interventions', { clientId: client.id, titre: `Curative annoncée ${suffixe}` }) as { id: string; reference: string; titre: string };
  const page = await allerSurPageAdmin(`/interventions/${curative.id}`);
  const carte = page.locator('article', { hasText: curative.titre });
  await expect(carte.getByRole('button', { name: 'Créer la suite' })).toBeVisible();
  // Lecture du moment (section 4) : pas de rappel sur la fiche de l'intervention initiale.
  await expect(carte.getByRole('note')).toHaveCount(0);
  await carte.getByRole('button', { name: 'Créer la suite' }).click();
  const dialogue = page.getByRole('dialog', { name: `Créer la suite de ${curative.reference}` });
  const note = dialogue.getByRole('note');
  await expect(note).toHaveText(RAPPEL);
  // Annoncé à l'ouverture : le rappel est cité par l'aria-describedby du dialogue.
  const noteId = await note.getAttribute('id');
  expect(noteId).toBeTruthy();
  expect((await dialogue.getAttribute('aria-describedby'))?.split(' ')).toContain(noteId);
  await dialogue.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialogue).toHaveCount(0);
});
