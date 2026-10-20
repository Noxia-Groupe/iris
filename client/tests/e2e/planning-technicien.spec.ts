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

async function pageTelephone(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: ['chantiers:read', 'clients:read'] })]);
  return page;
}

// Planning limité à ce dont le technicien est chargé (décision de Nelson du 19-10-2026) : sur
// téléphone, il ne voit que sa ligne et ses affectations ; sans fiche reliée, un message le lui dit.
// L'encadrement garde toute l'équipe.
test('sur téléphone, le technicien ne voit au planning que sa ligne et les affectations dont il est chargé', async ({ session, request, creerClient, browser, allerSurPageAdmin }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'get' | 'post' | 'put', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const aujourdhui = dateDuJour().split('-').reverse().join('-');
  const compte = (cle: string): Promise<Compte> => envoyer('post', '/users', { email: `planning-t.${cle}.${suffixe}@iris.test`, name: `Technicien PT ${cle} ${suffixe}`, role: 'TECHNICIEN' });
  const technicien = await compte('relie');
  const collegue = await compte('collegue');
  const sansFiche = await compte('sans-fiche');
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche PT ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  const ficheCollegue = await envoyer('post', '/intervenants', { nom: `Fiche PT collègue ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  await envoyer('put', `/intervenants/${ficheCollegue.id}/compte`, { userId: collegue.id });
  const affectation = (titre: string, intervenantIds: string[]) => envoyer('post', '/planning/events', { categorie: 'HORS_CHANTIER', titre: `${titre} ${suffixe}`, dateDebut: aujourdhui, creneau: 'JOURNEE', intervenantIds });
  await affectation('Affectation PT', [fiche.id]);
  await affectation('Partagée PT', [ficheCollegue.id, fiche.id]);
  await affectation('Collègue PT', [ficheCollegue.id]);
  const client = await creerClient(`planning-t-${suffixe}`);
  const dossier = await envoyer('post', '/interventions', { clientId: client.id, titre: `Dépannage PT collègue ${suffixe}` });
  await envoyer('put', `/interventions/${dossier.id}/planning`, { dateDebut: aujourdhui, creneau: 'MATIN', intervenantIds: [ficheCollegue.id] });

  const page = await pageTelephone(browser, technicien);
  const fenetres: string[] = [];
  const requetes: string[] = [];
  page.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
  page.on('request', (requete) => requetes.push(requete.url()));
  try {
    await page.goto('/planning', { waitUntil: 'networkidle' });
    await expect(page.getByText('Consultation seule')).toBeVisible();
    await expect(page.getByText('Vous ne voyez que les affectations dont vous êtes chargé.')).toBeVisible();
    // Sa seule ligne, avec ses affectations, y compris celle qu'il partage.
    await expect(page.locator('table tbody tr')).toHaveCount(1);
    await expect(page.getByText(`Fiche PT ${suffixe}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Affectation PT ${suffixe}`)).toBeVisible();
    await expect(page.getByText(`Partagée PT ${suffixe}`)).toBeVisible();
    // Ni la ligne du collègue, ni ses affectations, ni sa projection.
    await expect(page.getByText(`Fiche PT collègue ${suffixe}`)).toHaveCount(0);
    await expect(page.getByText(`Collègue PT ${suffixe}`)).toHaveCount(0);
    await expect(page.getByText(`Dépannage PT collègue ${suffixe}`)).toHaveCount(0);
    // La liste des chantiers, qui ne sert qu'au formulaire d'affectation, n'est pas demandée.
    expect(requetes.filter((url) => url.includes('/api/planning/chantiers'))).toEqual([]);
    // La grille défile dans son cadre : la page ne déborde pas de l'écran.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    // Sans fiche reliée, aucune grille : un message l'explique.
    const vueSansFiche = await pageTelephone(browser, sansFiche);
    try {
      vueSansFiche.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
      await vueSansFiche.goto('/planning', { waitUntil: 'networkidle' });
      await expect(vueSansFiche.getByText('Aucune fiche intervenant n\'est reliée à votre compte.')).toBeVisible();
      await expect(vueSansFiche.locator('table')).toHaveCount(0);
      await expect(vueSansFiche.getByText('Aucun technicien enregistré.')).toHaveCount(0);
    } finally {
      await vueSansFiche.context().close();
    }

    // Témoin : l'administration garde toute l'équipe et toutes les affectations.
    const vueAdmin = await allerSurPageAdmin('/planning');
    await expect(vueAdmin.getByText(`Fiche PT collègue ${suffixe}`, { exact: true })).toBeVisible();
    await expect(vueAdmin.getByText(`Fiche PT ${suffixe}`, { exact: true })).toBeVisible();
    await expect(vueAdmin.getByText(`Collègue PT ${suffixe}`)).toBeVisible();
    await expect(vueAdmin.getByText(`Dépannage PT collègue ${suffixe}`)).toBeVisible();
    await expect(vueAdmin.getByText('Vous ne voyez que les affectations dont vous êtes chargé.')).toHaveCount(0);
    expect(fenetres).toEqual([]);
  } finally {
    await page.context().close();
  }
});
