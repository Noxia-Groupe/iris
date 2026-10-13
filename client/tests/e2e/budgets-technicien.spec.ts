import { createHmac } from 'node:crypto';
import type { Browser } from '@playwright/test';
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

async function pageDe(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: [] })]);
  return page;
}

// Décisions de Nelson (13-10-2026) : le technicien consulte l'affaire dont il est chargé avec ses
// heures, sans aucun montant (budgets, coûts, taux) ni alerte de dépassement, et sans pouvoir la
// modifier ni la clôturer. Son responsable hiérarchique (N+1) la clôture.
test('un technicien consulte son chantier sans montant ni alerte de dépassement, et son N+1 le clôture', async ({ creerClient, request, session, browser }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const creerCompte = async (cle: string, nom: string, role: string): Promise<Compte> =>
    envoyer('post', '/users', { email: `budgets.${cle}.${suffixe}@iris.test`, name: `${nom} ${suffixe}`, role });
  const technicien = await creerCompte('technicien', 'Technicien budgets', 'TECHNICIEN');
  const responsable = await creerCompte('responsable', 'Responsable du technicien', 'RESPONSABLE');
  await envoyer('patch', `/users/${technicien.id}/responsable-hierarchique`, { responsableHierarchiqueId: responsable.id });

  // 100 € de fourniture et 2 h de pose à 50 € ; 250 € d'achats et 3 h pointées : matériel et
  // heures dépassés.
  const client = await creerClient('budgets-technicien', false);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Budgets technicien E2E ${suffixe}`, lignes: [
    { designation: 'Caméra', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20 },
  ] });
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  const contextes: { close: () => Promise<void> }[] = [];
  try {
    await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: technicien.id });
    const categorie = await envoyer('post', '/categories', { nom: `Budgets technicien E2E ${suffixe} catégorie` });
    const fournisseur = await envoyer('post', '/fournisseurs', { nom: `Budgets technicien E2E ${suffixe} fournisseur` });
    await envoyer('post', '/achats', { chantierId: chantier.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: dateDuJour(), description: 'Matériel complémentaire', montantHT: 250 });
    const intervenant = await envoyer('post', '/intervenants', { nom: `Budgets technicien E2E ${suffixe} intervenant`, role: 'TECHNICIEN', tauxHoraireCharge: 47 });
    await envoyer('post', '/heures', { chantierId: chantier.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 3 });

    const vueTechnicien = await pageDe(browser, technicien);
    contextes.push(vueTechnicien.context());

    // Liste : ni colonne Matériel, ni pastille de dépassement, ni bouton Clôturer ; les heures restent.
    await vueTechnicien.goto('/chantiers', { waitUntil: 'networkidle' });
    const ligne = vueTechnicien.locator(`tr[data-chantier="${chantier.id}"]`);
    await expect(ligne).toContainText('3 h');
    await expect(ligne).toContainText('/ 2 h');
    await expect(ligne).not.toContainText('€');
    await expect(vueTechnicien.getByRole('columnheader', { name: 'Matériel' })).toHaveCount(0);
    await expect(ligne.locator('[data-alerte]')).toHaveCount(0);
    await expect(ligne.getByRole('button', { name: 'Clôturer' })).toHaveCount(0);

    // Fiche : avertissement de consultation seule ; aucune section de montant, aucun euro.
    await vueTechnicien.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(vueTechnicien.locator('[data-consultation-seule]')).toContainText('n’est pas autorisé à modifier une affaire');
    await expect(vueTechnicien.getByText('/ 2 h')).toBeVisible();
    const SECTIONS_DE_MONTANTS = ['Matériel Prévu', 'Coût MO Prévu', 'Consommation Matériel', 'Coût Main d\'Œuvre', 'Achats par catégorie', 'Achats du chantier'];
    for (const section of SECTIONS_DE_MONTANTS) {
      await expect(vueTechnicien.getByText(section, { exact: true })).toHaveCount(0);
    }
    await expect(vueTechnicien.locator('[data-alertes-fiche] [data-alerte]')).toHaveCount(0);
    await expect(vueTechnicien.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);
    await expect(vueTechnicien.locator('main')).not.toContainText('€');

    // Le N+1 voit le bouton Clôturer sur l'affaire de son technicien et la clôture.
    const vueResponsable = await pageDe(browser, responsable);
    contextes.push(vueResponsable.context());
    // Témoin : les mêmes sections existent bien pour le N+1, qui voit les montants.
    await vueResponsable.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    for (const section of SECTIONS_DE_MONTANTS) {
      await expect(vueResponsable.getByText(section, { exact: true }).first()).toBeVisible();
    }
    await expect(vueResponsable.locator('[data-consultation-seule]')).toHaveCount(0);
    await vueResponsable.goto('/chantiers', { waitUntil: 'networkidle' });
    const ligneResponsable = vueResponsable.locator(`tr[data-chantier="${chantier.id}"]`);
    await expect(ligneResponsable.locator('[data-alerte="MATERIEL_DEPASSE"]')).toHaveText(/Matériel \+150\s?€/);
    vueResponsable.once('dialog', (dialog) => void dialog.accept());
    const cloture = vueResponsable.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantier.id}/statut`) && r.request().method() === 'PATCH');
    await ligneResponsable.getByRole('button', { name: 'Clôturer' }).click();
    expect((await cloture).status()).toBe(200);
    const relu = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { statut: string; budgetMaterielVendu: number };
    expect([relu.statut, relu.budgetMaterielVendu]).toEqual(['TERMINE', 100]);
  } finally {
    // Chantier clôturé : la base partagée reste lisible pour la suite.
    await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers, data: { statut: 'TERMINE' } }).catch(() => undefined);
    for (const contexte of contextes) await contexte.close().catch(() => undefined);
  }
});
