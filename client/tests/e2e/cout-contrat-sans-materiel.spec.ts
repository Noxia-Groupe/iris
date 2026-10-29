import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Décision de Nelson du 20-10-2026 (#257, « Libellé du coût cumulé d'une intervention ») : avec un contrat, le total
// garde « Coût réel cumulé », même pour un matériel nul. Depuis #357, l'écran passe « hors contrat »
// (!item.contratMaintenanceId) à resumeCoutsIntervention : ce parcours éprouve ce câblage sur une visite de contrat
// sans matériel, que ni les tests unitaires (la fonction seule) ni les autres parcours (contrat avec matériel,
// curatives) ne couvrent (audit n° 6 de #357, remarque T9).
test('visite de contrat sans matériel : l’administration voit « Coût réel cumulé : 0,00 € HT », jamais « Main-d’œuvre cumulée »', async ({ request, session, creerClient, allerSurPageAdmin }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const client = await creerClient('libellé contrat sans matériel', false);
  const contrat = await request.post(`${api}/contrats-maintenance`, {
    headers,
    data: { clientId: client.id, titre: `Contrat E2E libellé ${Date.now()}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2026' },
  });
  expect(contrat.status(), await contrat.text()).toBe(201);
  const { id: contratId } = await contrat.json() as { id: string };
  const visite = await request.post(`${api}/contrats-maintenance/${contratId}/generer-intervention`, { headers });
  expect(visite.status(), await visite.text()).toBe(201);
  const { id, titre } = await visite.json() as { id: string; titre: string };

  const page = await allerSurPageAdmin(`/interventions/${id}`);
  const carte = page.locator('article', { hasText: titre });
  await expect(carte.getByText(/Coût réel cumulé : 0,00\s€ HT/)).toBeVisible();
  await expect(carte.getByText(/Main-d’œuvre cumulée/)).toHaveCount(0);
});
