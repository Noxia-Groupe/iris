import { randomInt } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

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
  // Lot 6a-1 : une pièce ne s'émet qu'avec l'identité de la société, copiée à son émission. Seuls
  // les champs exigés et vides sont complétés : un parcours qui a changé le nom le garde.
  const societe = await (await request.get(`${api}/company`, { headers: auth })).json() as Record<string, string | null>;
  const identite = { raisonSociale: 'Société E2E', siret: '12345678900011', adresse: '1 rue des Tests', codePostal: '14000', ville: 'Caen' };
  const manquants = Object.fromEntries(Object.entries(identite).filter(([cle]) => !String(societe[cle] ?? '').trim()));
  if (Object.keys(manquants).length) {
    const maj = await request.put(`${api}/company`, { headers: auth, data: manquants });
    expect(maj.ok(), await maj.text()).toBeTruthy();
  }
}

// Lot 6a-2 bis : un devis ne se signe et une facture ne s'émet que pour un client identifié
// (raison sociale, adresse de facturation et SIREN, ou nom complet et adresse d'un particulier « pas
// de SIRET »). Le SIREN d'un client de parcours, unique en base, est tiré au hasard : un tirage déjà
// pris sur une base conservée (409) est retenté.
export const sirenAuHasard = () => String(randomInt(100_000_000, 1_000_000_000));
export async function creerClientAvecSiren(request: APIRequestContext, headersRequete: Record<string, string>, data: Record<string, unknown>) {
  for (let essai = 1; ; essai += 1) {
    const response = await request.post(`${api}/clients`, { headers: headersRequete, data: { ...data, siren: sirenAuHasard() } });
    if (response.status() === 409 && essai < 5) continue;
    expect(response.status(), await response.text()).toBe(201);
    return response.json() as Promise<{ id: string; raisonSociale: string; siren: string }>;
  }
}

async function creerClient(request: APIRequestContext, token: string, libelle: string, avecSite: boolean) {
  // Nom unique, sans rang imposé : sur une base qui a déjà servi, le client peut être au-delà
  // des 200 premiers ; un parcours le choisit donc par la recherche (choisirClient).
  const raisonSociale = `E2E ${libelle} ${Date.now()}`;
  // Client professionnel identifié : SIREN, et site de facturation sauf demande contraire.
  const { id } = await creerClientAvecSiren(request, headers(token), { raisonSociale });
  if (avecSite) {
    const site = await request.post(`${api}/clients/${id}/sites`, { headers: headers(token), data: { nom: 'Facturation', adresse: '2 rue du Parcours', codePostal: '14000', ville: 'Caen', estSiteFacturation: true } });
    expect(site.status(), await site.text()).toBe(201);
  }
  return { id, raisonSociale };
}

// Choisit un client comme un utilisateur : par la recherche du formulaire, puisqu'il peut être
// au-delà des 200 premiers de la liste initiale (#111).
export async function choisirClient(portee: Page | Locator, client: { id: string; raisonSociale: string }) {
  await portee.getByRole('searchbox', { name: 'Rechercher un client' }).fill(client.raisonSociale);
  const select = portee.locator('select[name="clientId"]');
  await expect(select.locator(`option[value="${client.id}"]`)).toHaveCount(1);
  await expect(select).toBeEnabled();
  await select.selectOption(client.id);
  await expect(select).toHaveValue(client.id);
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

// Millisecondes restant avant minuit, au fuseau de l'entreprise (Europe/Paris, comme dateDuJour).
export function avantMinuit(maintenant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(maintenant);
  const valeur = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return 86_400_000 - (((valeur('hour') * 60 + valeur('minute')) * 60 + valeur('second')) * 1000 + maintenant.getMilliseconds());
}

// Un parcours qui prépare ses données pour le jour même ne doit pas chevaucher minuit (#366) : s'il reste
// moins que son délai avant minuit, il attend que minuit soit passé, et son délai s'allonge d'autant. Il ne
// peut durer plus que son délai : il se déroule alors tout entier dans un même jour.
export async function horsDuPassageDeMinuit() {
  const info = base.info();
  const attente = avantMinuit();
  if (attente >= info.timeout) return;
  info.setTimeout(info.timeout + attente + 1_000);
  await new Promise((resolve) => setTimeout(resolve, attente + 1_000));
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
