import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Décision de Nelson (14-10-2026) : toutes les dates suivent le jour et l'heure de la société,
// où que se trouve celui qui consulte Iris. Chaque parcours place le navigateur dans un autre
// fuseau que la société, à un instant où leurs jours diffèrent.

async function avecFuseauSociete(request: APIRequestContext, token: string, fuseau: string, parcours: () => Promise<void>) {
  const headers = { Authorization: `Bearer ${token}` };
  const initial = await (await request.get(`${api}/company`, { headers })).json() as { fuseauHoraire?: string | null };
  const maj = await request.put(`${api}/company`, { headers, data: { fuseauHoraire: fuseau } });
  expect(maj.ok(), await maj.text()).toBeTruthy();
  try {
    await parcours();
  } finally {
    const restauration = await request.put(`${api}/company`, { headers, data: { fuseauHoraire: initial.fuseauHoraire || 'Europe/Paris' } });
    expect(restauration.ok(), await restauration.text()).toBeTruthy();
  }
}

test.describe('navigateur à Gambier, société à Paris', () => {
  test.use({ timezoneId: 'Pacific/Gambier' });

  // 31-10-2026 à 23:30 UTC : déjà le 1er novembre à Paris, encore le 31 octobre en UTC et à
  // Gambier. Le mois affiché par défaut est celui de la société.
  test('les statistiques ouvrent le mois de la société, pas celui d’UTC ni du navigateur', async ({ allerSurPageAdmin, page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-31T23:30:00Z') });
    await avecFuseauSociete(request, session.token, 'Europe/Paris', async () => {
      const reference = page.waitForRequest((r) => r.url().includes('/api/stats/types-chantiers'));
      await allerSurPageAdmin('/statistiques');
      await page.getByRole('button', { name: 'Types de chantiers' }).click();
      expect(new URL((await reference).url()).searchParams.get('ref')).toBe('2026-11-01');
      await expect(page.getByText('Novembre 2026', { exact: true })).toBeVisible();
      await page.getByTitle('Période précédente').click();
      await expect(page.getByText('Octobre 2026', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: "Aujourd'hui" }).click();
      await expect(page.getByText('Novembre 2026', { exact: true })).toBeVisible();
    });
  });
});

test.describe('navigateur à Gambier, société à Paris : fiche chantier', () => {
  test.use({ timezoneId: 'Pacific/Gambier' });

  // Un chantier converti avant ce lot commence à un instant : 14-10-2026 à 22:30 UTC, soit le
  // 15-10 à 00:30 à Paris. La fiche l'affiche et le préremplit au 15, et enregistrer la fiche
  // sans y toucher garde le 15 (avant, le jour UTC était réenregistré : le 14).
  test('la fiche lit un début horodaté au jour de la société, et l’enregistre sans le décaler', async ({ allerSurPageAdmin, creerClient, page, request, session }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
      const response = await request[methode](`${api}${path}`, { headers, data });
      expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
      return response.json();
    };
    const suffixe = Date.now();
    const conducteur = await envoyer('post', '/users', { email: `dates.conducteur.${suffixe}@iris.test`, name: `Conducteur dates ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as { id: string };
    const commercial = await envoyer('post', '/users', { email: `dates.commercial.${suffixe}@iris.test`, name: `Commercial dates ${suffixe}`, role: 'COMMERCIAL' }) as { id: string };
    const client = await creerClient('dates-fiche', false);
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Dates fiche E2E ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: conducteur.id, commercialId: commercial.id }) as { id: string };

    await page.route(`**/api/chantiers/${chantier.id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const reponse = await route.fetch();
      const corps = await reponse.json();
      await route.fulfill({ response: reponse, json: { ...corps, dateDebut: '2026-10-14T22:30:00.000Z' } });
    });
    await avecFuseauSociete(request, session.token, 'Europe/Paris', async () => {
      await allerSurPageAdmin(`/chantiers/${chantier.id}`);
      await expect(page.getByText(/Démarré le 15-10-2026/)).toBeVisible();
      await page.getByRole('button', { name: 'Modifier' }).first().click();
      await expect(page.locator('input[name="dateDebut"]')).toHaveValue('15-10-2026');
      const enregistrement = page.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantier.id}`) && r.request().method() === 'PATCH');
      await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
      expect((await enregistrement).status()).toBe(200);
      const relu = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { dateDebut: string };
      expect(relu.dateDebut).toBe('2026-10-15T00:00:00.000Z');
    });
  });
});

test.describe('navigateur à Cayenne, société à Wallis', () => {
  test.use({ timezoneId: 'America/Cayenne' });

  // Dimanche 18-10-2026 à 13:00 UTC : 10 h le dimanche à Cayenne, déjà lundi 19 à 1 h à Wallis.
  test('le planning ouvre la semaine et surligne le jour de la société', async ({ allerSurPageAdmin, page, request, session }) => {
    await page.clock.install({ time: new Date('2026-10-18T13:00:00Z') });
    const headers = { Authorization: `Bearer ${session.token}` };
    // La grille n'apparaît qu'avec au moins un intervenant.
    const intervenant = await request.post(`${api}/intervenants`, { headers, data: { nom: `Intervenant dates E2E ${Date.now()}`, role: 'Technicien', tauxHoraireCharge: 40 } });
    expect(intervenant.ok(), await intervenant.text()).toBeTruthy();
    const { id } = await intervenant.json() as { id: string };
    try {
      await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
        await allerSurPageAdmin('/planning');
        await expect(page.getByRole('button', { name: 'Semaine 43' })).toBeVisible();
        await expect(page.locator('thead th', { hasText: '19-10' })).toHaveClass(/bg-blue-50/);
        await expect(page.locator('thead th', { hasText: '18-10' })).toHaveCount(0);
      });
    } finally {
      await request.delete(`${api}/intervenants/${id}`, { headers });
    }
  });

  // La page publique n'a pas de session : elle prend le jour, la semaine et le fuseau de la
  // société dans la réponse du serveur, simulée ici pour un instant donné.
  test('le planning public suit le jour et l’heure de la société renvoyés par le serveur', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-14T13:00:00Z') });
    const demandes: string[] = [];
    await page.route('**/api/planning/public/**', async (route) => {
      demandes.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ events: [], intervenants: [], fuseauHoraire: 'Pacific/Wallis', aujourdhui: '2026-10-15', debut: '2026-10-12', fin: '2026-10-18' }),
      });
    });
    await page.goto('/planning/public/jeton-e2e-dates', { waitUntil: 'networkidle' });
    // Première demande sans plage : le serveur choisit la semaine de la société.
    expect(new URL(demandes[0]).search).toBe('');
    await expect(page.getByText('12 – 18 octobre 2026')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Semaine 42' })).toBeVisible();
    // Le jeudi 15 (Wallis) est « Aujourd'hui », et non le mercredi 14 de Cayenne.
    await expect(page.getByText("Aujourd'hui", { exact: true }).locator('..')).toContainText('jeudi 15 octobre');
    // 13:00 UTC = 01:00 à Wallis.
    await expect(page.getByText(/Mis à jour à 01:00/)).toBeVisible();
  });
});

test.describe('navigateur à Gambier, société à Wallis', () => {
  test.use({ timezoneId: 'Pacific/Gambier' });

  // 01-01-2027 à 13:30 UTC : le 1er à Paris (fuseau par défaut de l'écran) et à Gambier, déjà
  // le 2 à Wallis. Le formulaire est ouvert pendant que la lecture du fuseau est retenue : ses
  // dates ne doivent pas être préremplies au jour de Paris, mais à celui de la société.
  test('une facture ouverte avant la lecture du fuseau est préremplie au jour de la société', async ({ page, request, session }) => {
    await page.clock.install({ time: new Date('2027-01-01T13:30:00Z') });
    await avecFuseauSociete(request, session.token, 'Pacific/Wallis', async () => {
      let liberer = () => {};
      const retenue = new Promise<void>((resolve) => { liberer = resolve; });
      await page.route('**/api/company', async (route) => {
        if (route.request().method() === 'GET') await retenue;
        await route.continue();
      });
      await page.addInitScript(([token, user]) => {
        localStorage.setItem('token', token as string);
        localStorage.setItem('user', user as string);
      }, [session.token, JSON.stringify(session.user)]);
      await page.goto('/factures', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Nouvelle facture/ }).click();
      const emission = page.locator('input[name="dateEmission"]');
      await expect(emission).toBeDisabled();
      await expect(emission).toHaveValue('');
      liberer();
      await expect(emission).toBeEnabled();
      await expect(emission).toHaveValue('02-01-2027');
      await expect(page.locator('input[name="dateEcheance"]')).toHaveValue('02-01-2027');
    });
  });
});
