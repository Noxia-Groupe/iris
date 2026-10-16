import type { Route } from '@playwright/test';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// #111 : la liste Clients annonce qu'elle s'arrête aux 200 premiers clients, retrouve les autres par
// la recherche, et n'affiche que la réponse de la dernière recherche.
test('#111 : liste Clients limitée à 200, client suivant retrouvé par la recherche', async ({ allerSurPageAdmin, request, session }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const prefixe = `ZZZ E2E 111 liste ${Date.now()}`;
  const creer = async (raisonSociale: string) => {
    const reponse = await request.post(`${api}/clients`, { headers, data: { raisonSociale } });
    expect(reponse.status(), await reponse.text()).toBe(201);
    return (await reponse.json()) as { id: string; raisonSociale: string };
  };
  const cible = await creer(`${prefixe} cible`);
  const autre = await creer(`${prefixe} autre`);
  // 200 clients d'un même lot, tous classés avant la cible : elle sort de la liste initiale, quelle
  // que soit la base E2E (vierge ou conservée), et la recherche du lot atteint la limite.
  const lot = `E2E 111 liste lot ${Date.now()}`;
  for (let i = 0; i < 200; i += 20) {
    const reponses = await Promise.all(Array.from({ length: 20 }, (_, j) =>
      request.post(`${api}/clients`, { headers, data: { raisonSociale: `${lot} ${String(i + j).padStart(3, '0')}` } })));
    for (const reponse of reponses) expect(reponse.status(), await reponse.text()).toBe(201);
  }
  // Témoin : sans recherche, l'API ne renvoie pas la cible.
  const initiale = (await (await request.get(`${api}/clients`, { headers })).json()) as { clients: Array<{ id: string }> };
  expect(initiale.clients).toHaveLength(200);
  expect(initiale.clients.some((c) => c.id === cible.id)).toBe(false);

  const page = await allerSurPageAdmin('/clients');
  const recherche = page.getByRole('searchbox', { name: 'Rechercher un client' });
  const limite = page.getByRole('status', { name: 'Limite des résultats clients' });
  const lignes = page.getByRole('list', { name: 'Liste des clients' }).getByRole('listitem');
  const lienCible = page.getByRole('link', { name: new RegExp(cible.raisonSociale) });

  // 1. Sans recherche : 200 clients listés, la limite est annoncée, et la cible n'y est pas.
  await expect(lignes).toHaveCount(200);
  await expect(limite).toHaveText('Seuls les 200 premiers clients sont listés, par raison sociale : recherchez les autres par leur nom ou leur SIREN.');
  await expect(lienCible).toHaveCount(0);

  // Requêtes de recherche émises par la page (paramètre q présent).
  const recherchesEmises: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.endsWith('/api/clients') && r.method() === 'GET' && url.searchParams.has('q')) recherchesEmises.push(url.searchParams.get('q') || '');
  });
  // Réponse d'une recherche retenue jusqu'à libération : elle arrive après la recherche suivante.
  const retenir = async (q: string, repondre: (route: Route) => Promise<void>) => {
    let liberer!: () => void;
    const attente = new Promise<void>((resolve) => { liberer = resolve; });
    await page.route((url) => url.pathname.endsWith('/api/clients') && url.searchParams.get('q') === q, async (route) => { await attente; await repondre(route); });
    return liberer;
  };
  // Pendant 400 ms, la page garde le résultat de la dernière recherche et n'affiche pas le texte périmé.
  const surveiller = (attendu: string, interdit: string) => page.evaluate(async ({ attendu, interdit }) => {
    const fin = performance.now() + 400;
    while (performance.now() < fin) {
      const texte = document.body.textContent || '';
      if (texte.includes(interdit) || !texte.includes(attendu)) throw new Error('Réponse périmée appliquée après la dernière recherche');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, { attendu, interdit });

  // 2. Une frappe continue ne lance qu'une recherche, 250 ms après la dernière touche, et elle
  //    retrouve la cible ; avec un seul résultat, plus d'annonce de limite.
  recherchesEmises.length = 0;
  await recherche.pressSequentially(cible.raisonSociale, { delay: 20 });
  await expect(lignes).toHaveCount(1);
  await expect(lienCible).toBeVisible();
  await expect(limite).toHaveText('');
  // Une machine de CI chargée peut espacer deux touches de plus de 250 ms : on tolère deux
  // recherches intermédiaires, loin d'une recherche par touche.
  expect(recherchesEmises.length, JSON.stringify(recherchesEmises)).toBeLessThanOrEqual(3);
  expect(recherchesEmises.at(-1)).toBe(cible.raisonSociale);

  // 3. Une recherche de 200 résultats annonce la limite de la recherche.
  await recherche.fill(lot);
  await expect(limite).toHaveText('200 clients maximum affichés ; veuillez affiner votre recherche.');
  await expect(lignes).toHaveCount(200);

  // 4. La réponse d'une recherche précédente, arrivée après la dernière, est ignorée.
  const lente = `${prefixe} autre`;
  const libererLente = await retenir(lente, (route) => route.continue());
  const reponseLente = page.waitForResponse((r) => new URL(r.url()).searchParams.get('q') === lente);
  await recherche.fill(lente);
  await expect.poll(() => recherchesEmises.includes(lente)).toBe(true);
  await recherche.fill(cible.raisonSociale);
  await expect(lienCible).toBeVisible();
  libererLente();
  await (await reponseLente).finished();
  await surveiller(cible.raisonSociale, autre.raisonSociale);
  await expect(lignes).toHaveCount(1);

  // 5. L'échec d'une recherche précédente, arrivé après la dernière, est ignoré lui aussi.
  const enEchec = `${prefixe} échec périmé`;
  const libererEchec = await retenir(enEchec, (route) => route.fulfill({ status: 503, json: { error: 'Erreur périmée liste 111' } }));
  const reponseEchec = page.waitForResponse((r) => new URL(r.url()).searchParams.get('q') === enEchec);
  await recherche.fill(enEchec);
  await expect.poll(() => recherchesEmises.includes(enEchec)).toBe(true);
  await recherche.fill(cible.raisonSociale);
  await expect(lienCible).toBeVisible();
  libererEchec();
  await (await reponseEchec).finished();
  await surveiller(cible.raisonSociale, 'Erreur périmée liste 111');

  // 6. Une recherche en échec remplace la liste par l'erreur, sans annonce de limite ; la
  //    recherche suivante efface l'erreur.
  const enPanne = `${prefixe} panne`;
  await page.route((url) => url.pathname.endsWith('/api/clients') && url.searchParams.get('q') === enPanne, (route) => route.fulfill({ status: 503, json: { error: 'Recherche indisponible liste 111' } }));
  await recherche.fill(enPanne);
  await expect(page.getByRole('alert').filter({ hasText: 'Recherche indisponible liste 111' })).toBeVisible();
  await expect(lignes).toHaveCount(0);
  await expect(limite).toHaveText('');
  await recherche.fill(lot);
  await expect(lignes).toHaveCount(200);
  await expect(page.getByText('Recherche indisponible liste 111')).toHaveCount(0);
  await expect(limite).toHaveText('200 clients maximum affichés ; veuillez affiner votre recherche.');

  // 7. Une recherche faite d'espaces vaut une recherche vide : liste initiale et message initial.
  await recherche.fill('   ');
  await expect(lignes).toHaveCount(200);
  await expect(limite).toHaveText(/^Seuls les 200 premiers clients sont listés/);
  await expect(lienCible).toHaveCount(0);

  // 8. Effacer une recherche revient à la liste initiale, toujours annoncée comme limitée.
  await recherche.fill(lot);
  await expect(limite).toHaveText(/maximum/);
  await recherche.fill('');
  await expect(lignes).toHaveCount(200);
  await expect(limite).toHaveText(/^Seuls les 200 premiers clients sont listés/);

  // 9. Une création refusée affiche son erreur sans masquer la liste ni son annonce.
  await page.route((url) => url.pathname.endsWith('/api/clients'), (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, json: { error: 'Création refusée liste 111' } })
    : route.fallback());
  await page.getByRole('button', { name: 'Nouveau client' }).click();
  await page.getByLabel('Raison sociale').fill(`${prefixe} refusé`);
  await page.getByRole('button', { name: 'Créer la fiche' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Création refusée liste 111' })).toBeVisible();
  await expect(lignes).toHaveCount(200);
  await expect(limite).toHaveText(/^Seuls les 200 premiers clients sont listés/);
});
