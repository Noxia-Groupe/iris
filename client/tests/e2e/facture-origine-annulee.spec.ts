import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, choisirClient, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Origine annulée : pas de facture (décision de Nelson de la nuit du 26 au 27-10-2026, point 14 : « Devis annulé : il
// faut refuser zn cas d’annulation car pas d’intervention ou contrat donc pas de facture » ; lectures retenues et refus
// à l'émission : choix par défaut, à confirmer). L'écran Factures ne propose plus le contrat annulé avec son devis, ni sa
// visite réalisée avant l'annulation, ni l'intervention rattachée à l'affaire annulée ; un brouillon créé avant
// l'annulation ne s'émet pas, et le refus du serveur s'affiche.
test('facture : contrat annulé avec son devis, sa visite réalisée et l’intervention de l’affaire annulée ne sont plus proposés ; le brouillon d’avant l’annulation ne s’émet pas', async ({ request, session, creerClient, allerSurPageAdmin }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const client = await creerClient(`origine annulée ${suffixe}`);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Affaire annulée ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const contrat = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CONTRAT', periodiciteMois: 6, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2026' }) as { id: string };
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  // Visite réalisée avant l'annulation : elle reste terminée.
  const visite = await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`) as { id: string };
  for (const statut of ['PLANIFIEE', 'EN_COURS']) await envoyer('patch', `/interventions/${visite.id}/statut`, { statut });
  await envoyer('post', `/interventions/${visite.id}/rapports`, { contenu: 'Visite faite.', cleEnvoi: randomUUID() });
  await envoyer('patch', `/interventions/${visite.id}/statut`, { statut: 'TERMINEE', motifSansSignature: 'CLIENT_ABSENT' });
  // Intervention rattachée à l'affaire : l'annulation du devis ne l'annule pas.
  const rattachee = await envoyer('post', '/interventions', { clientId: client.id, titre: `Rattachée à l’affaire ${suffixe}`, chantierId: chantier.id }) as { id: string };
  // Témoins : un contrat hors devis et une curative restent proposés.
  const temoin = await envoyer('post', '/contrats-maintenance', { clientId: client.id, titre: `Contrat témoin ${suffixe}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2026' }) as { id: string };
  const curative = await envoyer('post', '/interventions', { clientId: client.id, titre: `Curative témoin ${suffixe}` }) as { id: string };
  const jour = dateDuJour();
  const brouillon = await envoyer('post', '/factures', { clientId: client.id, origine: 'CONTRAT', contratMaintenanceId: contrat.id, dateEmission: jour, dateEcheance: jour, lignes: [{ designation: `Abonnement ${suffixe}`, quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('post', `/devis/${devis.id}/annulation`, { motif: 'Le client renonce' });

  const page = await allerSurPageAdmin('/factures');
  await page.getByRole('button', { name: /Nouvelle facture/ }).click();
  await choisirClient(page, client);
  const origine = page.locator('select[name="origine"]');
  await origine.selectOption('CONTRAT');
  const contrats = page.locator('select[name="contratMaintenanceId"]');
  await expect(contrats.locator(`option[value="${temoin.id}"]`)).toHaveCount(1);
  await expect(contrats.locator(`option[value="${contrat.id}"]`)).toHaveCount(0);
  await origine.selectOption('INTERVENTION');
  const interventions = page.getByRole('combobox', { name: 'Intervention facturée' });
  await expect(interventions.locator(`option[value="${curative.id}"]`)).toHaveCount(1);
  await expect(interventions.locator(`option[value="${visite.id}"]`)).toHaveCount(0);
  await expect(interventions.locator(`option[value="${rattachee.id}"]`)).toHaveCount(0);
  await origine.selectOption('CHANTIER');
  await expect(page.locator(`select[name="chantierId"] option[value="${chantier.id}"]`)).toHaveCount(0);

  // Le brouillon créé avant l'annulation : son émission est refusée, le refus s'affiche, il reste brouillon.
  const ligne = await ligneDeFacture(page, client.raisonSociale);
  await ligne.getByRole('button', { name: /Émettre/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Un contrat annulé ne peut pas être facturé.' })).toBeVisible();
  await expect(ligne).toContainText('BROUILLON');
  const lue = await request.get(`${api}/factures/${brouillon.id}/tracabilite`, { headers });
  expect((await lue.json() as { facture: { statut: string; numero: string | null } }).facture).toMatchObject({ statut: 'BROUILLON', numero: null });
});

// La ligne du brouillon dans la liste paginée : recherchée de page en page, depuis la première.
async function ligneDeFacture(page: Page, raisonSociale: string) {
  await expect(page.getByTestId('pagination-factures')).toContainText('document(s)');
  await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  const ligne = page.locator('tbody tr', { hasText: raisonSociale });
  const suivante = page.getByRole('button', { name: 'Page suivante' });
  while (!(await ligne.count()) && await suivante.isEnabled()) {
    await suivante.click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  await expect(ligne).toHaveCount(1);
  return ligne;
}
