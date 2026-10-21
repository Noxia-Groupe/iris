import { createHmac } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { test, expect, dateDuJour } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Session d'un compte non administrateur : jeton signé avec le secret du backend jetable, comme
// dans les autres parcours.
const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

// Chaque route est mesurée dans une page neuve, avec son propre contexte. Une même page réutilisée
// pour une centaine de navigations finissait, en local, par épuiser les ressources réseau de Chromium
// (`net::ERR_INSUFFICIENT_RESOURCES` sur les modules servis par Vite) : la page restait vide, et
// l'échec ne disait rien de l'écran mesuré (#152).
async function dansUnePageNeuve(browser: Browser, token: string, user: string, mesurer: (page: Page) => Promise<void>) {
  const contexte = await browser.newContext({ viewport: { width: 375, height: 800 } });
  try {
    const page = await contexte.newPage();
    await page.addInitScript(([jeton, compte]) => {
      localStorage.setItem('token', jeton as string);
      localStorage.setItem('user', compte as string);
    }, [token, user]);
    await mesurer(page);
  } finally {
    await contexte.close();
  }
}

// Sur téléphone et tablette, rien ne doit sortir de l'écran ni être rogné par son cadre, et aucun
// titre ne doit passer sous un bouton. Un débordement fait défiler latéralement toute la zone
// principale, ou disparaît sans recours sur les pages dont la racine masque le débordement (fiche
// chantier, tableau de bord, liste des chantiers). Seuls les contenus d'un conteneur défilant
// (tableau, barre d'onglets) peuvent dépasser, puisqu'on les fait défiler.
async function defautsAffichage(page: Page) {
  return page.evaluate(() => {
    const largeur = window.innerWidth;
    const principal = document.querySelector('main');
    // Tolérance d'un demi-pixel (arrondi du rendu) : un dépassement d'un pixel ici en devient
    // plusieurs avec d'autres polices (constaté en CI sur « Prêt à facturer »).
    const tolerance = 0.5;
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    // Ancêtre défilant (dans la zone principale) ou qui rogne ce qui le dépasse.
    const ancetres = (el: Element) => {
      const liste: { el: Element; defile: boolean }[] = [];
      for (let p = el.parentElement; p && p !== principal && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (['auto', 'scroll'].includes(ox)) liste.push({ el: p, defile: true });
        else if (['hidden', 'clip'].includes(ox)) liste.push({ el: p, defile: false });
      }
      return liste;
    };
    const libelle = (el: Element) => (el.textContent || (el as HTMLInputElement).placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const coupes: string[] = [];
    if (principal && principal.scrollWidth > principal.clientWidth + tolerance) coupes.push(`zone principale : ${principal.scrollWidth} px de contenu pour ${principal.clientWidth}`);
    for (const el of Array.from(document.querySelectorAll('main *'))) {
      // L'intérieur d'une icône SVG (rogné par le navigateur) et les décors marqués aria-hidden
      // (coins colorés des cartes, rognés exprès) ne sont pas des contenus.
      if (!visible(el) || (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') || el.closest('[aria-hidden="true"]:not(svg)')) continue;
      const r = el.getBoundingClientRect();
      const cadres = ancetres(el);
      const premier = cadres[0];
      if (premier?.defile) continue;
      if (r.right > largeur + tolerance || r.left < -tolerance) { coupes.push(`${el.tagName.toLowerCase()} hors de l'écran « ${libelle(el)} »`); continue; }
      if (premier && !premier.defile) {
        const c = premier.el.getBoundingClientRect();
        if (r.right > c.right + tolerance || r.left < c.left - tolerance) coupes.push(`${el.tagName.toLowerCase()} rogné par son cadre « ${libelle(el)} »`);
      }
      // Texte qui déborde du bloc encadré ou coloré qui le contient (tuile, carte), sans être rogné.
      if (Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) {
        for (let p = el.parentElement; p && p !== principal; p = p.parentElement) {
          const style = getComputedStyle(p);
          if (parseFloat(style.borderRightWidth) > 0 || style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
            const c = p.getBoundingClientRect();
            if (r.right > c.right + tolerance || r.left < c.left - tolerance) coupes.push(`${el.tagName.toLowerCase()} déborde de sa carte « ${libelle(el)} »`);
            break;
          }
        }
      }
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
    return { coupes: [...new Set(coupes)].slice(0, 15), recouverts };
  });
}

test.describe('écrans sur téléphone et tablette (320 à 1024 px)', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('rien de coupé hors de l’écran ni rogné par son cadre, aucun titre recouvert', async ({ browser, request, session, creerClient }) => {
    test.setTimeout(360_000);
    const headers = { Authorization: `Bearer ${session.token}` };
    const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
      const reponse = await request[methode](`${api}${path}`, { headers, data });
      expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
      return reponse.json();
    };
    const suffixe = Date.now();
    const client = await creerClient(`écrans téléphone, société de maintenance des installations thermiques`);
    // Données longues, comme en exploitation : un nom de site, un conducteur et un commercial aux
    // noms et adresses longs (cartes de Performances et de Mes commerciaux, formulaire du parc).
    await envoyer('post', `/clients/${client.id}/sites`, { nom: 'Chaufferie collective du bâtiment B et sous-station', adresse: '12 avenue des Établissements Industriels', codePostal: '14000', ville: 'Caen' });
    const conducteur = await envoyer('post', '/users', { email: `conducteur.travaux.des.installations.thermiques.${suffixe}@iris.test`, name: `Jean-Baptiste de La Fontaine-Marchand ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as { id: string };
    await envoyer('post', '/users', { email: `commercial.grands.comptes.region.normandie.${suffixe}@iris.test`, name: `Marie-Christine Delacroix-Beaumont ${suffixe}`, role: 'COMMERCIAL' });
    // Un client sans site : « Prêt à facturer » affiche alors un contrôle non bloquant et son lien
    // « Configurer », qui sortait de l'écran (sans effet sur « Configuration prête »).
    await creerClient('écrans téléphone sans site', false);
    // Un nom d'affaire long : c'est lui que la barre d'actions de la fiche recouvrait.
    const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Rénovation complète de la chaufferie collective ${Date.now()}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
    await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
    const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
    const affectation = await request.patch(`${api}/chantiers/${chantier.id}`, { headers, data: { responsableId: conducteur.id } });
    expect(affectation.ok(), await affectation.text()).toBeTruthy();
    // Un devis signé, encore à convertir : sa ligne porte toutes les actions de conversion (chantier,
    // intervention, contrat), qui débordaient à 320 et 375 px avant #281, sans dépendre d'un autre parcours.
    const aConvertir = await envoyer('post', '/devis', { clientId: client.id, objet: `Contrat de maintenance de la chaufferie collective ${suffixe}`, lignes: [{ designation: 'Visite', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
    await envoyer('put', `/devis/${aConvertir.id}/statut`, { statut: 'ENVOYE' });
    await envoyer('post', `/devis/${aConvertir.id}/signature`, { signataire: 'Client E2E', confirme: true });
    // Des listes non vides : une carte ou une ligne trop large n'apparaît qu'avec des données (les
    // actions d'un contrat sortaient de l'écran). Un compte au plan comptable, un contrat, une
    // intervention, une visite de contrat à planifier et une facture brouillon.
    const plan = await (await request.get(`${api}/comptabilite`, { headers })).json() as { comptes: unknown[] };
    expect(plan.comptes.length).toBeGreaterThan(0);
    const contrat = await envoyer('post', '/contrats-maintenance', { clientId: client.id, titre: `Maintenance préventive des installations ${Date.now()}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-10-2030' }) as { id: string };
    // Une visite à planifier : la file du planning coupait son bouton « Placer ».
    await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`, {});
    await envoyer('post', '/interventions', { clientId: client.id, chantierId: chantier.id, titre: `Fuite sur le réseau de chauffage ${Date.now()}` });
    // Un numéro de série insécable dans un titre : la liste des interventions, grille à une
    // colonne, prenait la largeur de sa carte la plus large et sortait de l'écran (#281).
    await envoyer('post', '/interventions', { clientId: client.id, titre: `Remplacement du circulateur SN${suffixe}A7B3C9D2E8F4` });
    await envoyer('post', '/factures', { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Écrans sur téléphone', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'Prestation', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
    // Une facture émise, en partie réglée : la liste des règlements et le formulaire ouvert sur
    // cette facture (client, factures à régler, montants) sont mesurés avec leurs données.
    const emise = await envoyer('post', '/factures', { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Écrans sur téléphone, règlement', dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Prestation réglée en partie', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] }) as { id: string };
    await envoyer('post', `/factures/${emise.id}/emettre`, {});
    await envoyer('post', '/reglements', { clientId: client.id, dateReglement: dateDuJour(), montant: 200, moyen: 'VIREMENT', reference: `Virement de la société de maintenance des installations thermiques ${suffixe}`, affectations: [{ factureId: emise.id, montant: 200 }] });

    const routes = ['/', '/chantiers', `/chantiers/${chantier.id}`, '/devis', '/interventions', '/contrats-maintenance', '/factures',
      '/prete-a-facturer', '/mentions-legales', '/comptabilite', '/clients', `/clients/${client.id}`, '/societe', '/catalogue',
      '/administration/api', '/achats', '/heures', '/planning', '/admin', '/performances', '/commerciaux', '/statistiques', '/resultat-commercial',
      '/reglements', `/reglements?facture=${emise.id}`];
    const defauts: Record<string, { coupes: string[]; recouverts: string[] }> = {};
    for (const route of routes) {
      await dansUnePageNeuve(browser, session.token, JSON.stringify(session.user), async (page) => {
        // Téléphones étroit et courant, tablette en portrait et en paysage (le menu latéral apparaît à 1024 px).
        for (const largeur of [320, 375, 768, 1024]) {
          await page.setViewportSize({ width: largeur, height: 800 });
          await page.goto(route, { waitUntil: 'networkidle' });
          await expect(page.locator('main h1, main h2').first(), `${largeur} px ${route}`).toBeVisible();
          const constat = await defautsAffichage(page);
          if (constat.coupes.length || constat.recouverts.length) defauts[`${largeur} px ${route}`] = constat;
        }
      });
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

// Le technicien et le conducteur travaillent d'abord sur téléphone : leurs écrans, mesurés de même.
test('écrans du technicien et du conducteur sur téléphone : rien de coupé, rogné ni recouvert', async ({ browser, request, session, creerClient }) => {
  test.setTimeout(240_000);
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const suffixe = Date.now();
  const client = await creerClient('écrans terrain, société de maintenance des installations thermiques');
  await envoyer('post', `/clients/${client.id}/sites`, { nom: 'Chaufferie collective du bâtiment B et sous-station', adresse: '12 avenue des Établissements Industriels', codePostal: '14000', ville: 'Caen' });
  type Compte = { id: string; name: string; email: string; role: string };
  const conducteur = await envoyer('post', '/users', { email: `conducteur.terrain.installations.thermiques.${suffixe}@iris.test`, name: `Jean-Baptiste de La Fontaine-Marchand ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as Compte;
  const technicien = await envoyer('post', '/users', { email: `technicien.terrain.installations.thermiques.${suffixe}@iris.test`, name: `Pierre-Alexandre Dumont-Lefebvre ${suffixe}`, role: 'TECHNICIEN' }) as Compte;
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Rénovation complète de la chaufferie collective ${suffixe}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string };
  const affectation = await request.patch(`${api}/chantiers/${chantier.id}`, { headers, data: { responsableId: conducteur.id } });
  expect(affectation.ok(), await affectation.text()).toBeTruthy();
  await envoyer('post', '/interventions', { clientId: client.id, chantierId: chantier.id, titre: `Fuite sur le réseau de chauffage ${suffixe}` });

  const parcours: [Compte, string[]][] = [
    [conducteur, ['/', '/chantiers', `/chantiers/${chantier.id}`, '/interventions', '/clients', `/clients/${client.id}`, '/achats', '/heures', '/planning', '/statistiques']],
    [technicien, ['/', '/interventions', '/clients', `/clients/${client.id}`, '/planning']],
  ];
  const defauts: Record<string, { coupes: string[]; recouverts: string[] }> = {};
  for (const [compte, routes] of parcours) {
    for (const route of routes) {
      await dansUnePageNeuve(browser, jetonPour(compte.id), JSON.stringify({ ...compte, permissions: [] }), async (page) => {
        for (const largeur of [320, 375]) {
          await page.setViewportSize({ width: largeur, height: 800 });
          await page.goto(route, { waitUntil: 'networkidle' });
          await expect(page, `${compte.role} ${route}`).not.toHaveURL(/acces-refuse/);
          await expect(page.locator('main h1, main h2').first(), `${compte.role} ${largeur} px ${route}`).toBeVisible();
          const constat = await defautsAffichage(page);
          if (constat.coupes.length || constat.recouverts.length) defauts[`${compte.role} ${largeur} px ${route}`] = constat;
        }
      });
    }
  }
  expect(defauts).toEqual({});
});
