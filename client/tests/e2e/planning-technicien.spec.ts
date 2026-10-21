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

async function pageTelephone(browser: Browser, compte: Compte) {
  const contexte = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await contexte.newPage();
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(compte.id), JSON.stringify({ ...compte, permissions: ['chantiers:read', 'clients:read'] })]);
  return page;
}

// Planning du technicien (décisions de Nelson du 19 et du 21-10-2026) : sur téléphone, il voit sa
// ligne et ses affectations, puis celles des chantiers dont il est titulaire, avec la ligne de
// l'intervenant concerné ; sans fiche reliée, un message le lui dit. L'encadrement garde toute l'équipe.
test('sur téléphone, le technicien ne voit au planning que ses affectations et celles des chantiers dont il est titulaire', async ({ session, request, creerClient, browser, allerSurPageAdmin, page: pageAdmin }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'get' | 'post' | 'put' | 'patch', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  // « Aujourd'hui » au fuseau de la société, que l'écran du planning prend pour la semaine affichée.
  const { fuseauHoraire } = await envoyer('get', '/company') as { fuseauHoraire?: string | null };
  const parties = new Intl.DateTimeFormat('en-GB', { timeZone: fuseauHoraire || 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date());
  const partie = (type: string) => parties.find((p) => p.type === type)!.value;
  const aujourdhui = `${partie('year')}-${partie('month')}-${partie('day')}`;
  const compte = (cle: string): Promise<Compte> => envoyer('post', '/users', { email: `planning-t.${cle}.${suffixe}@iris.test`, name: `Technicien PT ${cle} ${suffixe}`, role: 'TECHNICIEN' });
  const technicien = await compte('relie');
  const collegue = await compte('collegue');
  const sansFiche = await compte('sans-fiche');
  const fiche = await envoyer('post', '/intervenants', { nom: `Fiche PT ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  const ficheCollegue = await envoyer('post', '/intervenants', { nom: `Fiche PT collègue ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  // Coéquipier d'une seule affectation libre, sur aucun chantier du technicien.
  const ficheCoequipier = await envoyer('post', '/intervenants', { nom: `Fiche PT coéquipier ${suffixe}`, role: 'Technicien', tauxHoraireCharge: 40 });
  await envoyer('put', `/intervenants/${fiche.id}/compte`, { userId: technicien.id });
  await envoyer('put', `/intervenants/${ficheCollegue.id}/compte`, { userId: collegue.id });
  const affectation = (titre: string, intervenantIds: string[]) => envoyer('post', '/planning/events', { categorie: 'HORS_CHANTIER', titre: `${titre} ${suffixe}`, dateDebut: aujourdhui, creneau: 'JOURNEE', intervenantIds });
  await affectation('Affectation PT', [fiche.id]);
  await affectation('Partagée PT', [ficheCollegue.id, fiche.id]);
  await affectation('Collègue PT', [ficheCollegue.id]);
  await affectation('Partage coéquipier PT', [ficheCoequipier.id, fiche.id]);
  await affectation('Coéquipier seul PT', [ficheCoequipier.id]);
  const client = await creerClient(`planning-t-${suffixe}`);
  const dossier = await envoyer('post', '/interventions', { clientId: client.id, titre: `Dépannage PT collègue ${suffixe}` });
  await envoyer('put', `/interventions/${dossier.id}/planning`, { dateDebut: aujourdhui, creneau: 'MATIN', intervenantIds: [ficheCollegue.id] });
  // Un chantier dont le technicien est titulaire, où le collègue est affecté.
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Chantier PT ${suffixe}`, lignes: [
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
  ] });
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };
  await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: technicien.id });
  await envoyer('post', '/planning/events', { categorie: 'CHANTIER', chantierId: chantier.id, dateDebut: aujourdhui, creneau: 'APRES_MIDI', intervenantIds: [ficheCollegue.id] });

  const page = await pageTelephone(browser, technicien);
  const fenetres: string[] = [];
  const requetes: string[] = [];
  page.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
  page.on('request', (requete) => requetes.push(requete.url()));
  try {
    const reponseEvenements = page.waitForResponse((reponse) => reponse.url().includes('/api/planning/events?'));
    await page.goto('/planning', { waitUntil: 'networkidle' });
    // Le serveur ne lui envoie que ses affectations et celles de son chantier : l'écran n'a rien à masquer.
    const evenements = await (await reponseEvenements).json() as Array<{ intervenants: Array<{ id: string }>; chantier: { id: string } | null }>;
    expect(evenements.length).toBeGreaterThan(0);
    expect(evenements.every((ev) => ev.intervenants.some((i) => i.id === fiche.id) || ev.chantier?.id === chantier.id), 'aucune affectation sans sa fiche ni son chantier').toBe(true);
    await expect(page.getByText('Consultation seule')).toBeVisible();
    await expect(page.getByText('Vous ne voyez que vos affectations et celles des chantiers dont vous êtes titulaire.')).toBeVisible();
    // Sa ligne d'abord, avec ses affectations, y compris celles qu'il partage ; puis celle du collègue,
    // qui porte l'affectation partagée et celle du chantier dont il est titulaire, et celle du
    // coéquipier, qui ne porte que leur affectation partagée.
    const lignes = page.locator('table tbody tr');
    await expect(lignes).toHaveCount(3);
    const ligneCollegue = lignes.filter({ has: page.getByText(`Fiche PT collègue ${suffixe}`, { exact: true }) });
    const ligneCoequipier = lignes.filter({ has: page.getByText(`Fiche PT coéquipier ${suffixe}`, { exact: true }) });
    await expect(lignes.nth(0).getByText(`Fiche PT ${suffixe}`, { exact: true })).toBeVisible();
    await expect(lignes.nth(0).getByText(`Affectation PT ${suffixe}`)).toBeVisible();
    await expect(lignes.nth(0).getByText(`Partagée PT ${suffixe}`)).toBeVisible();
    await expect(lignes.nth(0).getByText(`Partage coéquipier PT ${suffixe}`)).toBeVisible();
    await expect(lignes.nth(0).getByText(chantier.nom)).toHaveCount(0);
    await expect(ligneCollegue).toHaveCount(1);
    await expect(ligneCollegue.getByText(`Partagée PT ${suffixe}`)).toBeVisible();
    await expect(ligneCollegue.getByText(chantier.nom)).toBeVisible();
    await expect(ligneCoequipier).toHaveCount(1);
    await expect(ligneCoequipier.getByText(`Partage coéquipier PT ${suffixe}`)).toBeVisible();
    await expect(ligneCoequipier.getByText(chantier.nom)).toHaveCount(0);
    // Ni les autres affectations du collègue et du coéquipier, ni la projection du collègue.
    await expect(page.getByText(`Collègue PT ${suffixe}`)).toHaveCount(0);
    await expect(page.getByText(`Coéquipier seul PT ${suffixe}`)).toHaveCount(0);
    await expect(page.getByText(`Dépannage PT collègue ${suffixe}`)).toHaveCount(0);
    await expect(page.getByText('Aucune fiche intervenant n\'est reliée à votre compte', { exact: false })).toHaveCount(0);
    // La liste des chantiers, qui ne sert qu'au formulaire d'affectation, n'est pas demandée.
    expect(requetes.filter((url) => url.includes('/api/planning/chantiers'))).toEqual([]);
    // La grille défile dans son cadre : la page ne déborde pas de l'écran.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Semaine suivante illisible (panne) : les lignes des collègues ne reprennent pas celles de la
    // semaine quittée ; il ne reste que la sienne.
    await page.route('**/api/planning/events?**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'panne' }) }));
    const lectureSuivante = page.waitForResponse((reponse) => reponse.url().includes('/api/planning/events?'));
    await page.getByTitle('Semaine suivante').click();
    await lectureSuivante;
    await expect(lignes).toHaveCount(1);
    await expect(lignes.nth(0).getByText(`Fiche PT ${suffixe}`, { exact: true })).toBeVisible();
    await page.unroute('**/api/planning/events?**');

    // Sans fiche reliée, aucune grille : un message l'explique.
    const vueSansFiche = await pageTelephone(browser, sansFiche);
    try {
      vueSansFiche.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
      vueSansFiche.on('request', (requete) => requetes.push(requete.url()));
      await vueSansFiche.goto('/planning', { waitUntil: 'networkidle' });
      await expect(vueSansFiche.getByText('Aucune fiche intervenant n\'est reliée à votre compte.', { exact: true })).toBeVisible();
      await expect(vueSansFiche.getByText('Vos affectations s\'afficheront dès que l\'administration l\'aura reliée ; celles des chantiers dont vous êtes titulaire apparaissent ici lorsqu\'il y en a cette semaine.', { exact: true })).toBeVisible();
      await expect(vueSansFiche.getByText('seules les affectations des chantiers dont vous êtes titulaire s\'affichent', { exact: false })).toHaveCount(0);
      await expect(vueSansFiche.locator('table')).toHaveCount(0);
      await expect(vueSansFiche.getByText('Aucun technicien enregistré.')).toHaveCount(0);
      expect(requetes.filter((url) => url.includes('/api/planning/chantiers'))).toEqual([]);
      // Affectations illisibles (panne) : le message s'affiche, sans rester sur le chargement.
      await vueSansFiche.route('**/api/planning/events?**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'panne' }) }));
      await vueSansFiche.reload({ waitUntil: 'networkidle' });
      await expect(vueSansFiche.getByText('Aucune fiche intervenant n\'est reliée à votre compte.', { exact: true })).toBeVisible();
      await expect(vueSansFiche.getByText('Chargement des affectations…', { exact: true })).toHaveCount(0);
      await vueSansFiche.unroute('**/api/planning/events?**');

      // Devenu titulaire du chantier, il en voit l'affectation et la ligne du collègue, sans la sienne.
      await envoyer('patch', `/chantiers/${chantier.id}`, { responsableId: sansFiche.id });
      // Tant que ses affectations ne sont pas arrivées, l'écran l'indique, sans conclure à une fiche absente.
      // Toutes les lectures sont retenues : l'écran relit la semaine une fois le fuseau de la société connu.
      let liberer = () => {};
      const retenue = new Promise<void>((resolve) => { liberer = resolve; });
      await vueSansFiche.route('**/api/planning/events?**', async (route) => { await retenue; await route.continue(); });
      await vueSansFiche.reload();
      await expect(vueSansFiche.getByText('Chargement des affectations…', { exact: true })).toBeVisible();
      await expect(vueSansFiche.getByText('Aucune fiche intervenant n\'est reliée à votre compte', { exact: false })).toHaveCount(0);
      liberer();
      await expect(vueSansFiche.getByText('Chargement des affectations…', { exact: true })).toHaveCount(0);
      await vueSansFiche.unroute('**/api/planning/events?**');
      await expect(vueSansFiche.getByText('Aucune fiche intervenant n\'est reliée à votre compte : seules les affectations des chantiers dont vous êtes titulaire s\'affichent.')).toBeVisible();
      await expect(vueSansFiche.getByText('Aucune fiche intervenant n\'est reliée à votre compte.', { exact: true })).toHaveCount(0);
      await expect(vueSansFiche.locator('table tbody tr')).toHaveCount(1);
      await expect(vueSansFiche.getByText(`Fiche PT collègue ${suffixe}`, { exact: true })).toBeVisible();
      await expect(vueSansFiche.getByText(chantier.nom)).toBeVisible();
      await expect(vueSansFiche.getByText(`Collègue PT ${suffixe}`)).toHaveCount(0);
      await expect(vueSansFiche.getByText(`Partagée PT ${suffixe}`)).toHaveCount(0);
      await expect(vueSansFiche.getByText(`Fiche PT ${suffixe}`, { exact: true })).toHaveCount(0);
    } finally {
      await vueSansFiche.context().close();
    }

    // Équipe illisible (panne du serveur) : l'écran le dit, sans prétendre que la fiche n'est pas reliée.
    const vuePanne = await pageTelephone(browser, technicien);
    try {
      vuePanne.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
      await vuePanne.route('**/api/intervenants', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'panne' }) }));
      await vuePanne.goto('/planning', { waitUntil: 'networkidle' });
      await expect(vuePanne.getByRole('alert').filter({ hasText: 'Lecture de l\'équipe impossible pour le moment.' })).toBeVisible();
      await expect(vuePanne.getByText('Aucune fiche intervenant n\'est reliée à votre compte.')).toHaveCount(0);
      await expect(vuePanne.locator('table')).toHaveCount(0);
    } finally {
      await vuePanne.context().close();
    }

    // Témoin : l'administration garde toute l'équipe et toutes les affectations.
    pageAdmin.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
    const vueAdmin = await allerSurPageAdmin('/planning');
    await expect(vueAdmin.getByText(`Fiche PT collègue ${suffixe}`, { exact: true })).toBeVisible();
    await expect(vueAdmin.getByText(`Fiche PT ${suffixe}`, { exact: true })).toBeVisible();
    await expect(vueAdmin.getByText(`Collègue PT ${suffixe}`)).toBeVisible();
    await expect(vueAdmin.getByText(`Dépannage PT collègue ${suffixe}`)).toBeVisible();
    await expect(vueAdmin.getByText('Vous ne voyez que vos affectations et celles des chantiers dont vous êtes titulaire.')).toHaveCount(0);
    expect(fenetres).toEqual([]);
  } finally {
    await page.context().close();
  }
});
