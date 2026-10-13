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

// Parcours de Nelson : la perte d'un chantier doit atteindre le conducteur, toute sa chaîne
// hiérarchique et la direction, et chaque société doit pouvoir retirer une catégorie.
test.describe('Rentabilité — chaîne hiérarchique et profil Directeur', () => {
  test('la perte d’un chantier remonte toute la chaîne et au directeur, selon les destinataires réglés', async ({ allerSurPageAdmin, creerClient, request, session, browser }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
      const response = await request[methode](`${api}${path}`, { headers, data });
      expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
      return response.json();
    };
    const suffixe = Date.now();
    const creerCompte = async (cle: string, nom: string, role: string): Promise<Compte> =>
      envoyer('post', '/users', { email: `chaine.${cle}.${suffixe}@iris.test`, name: `${nom} ${suffixe}`, role });
    const conducteur = await creerCompte('conducteur', 'Conducteur chaîne', 'CONDUCTEUR_TRAVAUX');
    const secteur = await creerCompte('secteur', 'Responsable secteur', 'RESPONSABLE');
    const regional = await creerCompte('regional', 'Responsable régional', 'RESPONSABLE');
    const directeur = await creerCompte('directeur', 'Directeur chaîne', 'DIRECTEUR');
    const avant = await (await request.get(`${api}/parametres`, { headers })).json() as Record<string, unknown>;

    // 100 € de fourniture et 2 h de pose à 50 € : 200 € vendus ; 250 € d'achats → perte de 50 €.
    const client = await creerClient('rentabilite-hierarchie', false);
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Chaîne E2E ${suffixe}`, lignes: [
      { designation: 'Caméra', nature: 'FOURNITURE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
      { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 50, tauxTva: 20 },
    ] });
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
    const contextes: { close: () => Promise<void> }[] = [];
    try {
      await envoyer('put', '/parametres', { margeCommercialeActive: true, rentabiliteConducteur: true, rentabiliteHierarchie: true, rentabiliteDirecteurs: true });
      await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: conducteur.id });
      const categorie = await envoyer('post', '/categories', { nom: `Chaîne E2E ${suffixe} catégorie` });
      const fournisseur = await envoyer('post', '/fournisseurs', { nom: `Chaîne E2E ${suffixe} fournisseur` });
      await envoyer('post', '/achats', { chantierId: chantier.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: dateDuJour(), description: 'Matériel complémentaire', montantHT: 250 });

      // Rattachements depuis Administration > Utilisateurs : conducteur → secteur → régional.
      const admin = await allerSurPageAdmin('/admin');
      await admin.getByRole('button', { name: 'Utilisateurs', exact: true }).click();
      for (const [compte, responsable] of [[conducteur, secteur], [secteur, regional]]) {
        const choix = admin.getByRole('combobox', { name: `Responsable hiérarchique de ${compte.name}` });
        const reponse = admin.waitForResponse((r) => r.url().endsWith(`/api/users/${compte.id}/responsable-hierarchique`));
        await choix.selectOption({ label: responsable.name });
        expect((await reponse).status()).toBe(200);
        await expect(choix).toHaveValue(responsable.id);
      }
      // Le régional ne peut pas relever de son propre conducteur : la boucle n'est même pas proposée.
      const choixRegional = admin.getByRole('combobox', { name: `Responsable hiérarchique de ${regional.name}` });
      await expect(choixRegional.locator('option', { hasText: secteur.name })).toHaveCount(0);
      await expect(choixRegional.locator('option', { hasText: conducteur.name })).toHaveCount(0);

      // Le responsable régional (N+2) voit la perte au tableau de bord et la marge dans sa liste.
      const vueRegional = await pageDe(browser, regional);
      contextes.push(vueRegional.context());
      await vueRegional.goto('/', { waitUntil: 'networkidle' });
      const ligne = vueRegional.getByRole('region', { name: 'Chantiers à surveiller' }).getByRole('button').filter({ hasText: chantier.nom });
      await expect(ligne.locator('[data-alerte="EN_PERTE"]')).toHaveText(/En perte 50\s?€/);
      await expect(vueRegional.getByRole('region', { name: 'Rentabilité des chantiers en cours' })).toBeVisible();
      await vueRegional.goto('/chantiers', { waitUntil: 'networkidle' });
      const ligneListe = vueRegional.locator(`tr[data-chantier="${chantier.id}"]`);
      await expect(ligneListe).toContainText(/[-−]50\s€/);
      await expect(ligneListe.locator('[data-marge-estimee]')).toContainText('Fin estimée');

      // Le directeur, hors de toute hiérarchie, voit la fiche et sa perte, sans écran opérationnel.
      const vueDirecteur = await pageDe(browser, directeur);
      contextes.push(vueDirecteur.context());
      await vueDirecteur.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
      await expect(vueDirecteur.locator('[data-alertes-fiche] [data-alerte="EN_PERTE"]')).toBeVisible();
      await expect(vueDirecteur.getByRole('button', { name: 'Modifier' })).toHaveCount(0);
      const menu = vueDirecteur.locator('#menu-principal');
      await expect(menu.getByRole('link', { name: 'Liste des chantiers' })).toBeVisible();
      await expect(menu.getByRole('link', { name: 'Administration' })).toHaveCount(0);
      await expect(menu.getByRole('link', { name: 'Planning' })).toHaveCount(0);
      await expect(menu.locator('.sidebar-compte-role')).toHaveText('Directeur');
      await vueDirecteur.goto('/admin', { waitUntil: 'networkidle' });
      await expect(vueDirecteur).toHaveURL(/\/$/);

      // La société retire la chaîne hiérarchique : le régional garde le chantier et son
      // dépassement, sans la marge ni l'alerte de perte.
      await admin.getByRole('button', { name: 'Marges & Commissions' }).click();
      const destinataires = admin.getByRole('group', { name: 'Qui suit la rentabilité des chantiers ?' });
      await destinataires.getByRole('checkbox', { name: 'Ses responsables hiérarchiques, à tous les niveaux' }).uncheck();
      admin.once('dialog', (dialog) => void dialog.accept());
      const enregistrement = admin.waitForResponse((r) => r.url().endsWith('/api/parametres') && r.request().method() === 'PUT');
      await admin.locator('form').filter({ has: destinataires }).getByRole('button', { name: 'Enregistrer' }).click();
      expect((await enregistrement).status()).toBe(200);
      const apres = await (await request.get(`${api}/parametres`, { headers })).json() as Record<string, unknown>;
      expect([apres.rentabiliteConducteur, apres.rentabiliteHierarchie, apres.rentabiliteDirecteurs]).toEqual([true, false, true]);

      await vueRegional.goto('/', { waitUntil: 'networkidle' });
      await expect(ligne.locator('[data-alerte="MATERIEL_DEPASSE"]')).toBeVisible();
      await expect(ligne.locator('[data-alerte="EN_PERTE"]')).toHaveCount(0);
      await expect(vueRegional.getByRole('region', { name: 'Rentabilité des chantiers en cours' })).toHaveCount(0);
      await vueRegional.goto('/chantiers', { waitUntil: 'networkidle' });
      await expect(ligneListe).toBeVisible();
      await expect(vueRegional.getByRole('columnheader', { name: 'Solde heures' }).first()).toBeVisible();
      await expect(ligneListe.locator('[data-marge-estimee]')).toHaveCount(0);
      // Le directeur, lui, la garde.
      await vueDirecteur.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
      await expect(vueDirecteur.locator('[data-alertes-fiche] [data-alerte="EN_PERTE"]')).toBeVisible();
    } finally {
      for (const contexte of contextes) await contexte.close();
      // Chantier clôturé et réglages d'origine : la base partagée reste lisible pour la suite.
      await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers, data: { statut: 'TERMINE' } });
      await request.put(`${api}/parametres`, { headers, data: {
        margeCommercialeActive: avant.margeCommercialeActive,
        rentabiliteConducteur: avant.rentabiliteConducteur ?? true,
        rentabiliteHierarchie: avant.rentabiliteHierarchie ?? true,
        rentabiliteDirecteurs: avant.rentabiliteDirecteurs ?? true,
      } });
    }
  });
});
