import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Sur téléphone, aucun en-tête ni aucune barre d'actions ne doit sortir de l'écran ou passer sous un
// titre. Le gabarit masque le débordement horizontal : un bouton coupé n'y fait pas défiler la page,
// il devient simplement inaccessible. Seuls les contenus d'un conteneur défilant (tableau, barre
// d'onglets) peuvent dépasser, puisqu'on les fait défiler.
async function defautsAffichage(page: Page) {
  return page.evaluate(() => {
    const largeur = window.innerWidth;
    const principal = document.querySelector('main');
    const defilable = (el: Element) => {
      for (let p = el.parentElement; p && p !== principal && p !== document.body; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (['auto', 'scroll'].includes(style.overflowX) && p.scrollWidth > p.clientWidth) return true;
      }
      return false;
    };
    const libelle = (el: Element) => (el.textContent || (el as HTMLInputElement).placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const coupes: string[] = [];
    for (const el of Array.from(document.querySelectorAll('main button, main a, main h1, main h2, main input, main select, main span, main p'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.right > largeur + 1 || r.left < -1) && !defilable(el)) coupes.push(`${el.tagName.toLowerCase()} « ${libelle(el)} »`);
    }
    const recouverts: string[] = [];
    for (const titre of Array.from(document.querySelectorAll('main h1, main h2'))) {
      const t = titre.getBoundingClientRect();
      if (!t.width || t.top > 700) continue;
      for (const el of Array.from(document.querySelectorAll('main button, main a'))) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.left < t.right - 1 && r.right > t.left + 1 && r.top < t.bottom - 1 && r.bottom > t.top + 1 && !titre.contains(el) && !el.contains(titre)) {
          recouverts.push(`« ${libelle(titre)} » sous « ${libelle(el)} »`);
        }
      }
    }
    return { coupes, recouverts };
  });
}

test.describe('écrans sur téléphone (375 px)', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('aucun bouton ni titre coupé hors de l’écran, aucun titre recouvert', async ({ allerSurPageAdmin, request, session, creerClient }) => {
    test.slow();
    const headers = { Authorization: `Bearer ${session.token}` };
    const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
      const reponse = await request[methode](`${api}${path}`, { headers, data });
      expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
      return reponse.json();
    };
    const client = await creerClient('écrans téléphone');
    // Un nom d'affaire long : c'est lui que la barre d'actions de la fiche recouvrait.
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Rénovation complète de la chaufferie collective ${Date.now()}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
    // Au moins un compte au plan comptable : ses boutons de ligne étaient coupés.
    const plan = await (await request.get(`${api}/comptabilite`, { headers })).json() as { comptes: unknown[] };
    expect(plan.comptes.length).toBeGreaterThan(0);

    const routes = ['/', '/chantiers', `/chantiers/${chantier.id}`, '/devis', '/interventions', '/contrats-maintenance', '/factures',
      '/prete-a-facturer', '/mentions-legales', '/comptabilite', '/clients', `/clients/${client.id}`, '/societe', '/catalogue',
      '/administration/api', '/achats', '/heures', '/planning', '/admin', '/performances', '/commerciaux', '/statistiques', '/resultat-commercial'];
    const page = await allerSurPageAdmin('/');
    const defauts: Record<string, { coupes: string[]; recouverts: string[] }> = {};
    for (const route of routes) {
      await page.goto(route, { waitUntil: 'networkidle' });
      await expect(page.locator('main h1, main h2').first()).toBeVisible();
      const constat = await defautsAffichage(page);
      if (constat.coupes.length || constat.recouverts.length) defauts[route] = constat;
    }
    expect(defauts).toEqual({});
  });
});

// Au-delà du téléphone, la barre d'actions de la fiche reprend sa place en haut à droite, sans
// recouvrir un nom d'affaire long.
test('fiche chantier sur grand écran : le titre ne passe pas sous les boutons', async ({ allerSurPageAdmin, request, session, creerClient }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const client = await creerClient('écrans grand format');
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Rénovation complète de la chaufferie collective et des réseaux de distribution ${Date.now()}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  for (const largeur of [700, 1280]) {
    const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
    await page.setViewportSize({ width: largeur, height: 900 });
    await expect(page.getByRole('button', { name: 'PDF', exact: true }).first()).toBeVisible();
    expect(await defautsAffichage(page), `à ${largeur} px`).toEqual({ coupes: [], recouverts: [] });
  }
});
