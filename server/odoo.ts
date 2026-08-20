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
// Les lectures du suivi financier portent sur tous les devis d'un coup (commandes,
// factures, paiements) : plus de données, donc plus de temps que les recherches
// interactives d'un formulaire.
const ODOO_TIMEOUT_LONG_MS = 20000;

async function jsonRpcCall(url: string, service: string, method: string, args: unknown[], timeoutMs = ODOO_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
async function searchRead(model: string, domain: unknown[], fields: string[], limit: number, order: string, timeoutMs?: number): Promise<any[]> {
  const { url, db, username, apiKey } = getConfig();
  if (!url || !db || !username || !apiKey) throw new Error('Odoo non configuré');
  const uid = await authenticate(url, db, username, apiKey);
  const rows = await jsonRpcCall(url, 'object', 'execute_kw', [
    db, uid, apiKey,
    model, 'search_read',
    [domain, fields],
    { limit, order },
  ], timeoutMs);
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

// --- Suivi financier : rapprochement devis de vente / factures / paiements ---
// Lecture seule, comme tout le reste de cette intégration. Sert à répondre, devis par
// devis, à trois questions : combien a été facturé, combien a été réellement encaissé,
// et quand a eu lieu le dernier versement.
//
// Chaîne Odoo utilisée : sale.order (le devis, ex. S00700) -> invoice_ids (les factures
// client, acomptes compris — un acompte Odoo EST une facture) -> account.payment (les
// versements rapprochés de ces factures). Le montant encaissé est déduit des factures
// (total - restant dû) et non de la somme des paiements : c'est la comptabilité qui fait
// foi, un paiement pouvant être partiellement affecté à une autre facture.

export interface OdooPaiement {
  id: number;
  reference: string;      // ex: BNK1/2026/0007
  date: string | null;    // "YYYY-MM-DD"
  montant: number;        // signé : négatif pour un remboursement au client
  journal: string | null; // Banque, Caisse...
  factures: string[];     // numéros des factures que ce versement solde
}

export interface OdooFacture {
  id: number;
  numero: string;
  date: string | null;         // date de facture
  dateEcheance: string | null;
  montantTTC: number;          // signé : négatif pour un avoir
  montantRestantDu: number;    // signé
  etatPaiement: string;        // payment_state Odoo brut (not_paid, partial, paid...)
  estAvoir: boolean;
}

export interface OdooSuiviDevis {
  id: number;
  numero: string;          // ex: S00700
  clientNom: string | null;
  dateCommande: string | null; // date de commande, pour classer les dossiers anciens
  etatOdoo: string;        // state Odoo brut : sale (vendu) | done (verrouillé) | ...
  montantTTC: number;      // montant vendu, toutes taxes (référence de la progression)
  montantHT: number;
  montantFacture: number;  // somme des factures émises (avoirs déduits)
  montantPaye: number;     // facturé - restant dû = réellement encaissé
  factures: OdooFacture[];
  paiements: OdooPaiement[];
}

// Un avoir (out_refund) diminue ce que le client doit : ses montants sont comptés en négatif.
function signeFacture(moveType: string): number {
  return moveType === 'out_refund' ? -1 : 1;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return v.slice(0, 10);
}

function nomRelation(v: unknown): string | null {
  return Array.isArray(v) && v.length > 1 ? String(v[1]) : null;
}

// Odoo accepte de longues listes d'identifiants, mais une requête `id in [...]` de
// plusieurs milliers d'éléments produit une requête HTTP démesurée et un temps de réponse
// imprévisible. On découpe donc en paquets, quitte à faire quelques allers-retours.
const TAILLE_PAQUET = 300;

function paquets<T>(items: T[], taille = TAILLE_PAQUET): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += taille) out.push(items.slice(i, i + taille));
  return out;
}

// --- Cache mémoire ---
// Le parc compte environ 800 chantiers, dont l'immense majorité est close et soldée : les
// interroger à chaque affichage rendrait l'écran inutilisable et solliciterait Odoo pour
// rien, alors que ces dossiers ne bougent plus. Les résultats sont donc gardés en mémoire
// le temps d'une courte fenêtre (ODOO_CACHE_TTL_SECONDS, 10 min par défaut), et le bouton
// « Actualiser » de l'écran force une relecture complète.
//
// Cache de processus, volontairement : il se vide au redémarrage du serveur, ne demande
// aucune infrastructure, et une donnée financière vieille de quelques minutes ne porte
// pas à conséquence sur un écran de consultation.
function cacheTtlMs(): number {
  const secondes = Number(process.env.ODOO_CACHE_TTL_SECONDS || 600);
  return (Number.isFinite(secondes) && secondes > 0 ? secondes : 600) * 1000;
}

// `null` = devis cherché et introuvable côté Odoo : on mémorise aussi cette réponse, sinon
// un numéro erroné saisi sur un chantier relancerait une requête à chaque affichage.
const cacheDevis = new Map<string, { valeur: OdooSuiviDevis | null; charge: number }>();
let cacheCommandesVendues: { valeur: OdooSuiviDevis[]; charge: number } | null = null;

function estFrais(charge: number): boolean {
  return Date.now() - charge < cacheTtlMs();
}

// Complète les commandes déjà lues (numéro, client, montants) avec leurs factures et leurs
// versements. Deux requêtes Odoo par paquet de factures, quel que soit le nombre de devis.
async function completerSuivi(commandes: any[]): Promise<OdooSuiviDevis[]> {
  const suivis: OdooSuiviDevis[] = [];
  // id de facture -> numéro(s) de devis auxquels elle se rattache. Une même facture peut
  // regrouper plusieurs commandes ; ses montants sont alors comptés pour chacune, faute de
  // pouvoir les répartir ligne à ligne de façon fiable.
  const factureVersDevis = new Map<number, string[]>();
  const parNumero = new Map<string, OdooSuiviDevis>();

  for (const c of commandes) {
    const suivi: OdooSuiviDevis = {
      id: c.id,
      numero: c.name,
      clientNom: nomRelation(c.partner_id),
      dateCommande: isoDate(c.date_order),
      etatOdoo: c.state || '',
      montantTTC: c.amount_total ?? 0,
      montantHT: c.amount_untaxed ?? 0,
      montantFacture: 0,
      montantPaye: 0,
      factures: [],
      paiements: [],
    };
    suivis.push(suivi);
    parNumero.set(c.name, suivi);
    for (const fid of (c.invoice_ids as number[]) || []) {
      factureVersDevis.set(fid, [...(factureVersDevis.get(fid) || []), c.name]);
    }
  }

  const idsFactures = [...factureVersDevis.keys()];
  if (idsFactures.length === 0) return suivis;

  // Seules les factures COMPTABILISÉES (posted) comptent : un brouillon n'engage rien et
  // ferait apparaître un "facturé" qui n'existe pas encore.
  const numeroFactureParId = new Map<number, string>();
  for (const lot of paquets(idsFactures)) {
    const moves = await searchRead(
      'account.move',
      [['id', 'in', lot], ['state', '=', 'posted']],
      ['name', 'invoice_date', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state', 'move_type'],
      lot.length,
      'invoice_date asc, id asc',
      ODOO_TIMEOUT_LONG_MS,
    );
    for (const m of moves) {
      numeroFactureParId.set(m.id, m.name);
      const signe = signeFacture(m.move_type);
      const facture: OdooFacture = {
        id: m.id,
        numero: m.name,
        date: isoDate(m.invoice_date),
        dateEcheance: isoDate(m.invoice_date_due),
        montantTTC: signe * (m.amount_total ?? 0),
        montantRestantDu: signe * (m.amount_residual ?? 0),
        etatPaiement: m.payment_state || 'not_paid',
        estAvoir: m.move_type === 'out_refund',
      };
      for (const numeroDevis of factureVersDevis.get(m.id) || []) {
        const suivi = parNumero.get(numeroDevis);
        if (!suivi) continue;
        suivi.factures.push(facture);
        suivi.montantFacture += facture.montantTTC;
        suivi.montantPaye += facture.montantTTC - facture.montantRestantDu;
      }
    }
  }

  // Détail des versements. `reconciled_invoice_ids` n'existe que sur les versions récentes
  // d'Odoo : en cas d'échec, on garde les montants déduits des factures (l'essentiel) et on
  // se passe du détail « date et montant du dernier versement ».
  try {
    for (const lot of paquets(idsFactures)) {
      const paiements = await searchRead(
        'account.payment',
        [['reconciled_invoice_ids', 'in', lot]],
        ['name', 'date', 'amount', 'journal_id', 'payment_type', 'reconciled_invoice_ids'],
        2000,
        'date desc, id desc',
        ODOO_TIMEOUT_LONG_MS,
      );
      for (const p of paiements) {
        const factureIds = ((p.reconciled_invoice_ids as number[]) || []).filter((id) => factureVersDevis.has(id));
        const paiement: OdooPaiement = {
          id: p.id,
          reference: p.name || '',
          date: isoDate(p.date),
          montant: (p.payment_type === 'outbound' ? -1 : 1) * (p.amount ?? 0),
          journal: nomRelation(p.journal_id),
          factures: factureIds.map((id) => numeroFactureParId.get(id)).filter((n): n is string => !!n),
        };
        // Un versement rapproché de plusieurs factures d'un même devis, ou lu dans deux
        // paquets différents, ne doit y figurer qu'une fois.
        const devisConcernes = new Set(factureIds.flatMap((id) => factureVersDevis.get(id) || []));
        for (const numeroDevis of devisConcernes) {
          const suivi = parNumero.get(numeroDevis);
          if (suivi && !suivi.paiements.some((existant) => existant.id === paiement.id)) {
            suivi.paiements.push(paiement);
          }
        }
      }
    }
  } catch (error) {
    console.warn('Odoo: détail des paiements indisponible —', error instanceof Error ? error.message : error);
  }

  // Tri du plus récent au plus ancien, sans dépendre de l'ordre renvoyé par Odoo : c'est
  // ce qui définit « le dernier versement » côté appelant comme à l'affichage.
  for (const suivi of suivis) {
    suivi.paiements.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
  }

  return suivis;
}

const CHAMPS_COMMANDE = ['name', 'partner_id', 'date_order', 'state', 'amount_total', 'amount_untaxed', 'invoice_ids'];

/**
 * Rapproche une liste de numéros de devis Odoo (ex. ["S00700", "S00712"]) avec leurs
 * factures et paiements.
 *
 * Un numéro sans commande correspondante côté Odoo est simplement absent du résultat :
 * l'appelant sait alors que le rapprochement n'a pas pu se faire pour ce chantier.
 */
export async function odooSuiviDevis(numerosDevis: string[], options: { force?: boolean } = {}): Promise<Map<string, OdooSuiviDevis>> {
  const resultat = new Map<string, OdooSuiviDevis>();
  const numeros = [...new Set(numerosDevis.map((n) => n.trim()).filter(Boolean))];
  if (numeros.length === 0) return resultat;

  const aCharger: string[] = [];
  for (const numero of numeros) {
    const entree = options.force ? undefined : cacheDevis.get(numero);
    if (entree && estFrais(entree.charge)) {
      if (entree.valeur) resultat.set(numero, entree.valeur);
    } else {
      aCharger.push(numero);
    }
  }
  if (aCharger.length === 0) return resultat;

  const commandes: any[] = [];
  for (const lot of paquets(aCharger)) {
    commandes.push(...await searchRead('sale.order', [['name', 'in', lot]], CHAMPS_COMMANDE, lot.length, 'name asc', ODOO_TIMEOUT_LONG_MS));
  }
  const suivis = await completerSuivi(commandes);

  const trouves = new Set<string>();
  for (const suivi of suivis) {
    trouves.add(suivi.numero);
    resultat.set(suivi.numero, suivi);
    cacheDevis.set(suivi.numero, { valeur: suivi, charge: Date.now() });
  }
  // Mémorise aussi les numéros restés sans correspondance (cf. commentaire du cache).
  for (const numero of aCharger) {
    if (!trouves.has(numero)) cacheDevis.set(numero, { valeur: null, charge: Date.now() });
  }
  return resultat;
}

/**
 * Toutes les commandes Odoo effectivement VENDUES : `state` sale (bon de commande confirmé)
 * ou done (verrouillé). Les devis non signés (draft/sent) et les commandes annulées sont
 * exclus — ils ne représentent aucun engagement financier.
 *
 * Sert à repérer les dossiers qui n'ont jamais été suivis dans l'application mais dont la
 * comptabilité, elle, garde la trace.
 */
export async function odooCommandesVendues(limite = 1500, options: { force?: boolean } = {}): Promise<OdooSuiviDevis[]> {
  if (!options.force && cacheCommandesVendues && estFrais(cacheCommandesVendues.charge)) {
    return cacheCommandesVendues.valeur;
  }
  const commandes = await searchRead(
    'sale.order',
    [['state', 'in', ['sale', 'done']]],
    CHAMPS_COMMANDE,
    limite,
    'date_order desc, id desc',
    ODOO_TIMEOUT_LONG_MS,
  );
  const suivis = await completerSuivi(commandes);
  cacheCommandesVendues = { valeur: suivis, charge: Date.now() };
  // Les fiches individuelles profitent de la même lecture : ouvrir le détail d'un dossier
  // juste après la liste ne relance pas de requête.
  for (const suivi of suivis) cacheDevis.set(suivi.numero, { valeur: suivi, charge: Date.now() });
  return suivis;
}
