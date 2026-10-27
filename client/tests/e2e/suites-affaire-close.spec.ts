import { createHmac } from 'node:crypto';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Décision de Nelson du 27-10-2026 à 15:50 UTC : « oui, il faut egalement refusé aussi ces saisies ». Les
// coûts d'une suite rattachée à une affaire entrent dans la marge du chantier (#339) : chantier clôturé, le
// technicien ne peut plus y saisir ses heures, et l'écran lui dit pourquoi.

// Même procédé que les autres parcours : un jeton signé avec le secret du backend jetable ouvre la session
// du technicien.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test('chantier clôturé : le technicien ne peut plus saisir ses heures sur une suite de l’affaire, et l’écran dit pourquoi', async ({ session, request, creerClient, browser }) => {
  const envoyer = async (methode: 'post' | 'put' | 'patch', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers: { Authorization: `Bearer ${session.token}` }, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const technicien = await envoyer('post', '/users', { email: `suites.affaire.${suffixe}@iris.test`, name: `Technicien affaire ${suffixe}`, role: 'TECHNICIEN' }) as { id: string; name: string; email: string; role: string };
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche affaire ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 }) as { id: string };
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  const client = await creerClient(`suites-affaire ${suffixe}`);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Affaire close ${suffixe}`, lignes: [
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 150, tauxTva: 20 },
  ] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  const initiale = await envoyer('post', '/interventions', { clientId: client.id, titre: `Dépannage de l’affaire ${suffixe}`, chantierId: chantier.id }) as { id: string };
  const suite = await envoyer('post', `/interventions/${initiale.id}/suites`, { titre: `Suite de l’affaire close ${suffixe}` }) as { id: string; titre: string };
  const jourIso = dateDuJour().split('-').reverse().join('-');
  await envoyer('put', `/interventions/${suite.id}/planning`, { dateDebut: jourIso, creneau: 'HEURES', heureDebut: '08:30', heureFin: '09:30', intervenantIds: [fiche.id] });
  await envoyer('patch', `/chantiers/${chantier.id}/statut`, { statut: 'TERMINE' });

  const contexte = await browser.newContext();
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(technicien.id), JSON.stringify({ ...technicien, permissions: ['chantiers:read', 'clients:read'] })]);
  try {
    await page.goto('/interventions', { waitUntil: 'networkidle' });
    const carte = page.locator('article', { hasText: suite.titre });
    await carte.getByPlaceholder('Date (JJ-MM-AAAA)').fill(dateDuJour());
    await carte.getByPlaceholder('Heures').fill('1,5');
    const saisie = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/interventions/${suite.id}/couts/heures`));
    await carte.getByRole('button', { name: 'Enregistrer mes heures' }).click();
    expect((await saisie).status()).toBe(403);
    await expect(page.getByText('Le chantier de cette suite est clôturé : ses coûts ne peuvent plus être saisis ni modifiés.')).toBeVisible();
    await expect(carte.getByText(`${dateDuJour()} — 1.5 h`)).toHaveCount(0);
  } finally {
    await contexte.close();
  }
});
