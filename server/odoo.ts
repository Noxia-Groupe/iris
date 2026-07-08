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

const ODOO_URL = process.env.ODOO_URL?.replace(/\/+$/, '');
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

export const odooConfigured = !!(ODOO_URL && ODOO_DB && ODOO_USERNAME && ODOO_API_KEY);

const ODOO_TIMEOUT_MS = 5000;

async function jsonRpcCall(service: string, method: string, args: unknown[]): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ODOO_TIMEOUT_MS);
  try {
    const res = await fetch(`${ODOO_URL}/jsonrpc`, {
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

async function authenticate(): Promise<number> {
  if (cachedUid != null) return cachedUid;
  const uid = await jsonRpcCall('common', 'login', [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY]);
  if (!uid) throw new Error('Authentification Odoo refusée');
  cachedUid = uid;
  return uid;
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
  if (!odooConfigured) throw new Error('Odoo non configuré');
  const uid = await authenticate();
  const trimmed = query.trim();
  const domain = trimmed ? [['name', 'ilike', trimmed]] : [];
  const rows = await jsonRpcCall('object', 'execute_kw', [
    ODOO_DB, uid, ODOO_API_KEY,
    'res.partner', 'search_read',
    [domain, ['name', 'email', 'city']],
    { limit, order: 'name asc' },
  ]);
  return (rows || []).map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email || null,
    city: r.city || null,
  }));
}
