import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, jetonPour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot A5, #205 : un seul module de formats. Preuve de la locale (C4 du contrôle du cadrage) : les parcours tournent en
// `fr-FR` (playwright.config.ts), où un `toLocaleString()` sans locale écrit déjà le format français. Ce fichier ouvre
// donc un navigateur en anglais (en-US) sur chaque écran dont les montants s'écrivaient sans locale avant #205 : tableau
// de bord, Résultat commercial, Mes commerciaux, Marges & Commissions (éditeur de barème), Performances et Statistiques.
// Chacun doit écrire « 1 235 € » au format français (milliers en espace fine insécable U+202F, espace ordinaire avant
// « € »), et non « 1,235 € », que la tête de A4 (e39f005) affiche dans ce navigateur.
// Les montants sont injectés dans les réponses du serveur (comme commissions-sans-plan.spec.ts) : seul leur affichage
// est en cause, et non leur calcul. Ils sont choisis pour que d'autres lectures donnent un autre texte : 1 234,5 €
// donne « 1 235 € » (moitié vers l'extérieur, #198) ; -2 345,5 € donne « -2 346 € » (Math.round donnerait -2 345).
test.use({ locale: 'en-US' });

const FINE = ' ';

// `toHaveText` avec une chaîne ramène toute espace (U+202F, U+00A0 comprises) à l'espace ordinaire : une expression
// ancrée compare le texte exact, caractère par caractère.
const exactement = (texte: string) => new RegExp(`^${texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

// Témoin : la page est bien servie en anglais ; un `toLocaleString()` sans locale y écrirait « 1,235 ».
async function navigateurEnAnglais(page: Page) {
  expect(await page.evaluate(() => [navigator.language, (1235).toLocaleString(), (1235).toLocaleString('fr-FR')])).toEqual(['en-US', '1,235', `1${FINE}235`]);
}

async function remplacerReponse(page: Page, motif: string, modifier: (donnees: any) => unknown) {
  await page.route(motif, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const reponse = await route.fetch();
    await route.fulfill({ response: reponse, json: modifier(await reponse.json()) });
  });
}

test('tableau de bord, navigateur en anglais : achats, heures, CA, marge et commission au format français', async ({ page, allerSurPageAdmin }) => {
  await remplacerReponse(page, '**/api/stats/global?*', (donnees) => ({
    ...donnees, achatsTotal: 1234.5, heuresTotal: 1234.4, caTotal: 12345.5, margeTotal: -2345.5, commissionCommercialeTotal: 1500.4, commissionTotal: 1500.4,
  }));
  await allerSurPageAdmin('/');
  await navigateurEnAnglais(page);
  const valeur = (libelle: string) => page.locator('div.bg-white.p-4', { hasText: libelle }).last().locator('div.text-2xl');
  await expect(valeur('Total des achats')).toHaveText(exactement(`1${FINE}235 €`));
  // Heures arrondies à l'heure, puis au format français (Dashboard.tsx:197 du cadrage).
  await expect(valeur('Heures enregistrées')).toHaveText(exactement(`1${FINE}234 h`));
  await expect(valeur('CA Vendu')).toHaveText(exactement(`12${FINE}346 €`));
  await expect(valeur('Marge totale')).toHaveText(exactement(`-2${FINE}346 €`));
  await expect(valeur('Commission commerciale')).toHaveText(exactement(`1${FINE}500 €`));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

async function creerCommercial(request: APIRequestContext, token: string) {
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const creation = await request.post(`${api}/users`, { headers: { Authorization: `Bearer ${token}` }, data: { email: `test.format.${suffixe}@iris.test`, name: `TEST Commercial format ${suffixe}`, role: 'COMMERCIAL' } });
  expect(creation.ok(), await creation.text()).toBeTruthy();
  return creation.json() as Promise<{ id: string; name: string; email: string }>;
}

const chantierCommercial = (suffixe: string) => ({
  id: `e2e-format-${suffixe}`, nom: `TEST Chantier format ${suffixe}`, client: 'TEST Client format', dateDebut: new Date().toISOString(),
  statut: 'TERMINE', encaisse: true, valide: true, baremeReduit: false, comptabiliseDansPeriode: true,
  // 1 234,5 € : « 1 235 € » ; 999,5 € : « 1 000 € », le millier atteint par l'arrondi.
  budgetGlobalVendu: 1234.5, margeCommerciale: 999.5, commissionEstimee: 0,
});

test('Résultat commercial, navigateur en anglais : CA, marge, rémunération et chantiers au format français', async ({ page, request, session }) => {
  const commercial = await creerCommercial(request, session.token);
  const chantier = chantierCommercial(commercial.id);
  await remplacerReponse(page, '**/api/stats/commerciaux?*', (donnees) => ({
    ...donnees,
    commerciaux: (donnees.commerciaux ?? []).map((c: { id: string }) => (c.id === commercial.id
      ? { ...c, caTotal: 12345.5, margeTotal: -2345.5, commissionTotal: 1234.5, nbChantiers: 1, chantiers: [chantier] }
      : c)),
  }));
  await page.addInitScript(([jeton, utilisateur]) => {
    localStorage.setItem('token', jeton as string);
    localStorage.setItem('user', utilisateur as string);
  }, [jetonPour(commercial.id), JSON.stringify({ ...commercial, role: 'COMMERCIAL', permissions: [] })]);
  await page.goto('/resultat-commercial', { waitUntil: 'networkidle' });
  await navigateurEnAnglais(page);
  const carte = (libelle: string) => page.locator('div.bg-gray-50.rounded-xl', { hasText: libelle }).locator('div.text-2xl');
  await expect(carte('CA vendu (validé, période)')).toHaveText(exactement(`12${FINE}346 €`));
  await expect(carte('Marge commerciale (validée, période)')).toHaveText(exactement(`-2${FINE}346 €`));
  await expect(carte('Rémunération variable (période)')).toHaveText(exactement(`1${FINE}235 €`));
  const ligne = page.locator('tr', { hasText: chantier.nom });
  await expect(ligne.locator('td').nth(3)).toHaveText(exactement(`1${FINE}235 €`));
  await expect(ligne.locator('td').nth(4)).toHaveText(exactement(`1${FINE}000 €`));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('Mes commerciaux, navigateur en anglais : CA, marge, rémunération et marge par chantier au format français', async ({ page, allerSurPageAdmin }) => {
  const nom = `TEST Commercial format ${Date.now()}`;
  const chantier = chantierCommercial(String(Date.now()));
  await remplacerReponse(page, '**/api/stats/commerciaux?*', (donnees) => ({
    ...donnees,
    commerciaux: [{
      id: 'e2e-format-commercial', name: nom, email: 'test.format.commercial@iris.test', nbChantiers: 1, sansPlanCommercial: true,
      caTotal: 12345.5, margeTotal: -2345.5, commissionTotal: 1234.5, chantiers: [chantier],
    }],
  }));
  await allerSurPageAdmin('/commerciaux');
  await navigateurEnAnglais(page);
  const carte = page.locator('div.bg-white.rounded-xl', { hasText: nom });
  const montant = (libelle: string) => carte.locator('div.text-right', { hasText: libelle }).locator('div.font-bold').last();
  await expect(montant('CA validé')).toHaveText(exactement(`12${FINE}346 €`));
  await expect(montant('Marge validée')).toHaveText(exactement(`-2${FINE}346 €`));
  await expect(montant('Rémunération variable')).toHaveText(exactement(`1${FINE}235 €`));
  await carte.getByText(nom, { exact: true }).click();
  await expect(carte.locator('tr', { hasText: chantier.nom }).locator('td').nth(2)).toHaveText(exactement(`1${FINE}000 €`));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('Marges & Commissions, navigateur en anglais : les tranches du barème partent de montants au format français', async ({ page, allerSurPageAdmin }) => {
  // Lecture seule : aucune règle n'est enregistrée, seule la réponse lue par l'écran porte ces tranches.
  await remplacerReponse(page, '**/api/parametres/remuneration', (donnees) => ({
    ...donnees, baremeStandard: [{ plafond: 1234.5, taux: 10 }, { plafond: 12345.5, taux: 15 }, { plafond: null, taux: 20 }],
  }));
  await allerSurPageAdmin('/admin');
  await page.getByRole('button', { name: 'Marges & Commissions', exact: true }).click();
  await navigateurEnAnglais(page);
  const bareme = page.locator('div.p-4.rounded.border', { hasText: 'Barème standard' });
  await expect(bareme.locator('span', { hasText: /^dès / })).toHaveText([exactement('dès 0 €'), exactement(`dès 1${FINE}235 €`), exactement(`dès 12${FINE}346 €`)]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('Performances, navigateur en anglais : CA, marge et manque à gagner au format français', async ({ page, allerSurPageAdmin }) => {
  const nom = `TEST Conducteur format ${Date.now()}`;
  await page.route('**/api/stats/conducteurs', (route) => route.fulfill({
    json: [{
      id: 'e2e-format-conducteur', name: nom, email: 'test.format.conducteur@iris.test', nbChantiersEnCours: 1, nbChantiersTermines: 1,
      caTotal: 12345.5, margeTotal: -2345.5, margePct: -19, nbEnAvanceHeures: 0, nbEnRetardHeures: 1, nbMaterielDansBudget: 1, nbMaterielDepasse: 0,
      nbTermineEnAvanceHeures: 0, nbTermineEnRetardHeures: 1, nbTermineMaterielDansBudget: 1, nbTermineMaterielDepasse: 0,
      tauxDepassementHeures: 12.5, manqueAGagnerMainOeuvre: 1234.5, tauxObjectifsRespectes: 0, nbObjectifsRespectes: 0,
    }],
  }));
  await allerSurPageAdmin('/performances');
  await navigateurEnAnglais(page);
  const carte = page.locator('div.bg-white.rounded-xl', { hasText: nom });
  await expect(carte.locator('div.bg-gray-50', { hasText: 'CA vendu' }).locator('div.mt-0\\.5')).toHaveText(exactement(`12${FINE}346 €`));
  await expect(carte.locator('div.bg-gray-50', { hasText: 'Marge générée' }).locator('div.mt-0\\.5')).toHaveText(exactement(`-2${FINE}346 €`));
  await expect(carte.locator('div.border-t', { hasText: 'Dépassement heures' }).locator('span.text-sm.font-black').last()).toHaveText(exactement(`-1${FINE}235 €`));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('Statistiques, navigateur en anglais : coût d’un intervenant et achats d’un fournisseur au format français', async ({ page, allerSurPageAdmin }) => {
  await remplacerReponse(page, '**/api/stats/intervenants?*', (donnees) => ({
    ...donnees, intervenants: [{ id: 'e2e-format-intervenant', nom: 'TEST Intervenant format', role: 'Technicien', heures: 12.5, cout: 1234.5 }],
  }));
  await remplacerReponse(page, '**/api/stats/fournisseurs?*', (donnees) => ({
    ...donnees, fournisseurs: [{ id: 'e2e-format-fournisseur', nom: 'TEST Fournisseur format', nbAchats: 2, total: 12345.5 }],
  }));
  await allerSurPageAdmin('/statistiques');
  await navigateurEnAnglais(page);
  await page.getByRole('button', { name: 'Intervenants' }).click();
  await expect(page.locator('[data-intervenant="e2e-format-intervenant"] div.text-right div.text-xs')).toHaveText(exactement(`1${FINE}235 €`));
  await page.getByRole('button', { name: 'Fournisseurs' }).click();
  const fournisseur = page.locator('div.flex.items-center.gap-4', { hasText: 'TEST Fournisseur format' });
  await expect(fournisseur.locator('div.text-right div.font-black')).toHaveText(exactement(`12${FINE}346 €`));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
