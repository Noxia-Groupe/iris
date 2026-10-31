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
    // Un numéro de série insécable dans la couverture d'un contrat et dans la description d'une
    // intervention : les deux listes, grilles à une colonne, sortaient de l'écran (#281).
    const serie = `SN${suffixe}A7B3C9D2E8F4G6H1J5K0`;
    const contrat = await envoyer('post', '/contrats-maintenance', { clientId: client.id, titre: `Maintenance préventive des installations ${Date.now()}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-10-2030', noteCouverture: `Circulateur ${serie}` }) as { id: string };
    // Une visite à planifier : la file du planning coupait son bouton « Placer ».
    await envoyer('post', `/contrats-maintenance/${contrat.id}/generer-intervention`, {});
    await envoyer('post', '/interventions', { clientId: client.id, chantierId: chantier.id, titre: `Fuite sur le réseau de chauffage ${Date.now()}` });
    // Un numéro de série insécable dans un titre : la liste des interventions, grille à une
    // colonne, prenait la largeur de sa carte la plus large et sortait de l'écran (#281).
    await envoyer('post', '/interventions', { clientId: client.id, titre: `Remplacement du circulateur SN${suffixe}A7B3C9D2E8F4`, description: `Ancien circulateur ${serie}` });
    await envoyer('post', '/factures', { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Écrans sur téléphone', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'Prestation', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
    // Une facture émise, en partie réglée : la liste des règlements et le formulaire ouvert sur
    // cette facture (client, factures à régler, montants) sont mesurés avec leurs données.
    const emise = await envoyer('post', '/factures', { clientId: client.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Écrans sur téléphone, règlement', dateEmission: dateDuJour(), dateEcheance: dateDuJour(), lignes: [{ designation: 'Prestation réglée en partie', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] }) as { id: string };
    await envoyer('post', `/factures/${emise.id}/emettre`, {});
    await envoyer('post', '/reglements', { clientId: client.id, dateReglement: dateDuJour(), montant: 200, moyen: 'VIREMENT', reference: `Virement de la société de maintenance des installations thermiques ${suffixe}`, affectations: [{ factureId: emise.id, montant: 200 }] });
    // Une prestation ordinaire aux référence et libellé longs : le tableau du catalogue, plus large que
    // l'écran, doit défiler au lieu d'être rogné par son cadre (#327), sans dépendre des fiches laissées
    // en base par un autre parcours.
    await envoyer('post', '/catalogue/prestations', { reference: `E2E-ECRANS-PRESTATION-${suffixe}`, nom: `Remise en service complète de la chaufferie collective ${suffixe}`, unite: 'forfait', prixVenteHt: '1250', tauxTva: '20' });

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

// Sur tablette et grand écran, la barre d'actions de la fiche ne recouvre jamais un nom d'affaire long. Lot
// 6a-4c (cadrage, « Écran », N5) : l'administration y a désormais trois boutons, « Modifier », « Rapport
// interne (PDF) » (la capture, autrefois « PDF ») et « Rapport client (PDF) ». La barre reste au-dessus du
// titre à toute largeur, sans retrait du titre, pour que la capture du rapport interne, mise en page sur la
// largeur d'une page A4, ne l'écrase pas (contrôle de cohérence de #397, B1).
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
    // La barre d'actions : le plus petit bloc qui porte les deux rapports (la fiche a un autre « Modifier »,
    // celui du commercial).
    const barre = page.locator('div')
      .filter({ has: page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Rapport client (PDF)', exact: true }) }).last();
    for (const nom of ['Modifier', 'Rapport interne (PDF)', 'Rapport client (PDF)']) {
      await expect(barre.getByRole('button', { name: nom, exact: true }), `${nom} à ${largeur} px`).toBeVisible();
    }
    expect(await defautsAffichage(page), `à ${largeur} px`).toEqual({ coupes: [], recouverts: [] });
  }
});

// Contrôle de cohérence de #397, B1 (passation, lot 6a-4c, puce « Barre d'actions de la fiche », choix de mise en
// œuvre, à confirmer) : la barre d'actions reste dans le flux, au-dessus du titre, et l'en-tête n'a aucun retrait, à
// toute largeur. Le « Rapport interne (PDF) » (html2pdf) met la fiche en page sur la largeur d'une page A4 moins ses
// marges (7,27 pouces, environ 698 px), mais avec les règles CSS de la largeur de l'écran : le retrait réservé à la
// barre à partir de 1 280 px y écrasait l'en-tête (date et référence coupées en deux). L'en-tête est donc mesuré à
// l'écran, puis dans la mise en page de la capture : sur le clone de la fiche que html2pdf insère dans la page, dès
// son insertion, avant de le dessiner puis de le retirer.
type MiseEnPageCapture = { largeurZone: number; largeurUtile: number; largeurEntete: number; retraitEntete: string; barreAuDessusDuTitre: boolean };
type FenetreMesuree = { miseEnPageCapture: Promise<MiseEnPageCapture> };

test('fiche chantier, de 375 à 1 920 px : barre d’actions au-dessus du titre et en-tête sans retrait, à l’écran et dans la capture du rapport interne', async ({ allerSurPageAdmin, request, session, creerClient }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const client = await creerClient('barre dans le flux');
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Rénovation complète de la chaufferie ${Date.now()}`, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  const titre = page.getByRole('heading', { name: chantier.nom, exact: true });
  const rapportInterne = page.getByRole('button', { name: 'Rapport interne (PDF)', exact: true });
  // La barre d'actions : le plus petit bloc qui porte les deux rapports, comme dans le parcours précédent. L'en-tête :
  // le bloc du titre, de son statut et des lignes qui le suivent (date de démarrage, référence du devis).
  const barre = page.locator('div')
    .filter({ has: rapportInterne })
    .filter({ has: page.getByRole('button', { name: 'Rapport client (PDF)', exact: true }) }).last();
  const entete = titre.locator('xpath=../..');
  for (const largeur of [375, 1024, 1280, 1536, 1920]) {
    await page.setViewportSize({ width: largeur, height: 900 });
    await expect(titre).toBeVisible();
    expect(await barre.evaluate((e) => getComputedStyle(e).position), `barre à ${largeur} px`).toBe('static');
    expect(await entete.evaluate((e) => getComputedStyle(e).paddingRight), `retrait de l’en-tête à ${largeur} px`).toBe('0px');

    await page.evaluate((nom) => {
      (window as unknown as FenetreMesuree).miseEnPageCapture = new Promise((resolve) => {
        const observateur = new MutationObserver((mutations) => {
          for (const ajout of mutations.flatMap((mutation) => Array.from(mutation.addedNodes))) {
            const titreCopie = ajout instanceof HTMLElement ? Array.from(ajout.querySelectorAll('h2')).find((h) => h.textContent?.trim() === nom) : undefined;
            if (!titreCopie) continue;
            observateur.disconnect();
            const enteteCopie = titreCopie.parentElement!.parentElement!;
            const zone = enteteCopie.parentElement!;
            const libelles = (e: Element) => Array.from(e.querySelectorAll('button')).map((b) => b.textContent?.trim());
            const barreCopie = Array.from(zone.querySelectorAll('div'))
              .filter((d) => libelles(d).includes('Rapport interne (PDF)') && libelles(d).includes('Rapport client (PDF)')).pop()!;
            const utile = (e: Element) => { const style = getComputedStyle(e); return e.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); };
            resolve({
              largeurZone: zone.getBoundingClientRect().width,
              largeurUtile: utile(zone),
              largeurEntete: utile(enteteCopie),
              retraitEntete: getComputedStyle(enteteCopie).paddingRight,
              barreAuDessusDuTitre: barreCopie.getBoundingClientRect().bottom <= titreCopie.getBoundingClientRect().top,
            });
            return;
          }
        });
        observateur.observe(document.body, { childList: true });
      });
    }, chantier.nom);
    const telechargement = page.waitForEvent('download');
    await rapportInterne.click();
    await telechargement;
    // Le fichier n'arrive qu'après le retrait du clone : un clone jamais vu échoue ici, sans attendre la fin du délai.
    const mesure = await page.evaluate(() => Promise.race([(window as unknown as FenetreMesuree).miseEnPageCapture, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000))]));
    expect(mesure, `clone de la fiche inséré par la capture à ${largeur} px`).not.toBeNull();
    const capture = mesure!;
    // La capture est mise en page sur une page A4 moins ses marges, et non sur la largeur de l'écran ; l'en-tête y
    // occupe toute la largeur utile de la fiche (au pixel près, arrondi du rendu), sans retrait, sous la barre.
    expect({
      pageA4: capture.largeurZone <= 700,
      retraitEntete: capture.retraitEntete,
      enteteSurTouteLaLargeur: Math.abs(capture.largeurEntete - capture.largeurUtile) <= 1,
      barreAuDessusDuTitre: capture.barreAuDessusDuTitre,
    }, `capture à ${largeur} px : ${JSON.stringify(capture)}`).toEqual({ pageA4: true, retraitEntete: '0px', enteteSurTouteLaLargeur: true, barreAuDessusDuTitre: true });
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
