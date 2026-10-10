import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

const api = `http://127.0.0.1:${process.env.E2E_API_PORT || '3001'}/api`;
const jetonSecours = 'jeton-de-secours-e2e-au-moins-32-caracteres';
type Session = { token: string; user: unknown };

const headers = (token: string) => ({ Authorization: `Bearer ${token}` });

async function ouvrirSession(request: APIRequestContext): Promise<Session> {
  const response = await request.post(`${api}/auth/secours`, { data: { token: jetonSecours } });
  expect(response.ok(), `accès de secours refusé : ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

// Prépare les prérequis bloquants, de façon idempotente, afin que les tests portent sur
// le parcours UI plutôt que sur une configuration manquante de la base jetable.
async function preparerFacturation(request: APIRequestContext, token: string) {
  const auth = headers(token);
  const compte = async (code: string, libelle: string, nature: string) => {
    await request.post(`${api}/comptabilite/comptes`, { headers: auth, data: { code, libelle, nature } });
    const plan = await (await request.get(`${api}/comptabilite`, { headers: auth })).json();
    const trouve = plan.comptes.find((item: { code: string }) => item.code === code);
    expect(trouve, `compte ${code} absent`).toBeTruthy();
    return trouve as { id: string };
  };
  const client = await compte('411000', 'Clients E2E', 'ACTIF');
  const prestations = await compte('706000', 'Prestations E2E', 'PRODUIT');
  const articles = await compte('707000', 'Articles E2E', 'PRODUIT');
  const tva = await compte('445710', 'TVA collectée E2E', 'TVA');
  for (const [cle, data] of [
    ['CLIENT', { compteId: client.id }],
    ['VENTE_PRESTATION', { compteId: prestations.id }],
    ['VENTE_ARTICLE', { compteId: articles.id }],
    ['JOURNAL_VENTES', { journal: 'VE' }],
  ] as const) {
    const actuel = (await (await request.get(`${api}/comptabilite`, { headers: auth })).json()).regles.find((r: { cle: string }) => r.cle === cle);
    if (actuel && (cle === 'JOURNAL_VENTES' ? actuel.journal === 'VE' : actuel.compteId === (data as { compteId?: string }).compteId)) continue;
    const version = actuel ? { expectedValeur: cle === 'JOURNAL_VENTES' ? actuel.journal : actuel.compteId, expectedUpdatedAt: actuel.updatedAt } : {};
    const response = await request.put(`${api}/comptabilite/regles/${cle}`, { headers: auth, data: { ...data, ...version, motif: actuel ? 'Réinitialisation de la fixture E2E' : 'Création de la fixture E2E' } });
    expect(response.ok(), `règle ${cle} : ${response.status()}`).toBeTruthy();
  }
  for (const taux of [20, 10]) {
    const existante = (await (await request.get(`${api}/comptabilite`, { headers: auth })).json()).reglesTva.find((r: { taux: number }) => r.taux === taux);
    if (existante?.compteId === tva.id) continue;
    const response = await request.put(`${api}/comptabilite/tva/${taux}`, { headers: auth, data: { compteId: tva.id, motif: existante ? 'Réinitialisation de la fixture E2E' : 'Création de la fixture E2E', ...(existante ? { expectedCompteId: existante.compteId, expectedUpdatedAt: existante.updatedAt } : {}) } });
    expect(response.ok(), `TVA ${taux} : ${response.status()}`).toBeTruthy();
  }
  const versions = await (await request.get(`${api}/mentions-legales`, { headers: auth })).json();
  if (!versions.some((version: { actif: boolean; publieeLe: string | null }) => version.actif && version.publieeLe)) {
    const created = await request.post(`${api}/mentions-legales`, { headers: auth, data: { mentions: 'IRIS E2E — 1 rue des Tests, 14000 Caen', cgv: 'CGV de parcours', penalites: 'Pénalités de parcours' } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { version } = await created.json();
    expect((await request.post(`${api}/mentions-legales/${version}/publier`, { headers: auth })).ok()).toBeTruthy();
  }
}

async function creerClient(request: APIRequestContext, token: string, libelle: string, avecSite: boolean) {
  const raisonSociale = `E2E ${libelle} ${Date.now()}`;
  const response = await request.post(`${api}/clients`, { headers: headers(token), data: { raisonSociale } });
  expect(response.status(), await response.text()).toBe(201);
  const { id } = await response.json() as { id: string };
  if (avecSite) {
    const site = await request.post(`${api}/clients/${id}/sites`, { headers: headers(token), data: { nom: 'Facturation', adresse: '2 rue du Parcours', codePostal: '14000', ville: 'Caen', estSiteFacturation: true } });
    expect(site.status(), await site.text()).toBe(201);
  }
  return { id, raisonSociale };
}

export function dateDuJour() {
  // La base E2E conserve le fuseau entreprise par défaut (Europe/Paris).
  // Le fuseau du processus Node peut être UTC ou différent de celui de l'entreprise.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const valeur = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${valeur('day')}-${valeur('month')}-${valeur('year')}`;
}

type Outils = {
  session: Session;
  allerSurPageAdmin: (path: string) => Promise<Page>;
  creerClient: (libelle: string, avecSite?: boolean) => Promise<{ id: string; raisonSociale: string }>;
  apiAdmin: { get: (path: string) => ReturnType<APIRequestContext['get']> };
};

export const test = base.extend<Outils>({
  session: async ({ request }, fournir) => {
    const session = await ouvrirSession(request);
    await preparerFacturation(request, session.token);
    await fournir(session);
  },
  allerSurPageAdmin: async ({ page, session }, fournir) => {
    await fournir(async (path: string) => {
      await page.addInitScript(([token, user]) => {
        localStorage.setItem('token', token as string);
        localStorage.setItem('user', user as string);
      }, [session.token, JSON.stringify(session.user)]);
      await page.goto(path, { waitUntil: 'networkidle' });
      return page;
    });
  },
  creerClient: async ({ request, session }, fournir) => {
    await fournir((libelle: string, avecSite = true) => creerClient(request, session.token, libelle, avecSite));
  },
  apiAdmin: async ({ request, session }, fournir) => {
    await fournir({ get: (path: string) => request.get(`${api}${path}`, { headers: headers(session.token) }) });
  },
});

export { expect };
