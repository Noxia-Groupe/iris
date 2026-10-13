import { test, expect, dateDuJour } from './fixtures';

// Parcours de suivi : une affaire qui dérive doit sauter aux yeux depuis le tableau de
// bord, et la liste doit permettre de la retrouver par recherche et par filtre, puis d'y
// revenir sans perdre ce filtre après un passage par la fiche.
test.describe('Suivi des chantiers — rentabilité et dérives', () => {
  test('signale une affaire en dérive au tableau de bord et la filtre dans la liste', async ({ allerSurPageAdmin, creerClient, request, session }) => {
    const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
    const headers = { Authorization: `Bearer ${session.token}` };
    const post = async (path: string, data: object) => {
      const response = await request.post(`${api}${path}`, { headers, data });
      expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
      return response.json();
    };
    const etiquette = `Suivi E2E ${Date.now()}`;
    const client = await creerClient('suivi-chantiers', false);
    // 100 € de fourniture et 2 h de pose. La dérive vend la pose 50 €/h (200 € au total) ;
    // l'affaire saine 500 €/h (1 100 €), pour que sa marge estimée reste au-dessus du seuil
    // quel que soit l'historique de la base partagée.
    const ouvrirAffaire = async (objet: string, prixPose: number) => {
      const devis = await post('/devis', { clientId: client.id, objet, lignes: [
        { designation: 'Caméra', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
        { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: prixPose, tauxTva: 20 },
      ] });
      const envoi = await request.put(`${api}/devis/${devis.id}/statut`, { headers, data: { statut: 'ENVOYE' } });
      expect(envoi.ok(), await envoi.text()).toBeTruthy();
      await post(`/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
      return post(`/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as Promise<{ id: string; nom: string }>;
    };
    const parametres = await (await request.get(`${api}/parametres`, { headers })).json() as { margeCommercialeActive: boolean };
    const derive = await ouvrirAffaire(`${etiquette} dérive`, 50);
    const sain = await ouvrirAffaire(`${etiquette} sain`, 500);
    try {
      expect((await request.put(`${api}/parametres`, { headers, data: { margeCommercialeActive: true } })).ok()).toBeTruthy();
      const categorie = await post('/categories', { nom: `${etiquette} catégorie` });
      const fournisseur = await post('/fournisseurs', { nom: `${etiquette} fournisseur` });
      const intervenant = await post('/intervenants', { nom: `${etiquette} technicien`, role: 'Technicien', tauxHoraireCharge: 50 });
      // Dérive : 250 € d'achats et 3 h à 50 € — 400 € dépensés pour 200 € vendus.
      await post('/achats', { chantierId: derive.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: dateDuJour(), description: 'Matériel complémentaire', montantHT: 250 });
      await post('/heures', { chantierId: derive.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 3 });
      await post('/heures', { chantierId: sain.id, intervenantId: intervenant.id, date: dateDuJour(), nbrHeures: 1 });

      const page = await allerSurPageAdmin('/');
      const aSurveiller = page.getByRole('region', { name: 'Chantiers à surveiller' });
      const ligneDerive = aSurveiller.getByRole('button').filter({ hasText: derive.nom });
      await expect(ligneDerive).toBeVisible();
      await expect(ligneDerive.locator('[data-alerte="EN_PERTE"]')).toHaveText(/En perte 200\s?€/);
      await expect(ligneDerive.locator('[data-alerte="HEURES_DEPASSEES"]')).toHaveText('Heures +1 h');
      await expect(ligneDerive.locator('[data-alerte="MAIN_OEUVRE_DEPASSEE"]')).toHaveText(/Main-d’œuvre \+50\s?€/);
      await expect(ligneDerive.locator('[data-alerte="MATERIEL_DEPASSE"]')).toHaveText(/Matériel \+150\s?€/);
      await expect(aSurveiller).not.toContainText(sain.nom);
      // Rentabilité du portefeuille en cours, réservée à qui voit la marge.
      await expect(page.getByRole('region', { name: 'Rentabilité des chantiers en cours' }).locator('[data-marge-portefeuille]')).toHaveText(/€/);

      // Le lien du bloc ouvre la liste déjà filtrée sur les affaires à surveiller.
      await aSurveiller.getByRole('link').click();
      await expect(page).toHaveURL(/\/chantiers\?filtre=A_SURVEILLER$/);
      await expect(page.getByRole('button', { name: 'À surveiller', exact: true })).toHaveAttribute('aria-pressed', 'true');

      await page.getByRole('searchbox', { name: 'Rechercher un chantier' }).fill(etiquette.toLowerCase());
      const enCours = page.locator('tbody').first();
      await expect(enCours.locator(`tr[data-chantier="${derive.id}"]`)).toBeVisible();
      await expect(enCours.locator(`tr[data-chantier="${sain.id}"]`)).toHaveCount(0);
      await expect(enCours.locator(`tr[data-chantier="${derive.id}"]`)).toContainText(/[-−]200\s€/);
      await expect(enCours.locator(`tr[data-chantier="${derive.id}"] [data-marge-estimee]`)).toContainText('Fin estimée');

      await page.getByRole('button', { name: 'Tous', exact: true }).click();
      await expect(enCours.locator('tr[data-chantier]')).toHaveCount(2);
      await page.getByRole('button', { name: 'En perte', exact: true }).click();
      await expect(enCours.locator('tr[data-chantier]')).toHaveCount(1);
      await expect(enCours.locator(`tr[data-chantier="${derive.id}"]`)).toBeVisible();

      // Passage par la fiche puis retour : recherche et filtre sont conservés.
      await enCours.locator(`tr[data-chantier="${derive.id}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/chantiers/${derive.id}$`));
      await expect(page.locator('[data-alertes-fiche] [data-alerte="EN_PERTE"]')).toBeVisible();
      await expect(page.locator('[data-estimation]')).toContainText('Main-d’œuvre attendue');
      await expect(page.locator('[data-derniere-saisie]')).toContainText('aujourd’hui');
      await page.goBack();
      await expect(page.getByRole('searchbox', { name: 'Rechercher un chantier' })).toHaveValue(etiquette.toLowerCase());
      await expect(page.getByRole('button', { name: 'En perte', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(enCours.locator('tr[data-chantier]')).toHaveCount(1);
    } finally {
      // Clôturer les deux affaires garde le tableau de bord de la base partagée lisible
      // pour les exécutions suivantes ; la marge retrouve son réglage d'origine.
      for (const chantier of [derive, sain]) {
        await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers, data: { statut: 'TERMINE' } });
      }
      await request.put(`${api}/parametres`, { headers, data: { margeCommercialeActive: parametres.margeCommercialeActive } });
    }
  });

  test('règle les alertes de suivi depuis Administration > Marges', async ({ allerSurPageAdmin, apiAdmin, request, session }) => {
    const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
    const headers = { Authorization: `Bearer ${session.token}` };
    const avant = await (await apiAdmin.get('/parametres')).json() as { margeCommercialeActive: boolean; seuilMargeFaible: number | null; joursSansSaisie: number | null };
    try {
      const page = await allerSurPageAdmin('/admin');
      await page.getByRole('button', { name: 'Marges & Commissions' }).click();
      const seuil = page.getByRole('spinbutton', { name: 'Seuil de marge faible en pourcentage' });
      const jours = page.getByRole('spinbutton', { name: 'Nombre de jours sans saisie' });
      await seuil.fill('12.5');
      await jours.fill('');
      page.once('dialog', (dialog) => void dialog.accept());
      const enregistrement = page.waitForResponse((r) => r.url().endsWith('/api/parametres') && r.request().method() === 'PUT');
      await page.locator('form').filter({ has: page.getByRole('group', { name: 'Alertes de suivi des chantiers' }) }).getByRole('button', { name: 'Enregistrer' }).click();
      expect((await enregistrement).status()).toBe(200);
      const apres = await (await apiAdmin.get('/parametres')).json() as { seuilMargeFaible: number | null; joursSansSaisie: number | null };
      expect(apres.seuilMargeFaible).toBe(12.5);
      expect(apres.joursSansSaisie).toBeNull();
    } finally {
      await request.put(`${api}/parametres`, { headers, data: { margeCommercialeActive: avant.margeCommercialeActive, seuilMargeFaible: avant.seuilMargeFaible ?? '', joursSansSaisie: avant.joursSansSaisie ?? '' } });
    }
  });
});
