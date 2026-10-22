import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { test, expect, choisirClient, dateDuJour } from './fixtures';

// Lot 6a-1 (option B de P5, décision de Nelson du 22-10-2026) : le logo et l'identité de la
// société sont copiés sur chaque pièce à son émission ; les changer ensuite ne change pas les
// pièces déjà émises.
const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

const crc32 = (octets: Buffer) => {
  let crc = 0xffffffff;
  for (const octet of octets) { crc ^= octet; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
};
const morceau = (type: string, donnees: Buffer) => {
  const longueur = Buffer.alloc(4); longueur.writeUInt32BE(donnees.length);
  const corps = Buffer.concat([Buffer.from(type, 'latin1'), donnees]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(corps));
  return Buffer.concat([longueur, corps, crc]);
};
// Petit PNG valide (RGBA, 24 × 12) : une bande de la couleur demandée.
const logoPng = (rouge: number) => {
  const entete = Buffer.alloc(13); entete.writeUInt32BE(24, 0); entete.writeUInt32BE(12, 4); entete[8] = 8; entete[9] = 6;
  const pixels: number[] = [];
  for (let y = 0; y < 12; y++) { pixels.push(0); for (let x = 0; x < 24; x++) pixels.push(rouge, 80, 160, 255); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), morceau('IHDR', entete), morceau('IDAT', deflateSync(Buffer.from(pixels))), morceau('IEND', Buffer.alloc(0))]);
};

// Ligne d'une facture du client, cherchée de page en page depuis la première (comme facturation.spec.ts).
async function ligneFacture(page: Page, raisonSociale: string) {
  const ligne = page.locator('tbody tr', { hasText: raisonSociale }).filter({ hasText: 'Facture' });
  await expect(page.getByTestId('pagination-factures')).toContainText('document(s)');
  await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  const precedente = page.getByRole('button', { name: 'Page précédente' });
  while (await precedente.isEnabled()) {
    await precedente.click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  while (!(await ligne.count())) {
    const suivante = page.getByRole('button', { name: 'Page suivante' });
    expect(await suivante.isEnabled(), `facture ${raisonSociale} absente de la pagination`).toBeTruthy();
    await suivante.click();
    await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
  }
  return ligne;
}

test.describe('Logo et identité de l’émetteur figés sur les pièces', () => {
  test('Société : le super administrateur téléverse, voit et retire le logo ; un fichier refusé est expliqué ; le journal le garde', async ({ allerSurPageAdmin, session, request }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    expect((await request.delete(`${api}/company/logo`, { headers })).ok()).toBeTruthy();
    const page = await allerSurPageAdmin('/societe');
    const section = page.getByRole('region', { name: 'Logo des documents' });
    await expect(section.getByText('Aucun logo')).toBeVisible();
    await expect(page.getByText(/Raison sociale, SIRET, adresse, code postal et ville sont exigés pour émettre une facture/)).toBeVisible();
    await expect(page.getByText('URL du logo')).toHaveCount(0);

    const champ = section.locator('input[type="file"]');
    // Le champ de fichier, masqué, s'atteint au clavier ; son libellé, qui lui sert de bouton, en montre le focus.
    await expect(champ).toHaveAccessibleName('Choisir un logo');
    let atteint = false;
    for (let essai = 0; essai < 80 && !atteint; essai++) {
      await page.keyboard.press('Tab');
      atteint = await champ.evaluate((element) => element === document.activeElement);
    }
    expect(atteint, 'champ du logo inaccessible au clavier').toBe(true);
    await expect(section.locator('label').filter({ has: page.locator('input[type="file"]') })).not.toHaveCSS('box-shadow', 'none');
    // Un fichier qui n'est pas une image est refusé par l'écran, sans être envoyé.
    let envois = 0;
    page.on('request', (requete) => { if (requete.method() === 'PUT' && requete.url().endsWith('/api/company/logo')) envois += 1; });
    await champ.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('pas une image') });
    await expect(section.getByRole('alert')).toHaveText('Le logo doit être un fichier PNG ou JPEG.');
    expect(envois).toBe(0);
    await champ.setInputFiles({ name: 'casse.png', mimeType: 'image/png', buffer: Buffer.concat([logoPng(10).subarray(0, 33), Buffer.from('corrompu')]) });
    await expect(section.getByRole('alert')).toContainText('illisible');
    await expect(section.getByText('Aucun logo')).toBeVisible();

    await champ.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logoPng(200) });
    await expect(section.getByRole('status')).toHaveText('Logo enregistré. Il sera copié sur les prochaines pièces émises.');
    const image = section.getByRole('img', { name: 'Logo des documents' });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(24);
    await expect(section.getByText('Remplacer le logo')).toBeVisible();

    await section.getByRole('button', { name: 'Retirer le logo' }).click();
    await expect(section.getByRole('status')).toHaveText('Logo retiré. Les pièces déjà émises gardent le leur.');
    await expect(section.getByText('Aucun logo')).toBeVisible();

    await page.goto('/admin', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    const journal = page.getByRole('table', { name: 'Entrées du journal' });
    await expect(journal.locator('tr', { hasText: 'Logo des documents retiré' }).filter({ hasText: /Logo des documents : PNG, 1 Ko, empreinte [0-9a-f]{12}/ }).first()).toBeVisible();
  });

  test('une facture émise garde le logo et l’identité copiés, même après leur changement', async ({ allerSurPageAdmin, creerClient, apiAdmin, session, request }) => {
    const headers = { Authorization: `Bearer ${session.token}` };
    const societeAvant = await (await apiAdmin.get('/company')).json() as Record<string, string | null>;
    const nom = `Émetteur E2E ${Date.now()}`;
    try {
      expect((await request.put(`${api}/company`, { headers, data: { raisonSociale: nom, piedFacture: 'Pied de page E2E' } })).ok()).toBeTruthy();
      expect((await request.put(`${api}/company/logo`, { headers, data: { fichier: `data:image/png;base64,${logoPng(120).toString('base64')}` } })).ok()).toBeTruthy();
      const page = await allerSurPageAdmin('/prete-a-facturer');
      await expect(page.getByText('Identité de la société', { exact: true })).toBeVisible();
      await expect(page.getByText(/Raison sociale, SIRET, adresse, code postal et ville sont renseignés/)).toBeVisible();

      const client = await creerClient('émetteur figé');
      await page.goto('/factures', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /Nouvelle facture/ }).click();
      await choisirClient(page, client);
      await page.locator('input[name="motifHorsAffaire"]').fill('Parcours émetteur figé');
      await page.locator('input[name="dateEmission"]').fill(dateDuJour());
      await page.locator('input[name="dateEcheance"]').fill(dateDuJour());
      await page.locator('input[aria-label="Désignation ligne 1"]').fill('Prestation émetteur figé');
      await page.locator('input[aria-label="Prix unitaire HT ligne 1"]').pressSequentially('100');
      await page.getByRole('button', { name: /Créer le brouillon/ }).click();
      await expect(page.getByText(/Brouillon créé/)).toBeVisible();
      await expect(page.locator('tbody [role="status"]')).toHaveCount(0);
      const ligne = await ligneFacture(page, client.raisonSociale);
      await ligne.getByRole('button', { name: /Émettre/ }).click();
      await expect(page.getByText(/émise et figée/)).toBeVisible();

      const factures = await (await apiAdmin.get('/factures')).json() as Array<{ id: string; client: { id: string }; identiteEmetteurId: string | null }>;
      const facture = factures.find((item) => item.client.id === client.id);
      expect(facture?.identiteEmetteurId).toBeTruthy();
      const pdf = async () => {
        const reponse = await apiAdmin.get(`/factures/${facture!.id}/document.pdf`);
        expect(reponse.status()).toBe(200);
        return reponse.body();
      };
      expect((await pdf()).includes(Buffer.from('/Subtype /Image'))).toBe(true);

      // Logo retiré et nom changé après l'émission : la pièce n'en est pas changée.
      expect((await request.delete(`${api}/company/logo`, { headers })).ok()).toBeTruthy();
      expect((await request.put(`${api}/company`, { headers, data: { raisonSociale: `${nom} renommé` } })).ok()).toBeTruthy();
      expect((await pdf()).includes(Buffer.from('/Subtype /Image'))).toBe(true);
    } finally {
      await request.delete(`${api}/company/logo`, { headers });
      await request.put(`${api}/company`, { headers, data: { raisonSociale: societeAvant.raisonSociale ?? '', piedFacture: societeAvant.piedFacture ?? '' } });
    }
  });
});
