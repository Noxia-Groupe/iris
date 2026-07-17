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
    // Nom (ou fragment de nom) de la section de devis à considérer comme "Matériel" pour
    // le préremplissage automatique du budget matériel (cf. odooDevisMateriel ci-dessous).
    // Comparaison insensible à la casse et aux accents, donc "Matériel"/"MATERIEL" matchent
    // tous les deux la valeur par défaut.
    materielSectionLabel: process.env.ODOO_SECTION_MATERIEL_LABEL || 'materiel',
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
  adresse: string | null;
}

// Compose une adresse lisible à une ligne à partir des champs standards d'un contact
// Odoo (res.partner) — utilisé aussi bien pour un contact retourné directement
// (odooSearchClients) que pour le contact de livraison/facturation d'un devis
// (odooDevisAdresse ci-dessous). Retourne null (jamais une chaîne vide) si le contact n'a
// aucune de ces informations, pour laisser le champ formulaire vide plutôt qu'un texte
// composé de virgules superflues.
function formatAdresse(p: { street?: string | null; street2?: string | null; city?: string | null; zip?: string | null }): string | null {
  const codePostalVille = [p.zip, p.city].filter(Boolean).join(' ').trim();
  const parts = [p.street, p.street2, codePostalVille].map((s) => (s || '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Recherche de contacts Odoo par nom (search_read sur res.partner — lecture seule).
// Une requête vide renvoie les premiers contacts par ordre alphabétique (liste initiale
// au clic, avant toute saisie).
export async function odooSearchClients(query: string, limit = 20): Promise<OdooClient[]> {
  const trimmed = query.trim();
  const domain = trimmed ? [['name', 'ilike', trimmed]] : [];
  const rows = await searchRead('res.partner', domain, ['name', 'email', 'city', 'street', 'street2', 'zip'], limit, 'name asc');
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email || null,
    city: r.city || null,
    adresse: formatAdresse(r),
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
//
// Si partnerId est fourni (client Odoo déjà sélectionné dans le formulaire), on restreint
// aux devis de ce client — via child_of plutôt qu'une égalité stricte, pour couvrir le cas
// où le devis est adressé à un contact enfant (ex: un site) du client sélectionné. Ce
// filtre n'est qu'une aide : le numéro de devis reste un champ texte libre côté client.
export async function odooSearchDevis(query: string, limit = 20, partnerId?: number): Promise<OdooDevis[]> {
  const trimmed = query.trim();
  const domain: unknown[] = [];
  if (trimmed) domain.push(['name', 'ilike', trimmed]);
  if (partnerId) domain.push(['partner_id', 'child_of', partnerId]);
  const rows = await searchRead('sale.order', domain, ['name', 'amount_untaxed', 'partner_id'], limit, 'name desc');
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    amountUntaxed: r.amount_untaxed ?? 0,
    clientName: Array.isArray(r.partner_id) ? r.partner_id[1] : null,
  }));
}

// Normalise une chaîne pour une comparaison insensible à la casse et aux accents
// (ex: "Matériel" et "MATERIEL" doivent matcher le même libellé de section).
function normalizeLabel(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// Calcule le sous-total de la section "Matériel" d'un devis (lecture seule sur
// sale.order.line) : sert à préremplir le champ "Dont Matériel" d'un chantier, de la même
// façon que amount_untaxed préremplit le budget global. Un devis Odoo est structuré en
// lignes de produits entrecoupées de lignes de section (display_type = 'line_section', qui
// ne portent qu'un titre) ; le "Total Matériel" vu dans Odoo est le sous-total des lignes
// de produits situées sous la section dont le titre correspond à materielSectionLabel.
//
// Renvoie null (et non 0) si aucune section de ce nom n'existe sur ce devis : un 0
// silencieux écraserait le champ à tort, alors que null laisse le formulaire ne pas y
// toucher et l'utilisateur saisir le montant à la main.
export async function odooDevisMateriel(devisId: number): Promise<number | null> {
  const { url, db, username, apiKey, materielSectionLabel } = getConfig();
  if (!url || !db || !username || !apiKey) throw new Error('Odoo non configuré');
  const uid = await authenticate(url, db, username, apiKey);
  const lines = await jsonRpcCall(url, 'object', 'execute_kw', [
    db, uid, apiKey,
    'sale.order.line', 'search_read',
    [[['order_id', '=', devisId]], ['display_type', 'name', 'price_subtotal']],
    { order: 'sequence asc, id asc' },
  ]);
  const needle = normalizeLabel(materielSectionLabel);
  let inMaterielSection = false;
  let found = false;
  let total = 0;
  for (const line of lines || []) {
    if (line.display_type === 'line_section') {
      inMaterielSection = normalizeLabel(line.name || '').includes(needle);
      if (inMaterielSection) found = true;
      continue;
    }
    if (line.display_type) continue; // notes et autres lignes non-produit : ignorées
    if (inMaterielSection) total += line.price_subtotal || 0;
  }
  return found ? total : null;
}

// Adresse du site d'un devis (lecture seule) : sert à préremplir le champ "Adresse" d'un
// chantier une fois un devis sélectionné, sans jamais rien créer ni modifier dans Odoo.
// Priorité à l'adresse de LIVRAISON du devis (partner_shipping_id — le site d'intervention
// réel, souvent différent du siège facturé) ; à défaut, adresse du client facturé
// (partner_id). Renvoie null (et non une chaîne vide) si le devis ou le contact sont
// introuvables, ou si le contact n'a aucune adresse renseignée — le formulaire reste alors
// inchangé et l'utilisateur saisit l'adresse à la main.
export async function odooDevisAdresse(devisId: number): Promise<string | null> {
  const { url, db, username, apiKey } = getConfig();
  if (!url || !db || !username || !apiKey) throw new Error('Odoo non configuré');
  const uid = await authenticate(url, db, username, apiKey);
  const orders = await jsonRpcCall(url, 'object', 'execute_kw', [
    db, uid, apiKey,
    'sale.order', 'search_read',
    [[['id', '=', devisId]], ['partner_shipping_id', 'partner_id']],
    {},
  ]);
  const order = orders?.[0];
  if (!order) return null;
  const shipping = Array.isArray(order.partner_shipping_id) ? order.partner_shipping_id[0] : null;
  const invoice = Array.isArray(order.partner_id) ? order.partner_id[0] : null;
  const partnerId = shipping || invoice;
  if (!partnerId) return null;

  const partners = await jsonRpcCall(url, 'object', 'execute_kw', [
    db, uid, apiKey,
    'res.partner', 'search_read',
    [[['id', '=', partnerId]], ['street', 'street2', 'city', 'zip']],
    {},
  ]);
  const partner = partners?.[0];
  return partner ? formatAdresse(partner) : null;
}
