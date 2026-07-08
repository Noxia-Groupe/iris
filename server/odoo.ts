// Intégration Odoo Online (LECTURE SEULE) : recherche de contacts (res.partner) pour
// préremplir le champ "Client" d'un chantier. Configuration optionnelle via les
// variables ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY (cf. .env.example).
//
// Si la config est absente, si Odoo est injoignable, ou si le client recherché n'existe
// pas côté Odoo, la recherche est simplement indisponible : l'utilisateur reste libre de
// saisir le nom du client à la main (cf. /api/odoo/clients). On n'appelle jamais
// create/write/unlink : aucune donnée n'est écrite dans Odoo depuis cette application.
//
// Utilise l'API externe JSON-RPC standard d'Odoo (mêmes services/authentification que
// l'API XML-RPC — /jsonrpc au lieu de /xmlrpc/2/*), disponible nativement via `fetch`
// sans dépendance supplémentaire.
//
// Les variables d'environnement sont lues à CHAQUE appel (pas une fois au chargement du
// module) : dotenv.config() s'exécute dans index.ts après l'import de ce module (l'ordre
// des require() ne suit pas l'ordre visuel du fichier), donc process.env.ODOO_* ne serait
// pas encore renseigné si on le lisait une seule fois au niveau du module.
function getConfig() {
  return {
    url: process.env.ODOO_URL?.replace(/\/+$/, ''),
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    apiKey: process.env.ODOO_API_KEY,
  };
}

export function odooConfigured(): boolean {
  const { url, db, username, apiKey } = getConfig();
  return !!(url && db && username && apiKey);
}

const ODOO_TIMEOUT_MS = 5000;

async function jsonRpcCall(url: string, service: string, method: string, args: unknown[]): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ODOO_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
    const payload = await res.json();
    if (payload.error) throw new Error(payload.error.data?.message || payload.error.message || 'Erreur Odoo');
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

// uid Odoo mis en cache (login stable pour un même utilisateur/clé API — pas une
// session expirable comme un cookie, inutile de se reconnecter à chaque recherche).
let cachedUid: number | null = null;

async function authenticate(url: string, db: string, username: string, apiKey: string): Promise<number> {
  if (cachedUid != null) return cachedUid;
  const uid = await jsonRpcCall(url, 'common', 'login', [db, username, apiKey]);
  if (!uid) throw new Error('Authentification Odoo refusée');
  cachedUid = uid;
  return uid;
}

// Authentifie puis appelle search_read sur `model` — factorise la partie commune aux
// recherches clients et devis (lecture seule dans les deux cas).
async function searchRead(model: string, domain: unknown[], fields: string[], limit: number, order: string): Promise<any[]> {
  const { url, db, username, apiKey } = getConfig();
  if (!url || !db || !username || !apiKey) throw new Error('Odoo non configuré');
  const uid = await authenticate(url, db, username, apiKey);
  const rows = await jsonRpcCall(url, 'object', 'execute_kw', [
    db, uid, apiKey,
    model, 'search_read',
    [domain, fields],
    { limit, order },
  ]);
  return rows || [];
}

export interface OdooClient {
  id: number;
  name: string;
  email: string | null;
  city: string | null;
}

// Recherche de contacts Odoo par nom (search_read sur res.partner — lecture seule).
// Une requête vide renvoie les premiers contacts par ordre alphabétique (liste initiale
// au clic, avant toute saisie).
export async function odooSearchClients(query: string, limit = 20): Promise<OdooClient[]> {
  const trimmed = query.trim();
  const domain = trimmed ? [['name', 'ilike', trimmed]] : [];
  const rows = await searchRead('res.partner', domain, ['name', 'email', 'city'], limit, 'name asc');
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email || null,
    city: r.city || null,
  }));
}

export interface OdooDevis {
  id: number;
  name: string;
  amountUntaxed: number;
  clientName: string | null;
}

// Recherche de devis/commandes Odoo par numéro (search_read sur sale.order — lecture
// seule) : sert à préremplir le budget global vendu (HT) d'un chantier à partir de son
// numéro de devis (amount_untaxed), sans jamais rien créer ni modifier dans Odoo. Une
// requête vide renvoie les devis les plus récents (tri décroissant par numéro).
export async function odooSearchDevis(query: string, limit = 20): Promise<OdooDevis[]> {
  const trimmed = query.trim();
  const domain = trimmed ? [['name', 'ilike', trimmed]] : [];
  const rows = await searchRead('sale.order', domain, ['name', 'amount_untaxed', 'partner_id'], limit, 'name desc');
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    amountUntaxed: r.amount_untaxed ?? 0,
    clientName: Array.isArray(r.partner_id) ? r.partner_id[1] : null,
  }));
}
