import { createHmac } from 'node:crypto';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable
// ouvre une session dans un rôle non administrateur.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Décision de Nelson (13-10-2026) : seul le technicien ne voit pas les budgets matériel et
// main-d'œuvre. Il garde le chantier, ses dépenses, ses heures vendues et les alertes de
// dépassement, sans le montant de ces budgets ni ce qui permettrait de le retrouver.
test('un technicien chargé d’un chantier en suit les dépassements sans en voir les budgets', async ({ creerClient, request, session, browser }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const technicien = await envoyer('post', '/users', { email: `budgets.technicien.${suffixe}@iris.test`, name: `Technicien budgets ${suffixe}`, role: 'TECHNICIEN' }) as { id: string; name: string; email: string; role: string };

  // 100 € de fourniture et 2 h de pose à 50 € : budgets de 100 € chacun ; 250 € d'achats.
  const client = await creerClient('budgets-technicien', false);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Budgets technicien E2E ${suffixe}`, lignes: [
    { designation: 'Caméra', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20 },
  ] });
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  const contexte = await browser.newContext();
  try {
    await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: technicien.id });
    const categorie = await envoyer('post', '/categories', { nom: `Budgets technicien E2E ${suffixe} catégorie` });
    const fournisseur = await envoyer('post', '/fournisseurs', { nom: `Budgets technicien E2E ${suffixe} fournisseur` });
    await envoyer('post', '/achats', { chantierId: chantier.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: dateDuJour(), description: 'Matériel complémentaire', montantHT: 250 });

    const page = await contexte.newPage();
    await page.addInitScript(([token, user]) => {
      localStorage.setItem('token', token as string);
      localStorage.setItem('user', user as string);
    }, [jetonPour(technicien.id), JSON.stringify({ ...technicien, permissions: [] })]);

    // Liste : la dépense matériel seule, sans « / budget » ni barre ; le dépassement signalé
    // sans son montant, qui redonnerait le budget à partir de la dépense.
    await page.goto('/chantiers', { waitUntil: 'networkidle' });
    const ligne = page.locator(`tr[data-chantier="${chantier.id}"]`);
    await expect(ligne).toContainText(/250\s€/);
    await expect(ligne).not.toContainText(/\/\s*100\s€/);
    await expect(ligne.locator('[data-alerte="MATERIEL_DEPASSE"]')).toHaveText('Matériel dépassé');

    // Fiche : ni « Matériel Prévu » ni « Coût MO Prévu », ni consommation en pourcentage du
    // budget ; les heures vendues et l'alerte restent.
    await page.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-alertes-fiche] [data-alerte="MATERIEL_DEPASSE"]')).toHaveText('Matériel dépassé');
    await expect(page.getByText('Matériel Prévu')).toHaveCount(0);
    await expect(page.getByText('Coût MO Prévu')).toHaveCount(0);
    await expect(page.getByText(/\/\s*100\s€/)).toHaveCount(0);
    await expect(page.getByText('250.0%')).toHaveCount(0);
    await expect(page.getByText('/ 2 h')).toBeVisible();

    // Témoin : l'administrateur voit toujours les budgets et le montant du dépassement.
    const vueAdmin = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { budgetMaterielVendu: number; budgetMainOeuvreVendu: number };
    expect([vueAdmin.budgetMaterielVendu, vueAdmin.budgetMainOeuvreVendu]).toEqual([100, 100]);
  } finally {
    // Chantier clôturé : la base partagée reste lisible pour la suite.
    await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers, data: { statut: 'TERMINE' } }).catch(() => undefined);
    await contexte.close().catch(() => undefined);
  }
});
