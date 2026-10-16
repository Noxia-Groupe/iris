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

  // 2. La recherche retrouve la cible ; avec un seul résultat, plus d'annonce de limite.
  await recherche.fill(cible.raisonSociale);
  await expect(lignes).toHaveCount(1);
  await expect(lienCible).toBeVisible();
  await expect(limite).toHaveCount(0);

  // 3. Une recherche de 200 résultats annonce la limite de la recherche.
  await recherche.fill(lot);
  await expect(limite).toHaveText('200 clients maximum affichés ; veuillez affiner votre recherche.');
  await expect(lignes).toHaveCount(200);

  // 4. Une réponse lente d'une recherche précédente ne remplace pas la dernière.
  const lente = `${prefixe} autre`;
  await page.route((url) => url.pathname.endsWith('/api/clients') && url.searchParams.get('q') === lente, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {});
  });
  const requeteLente = page.waitForRequest((r) => new URL(r.url()).searchParams.get('q') === lente);
  const reponseLente = page.waitForResponse((r) => new URL(r.url()).searchParams.get('q') === lente);
  await recherche.fill(lente);
  await requeteLente;
  await recherche.fill(cible.raisonSociale);
  await expect(lienCible).toBeVisible();
  await (await reponseLente).finished();
  // Laisse au navigateur le temps de traiter la réponse lente avant de vérifier qu'elle est ignorée.
  await page.waitForTimeout(300);
  await expect(lignes).toHaveCount(1);
  await expect(lienCible).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(autre.raisonSociale) })).toHaveCount(0);

  // 5. Effacer la recherche revient à la liste initiale, toujours annoncée comme limitée.
  await recherche.fill('');
  await expect(lignes).toHaveCount(200);
  await expect(limite).toHaveText(/^Seuls les 200 premiers clients sont listés/);
});
