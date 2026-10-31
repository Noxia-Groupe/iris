import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot P0 (décision de Nelson du 21-10-2026) : Iris est ouvert à toutes les entreprises. Les pages
// ouvertes sans connexion portent le nom de l'application, l'icône et les couleurs sont celles de
// l'application, et le rapport de chantier sort au format A4.
test('la connexion et le planning public portent le nom de l’application, sans nom de société', async ({ browser, request, session }) => {
  const headers = { Authorization: `Bearer ${session.token}` };
  const contexte = await browser.newContext();
  const fenetres: string[] = [];
  try {
    const page = await contexte.newPage();
    page.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
    await page.goto('/login', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'IRIS', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/n[oø]xia/i);
    // Icône et couleur de l'application.
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', '/icone.svg');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1e3a8a');
    const icone = await page.request.get('/icone.svg');
    expect(icone.ok()).toBeTruthy();
    expect(await icone.text()).toContain('<svg');
    const manifeste = await (await page.request.get('/manifest.webmanifest')).json() as { name: string; theme_color: string; description: string };
    expect(manifeste).toMatchObject({ name: 'Iris', theme_color: '#1e3a8a', description: 'ERP pour métiers techniques' });
    // Les icônes PNG (Safari, écran d'accueil d'iOS, manifeste) sont celles de l'application : fond
    // #1e3a8a pris près du bord gauche, à mi-hauteur.
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
    for (const icone of ['/icon-192.png', '/apple-touch-icon.png', '/favicon-32x32.png']) {
      const pixel = await page.evaluate(async (src) => {
        const image = new Image(); image.src = src; await image.decode();
        const toile = document.createElement('canvas'); toile.width = image.width; toile.height = image.height;
        const contexte = toile.getContext('2d')!; contexte.drawImage(image, 0, 0);
        return Array.from(contexte.getImageData(Math.floor(image.width / 20) + 1, Math.floor(image.height / 2), 1, 1).data);
      }, icone);
      expect(pixel.slice(0, 3), icone).toEqual([30, 58, 138]);
    }

    // Planning public, ouvert par son lien sans connexion.
    const partage = await request.post(`${api}/planning/share`, { headers });
    expect(partage.ok(), await partage.text()).toBeTruthy();
    const { token } = await partage.json() as { token: string };
    await page.goto(`/planning/public/${token}`, { waitUntil: 'networkidle' });
    await expect(page.getByText('IRIS — lecture seule', { exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/n[oø]xia/i);
    expect(fenetres).toEqual([]);
  } finally {
    await contexte.close();
  }
});

test('le rapport de chantier se télécharge au format A4', async ({ request, session, creerClient, allerSurPageAdmin, page }) => {
  test.slow();
  const headers = { Authorization: `Bearer ${session.token}` };
  const envoyer = async (methode: 'post' | 'put', path: string, data: object) => {
    const reponse = await request[methode](`${api}${path}`, { headers, data });
    expect(reponse.ok(), `${path} : ${await reponse.text()}`).toBeTruthy();
    return reponse.json();
  };
  const client = await creerClient('rapport-a4');
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Rapport A4 E2E ${Date.now()}`, lignes: [
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
  ] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER' }) as { id: string; nom: string };

  const fenetres: string[] = [];
  page.on('dialog', (dialogue) => { fenetres.push(`${dialogue.type()} : ${dialogue.message()}`); void dialogue.dismiss(); });
  const fiche = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  await expect(fiche.getByRole('heading', { name: chantier.nom })).toBeVisible();
  const telechargement = fiche.waitForEvent('download');
  // Lot 6a-4c (cadrage, « Écran ») : la capture de la fiche s'appelle désormais « Rapport interne (PDF) ».
  await fiche.getByRole('button', { name: 'Rapport interne (PDF)', exact: true }).click();
  const fichier = await (await telechargement).path();
  const contenu = readFileSync(fichier, 'latin1');
  // A4 : 595,28 × 841,89 points ; le format américain (letter) ferait 612 × 792.
  const formats = [...contenu.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(([, largeur, hauteur]) => [Number(largeur), Number(hauteur)]);
  expect(formats.length).toBeGreaterThan(0);
  for (const [largeur, hauteur] of formats) {
    expect(largeur).toBeCloseTo(595.28, 1);
    expect(hauteur).toBeCloseTo(841.89, 1);
  }
  expect(fenetres).toEqual([]);
});
