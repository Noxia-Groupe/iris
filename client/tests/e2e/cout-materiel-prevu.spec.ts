import { createHmac } from 'node:crypto';
import { test, expect } from './fixtures';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;

// Lot « budget et heures prévues du chantier », PR 1 (décision de Nelson de la nuit du 26 au 27-10-2026, point 15 :
// « oui ca alimente forcément le budget » ; réponse du 30-10-2026 : une fourniture sans prix d'achat prévu compte pour
// « Zéro ») : sur la fiche d'un chantier ouvert depuis un devis, la marge estimée part du coût d'achat prévu au devis,
// montant compris pour l'administration, sans montant pour le conducteur, qui ne lit pas les prix d'achat prévus.

const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString('base64url');
function jetonPour(userId: string) {
  const corps = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ id: userId })}`;
  return `${corps}.${createHmac('sha256', 'secret-e2e-uniquement').update(corps).digest('base64url')}`;
}

test('fiche chantier : la marge estimée part du coût d’achat prévu au devis, avec son montant pour l’administration seule', async ({ session, request, creerClient, allerSurPageAdmin, browser }) => {
  const envoyer = async (methode: 'post' | 'put' | 'patch', path: string, data?: object) => {
    const response = await request[methode](`${api}${path}`, { headers: { Authorization: `Bearer ${session.token}` }, data });
    expect(response.ok(), `${path} : ${await response.text()}`).toBeTruthy();
    return response.json();
  };
  const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const client = await creerClient(`coût prévu ${suffixe}`);
  const conducteur = await envoyer('post', '/users', { email: `cout-prevu.cond.${suffixe}@iris.test`, name: `Conducteur ${suffixe}`, role: 'CONDUCTEUR_TRAVAUX' }) as { id: string; name: string; email: string; role: string };
  const devis = await envoyer('post', '/devis', { clientId: client.id, objet: `Affaire coût prévu ${suffixe}`, lignes: [
    { designation: 'Caméra', nature: 'FOURNITURE', quantite: 3, prixUnitaireHt: 50, tauxTva: 20, prixAchatUnitaireHt: '30.40' },
    { designation: 'Visserie', nature: 'FOURNITURE', quantite: 2, prixUnitaireHt: 5, tauxTva: 20 },
    { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 150, tauxTva: 20 },
  ] }) as { id: string };
  await envoyer('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
  await envoyer('post', `/devis/${devis.id}/signature`, { signataire: 'Client E2E', confirme: true });
  const chantier = await envoyer('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', responsableId: conducteur.id }) as { id: string; coutMaterielPrevu: number };
  expect(chantier.coutMaterielPrevu).toBe(91.2);

  // Administration : le coût d'achat prévu, avec son montant (3 × 30,40 €, la visserie sans prix d'achat comptant pour zéro).
  const page = await allerSurPageAdmin(`/chantiers/${chantier.id}`);
  const estimation = page.locator('[data-estimation]');
  await expect(estimation).toContainText('coût d’achat prévu au devis (91,2 € HT), une fourniture sans prix d’achat prévu comptant pour zéro.');

  // Conducteur titulaire : la même hypothèse, sans montant, ni dans l'hypothèse ni dans le matériel attendu.
  const contexte = await browser.newContext();
  const vueConducteur = await contexte.newPage();
  await vueConducteur.addInitScript(([token, user]) => {
    localStorage.setItem('token', token as string);
    localStorage.setItem('user', user as string);
  }, [jetonPour(conducteur.id), JSON.stringify({ ...conducteur, permissions: ['chantiers:read', 'clients:read'] })]);
  await vueConducteur.goto(`/chantiers/${chantier.id}`, { waitUntil: 'networkidle' });
  const vue = vueConducteur.locator('[data-estimation]');
  await expect(vue.locator('li', { hasText: 'Matériel attendu' })).toHaveText('Matériel attendu : coût d’achat prévu au devis, une fourniture sans prix d’achat prévu comptant pour zéro.');
  await expect(vue).not.toContainText('€ HT)');
  await contexte.close();
});
