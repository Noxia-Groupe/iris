import { createHmac } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { test, expect } from './fixtures';

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

// Décision de Nelson (14-10-2026) : un directeur peut clôturer n'importe quel chantier ; il ne le
// rouvre pas. Un conducteur clôture l'affaire dont il est chargé, pas celle d'un autre.
test('un directeur clôture le chantier d’un conducteur depuis la liste ; un autre conducteur ne le peut pas', async ({ creerClient, request, session, browser }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'patch' | 'put', path: string, data: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = Date.now();
  const creerCompte = async (cle: string, nom: string, role: string): Promise<Compte> =>
    envoyer('post', '/users', { email: `cloture.${cle}.${suffixe}@iris.test`, name: `${nom} ${suffixe}`, role });
  const directeur = await creerCompte('directeur', 'Directeur clôture', 'DIRECTEUR');
  const conducteur = await creerCompte('conducteur', 'Conducteur clôture', 'CONDUCTEUR_TRAVAUX');
  const autreConducteur = await creerCompte('autre', 'Autre conducteur clôture', 'CONDUCTEUR_TRAVAUX');

  const client = await creerClient('cloture-directeur', false);
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Clôture directeur E2E ${suffixe}`, lignes: [
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
  ] });
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  const contextes: { close: () => Promise<void> }[] = [];
  try {
    await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: conducteur.id });

    // Témoin : un autre conducteur ne voit pas ce chantier, et sa clôture lui est refusée.
    const refus = await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers: { Authorization: `Bearer ${jetonPour(autreConducteur.id)}` }, data: { statut: 'TERMINE' } });
    expect(refus.status()).toBe(404);

    const vueDirecteur = await pageDe(browser, directeur);
    contextes.push(vueDirecteur.context());
    await vueDirecteur.goto('/chantiers', { waitUntil: 'networkidle' });
    const ligne = vueDirecteur.locator(`tr[data-chantier="${chantier.id}"]`);
    await expect(ligne).toBeVisible();
    vueDirecteur.once('dialog', (dialog) => void dialog.accept());
    const cloture = vueDirecteur.waitForResponse((r) => r.url().endsWith(`/api/chantiers/${chantier.id}/statut`) && r.request().method() === 'PATCH');
    await ligne.getByRole('button', { name: 'Clôturer' }).click();
    expect((await cloture).status()).toBe(200);
    const relu = await (await request.get(`${api}/chantiers/${chantier.id}`, { headers })).json() as { statut: string; dateFin: string | null };
    expect(relu.statut).toBe('TERMINE');
    expect(relu.dateFin).not.toBeNull();
    // Le directeur ne rouvre pas : aucun bouton, et l'API le refuse.
    await vueDirecteur.reload({ waitUntil: 'networkidle' });
    await expect(vueDirecteur.getByRole('button', { name: 'Réouvrir' })).toHaveCount(0);
    const reouverture = await request.patch(`${api}/chantiers/${chantier.id}/statut`, { headers: { Authorization: `Bearer ${jetonPour(directeur.id)}` }, data: { statut: 'EN_COURS' } });
    expect(reouverture.status()).toBe(403);
  } finally {
    for (const contexte of contextes) await contexte.close().catch(() => undefined);
  }
});
