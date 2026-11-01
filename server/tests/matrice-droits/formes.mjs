// Description d'une réponse de lecture pour la matrice des données visibles (lot D1a-3, cadrage version 3, §3) :
// éléments nommés des listes, clés présentes de chaque type d'objet, statut des montants de la liste fermée
// (montants-masques.mjs). JAMAIS la valeur d'un montant : un montant ne sort que comme « présent », « null » ou
// « absent ». Ce fichier n'est pas un fichier de tests (pas de suffixe « .test.mjs »).
import { normaliserTexte } from './outils.mjs';

export const PRESENT = 'présent';
export const NUL = 'null';
export const ABSENT = 'absent';

// --- Noms ---
// Registre identifiant → nom : cibles du jeu de données, comptes, compléments propres à D1a-3. Le premier nom
// posé pour un identifiant l'emporte.
export function creerRegistre() {
  const noms = new Map();
  return {
    ajouter(id, nom) { if (typeof id === 'string' && id && !noms.has(id)) noms.set(id, nom); },
    nom(id) { return typeof id === 'string' ? noms.get(id) ?? null : null; },
    taille() { return noms.size; },
  };
}

const CHAMPS_LIBELLE = ['nom', 'name', 'titre', 'objet', 'raisonSociale', 'libelle', 'designation', 'motifHorsAffaire', 'mentions', 'description', 'contenu', 'reference', 'numero', 'code', 'cle'];
const libelle = (texte) => `« ${normaliserTexte(texte).slice(0, 80)} »`;

// Nom d'un objet d'une liste :
//  - son nom de cible ou de compte (registre) ;
//  - pour une entrée de journal ou un lien (champ `action`, ou `cibleId` connu) : sa nature, son action et sa cible ;
//  - sinon, un objet du jeu de données hors des cibles : son libellé entre guillemets (« … »), ce qui le signale ;
//  - null pour un objet sans identifiant (agrégat, ligne de calcul) : ce n'est pas un élément du jeu de données.
export function nommer(objet, registre) {
  if (!objet || typeof objet !== 'object' || Array.isArray(objet)) return null;
  const connu = registre.nom(objet.id);
  if (connu) return connu;
  if (typeof objet.action === 'string' || registre.nom(objet.cibleId)) {
    const cible = registre.nom(objet.cibleId) ?? registre.nom(objet.factureId) ?? (typeof objet.cibleLibelle === 'string' && objet.cibleLibelle ? libelle(objet.cibleLibelle) : null);
    return [objet.cible ?? objet.cibleType ?? objet.type ?? objet.domaine, objet.action, cible].filter((partie) => typeof partie === 'string' && partie).map(normaliserTexte).join(' ');
  }
  if (!('id' in objet)) return null;
  for (const champ of CHAMPS_LIBELLE) if (typeof objet[champ] === 'string' && objet[champ].trim()) return libelle(objet[champ]);
  // Sans libellé : l'objet joint qui le désigne (une affectation, par sa fiche intervenant), sinon sa première
  // référence connue (une ligne de TVA, par sa facture).
  for (const [cle, valeur] of Object.entries(objet)) {
    if (valeur && typeof valeur === 'object' && !Array.isArray(valeur) && registre.nom(valeur.id)) return `${cle} ${registre.nom(valeur.id)}`;
  }
  for (const [cle, valeur] of Object.entries(objet)) if (cle.endsWith('Id') && registre.nom(valeur)) return `${cle.slice(0, -2)} ${registre.nom(valeur)}`;
  return '(sans libellé)';
}

// Liste de noms lisible et stable : triée, un nom répété porte « ×n ».
export function listeDeNoms(noms) {
  if (!noms.length) return '(aucun)';
  const compte = new Map();
  for (const nom of noms) compte.set(nom, (compte.get(nom) ?? 0) + 1);
  return [...compte.keys()].sort(comparer).map((nom) => (compte.get(nom) > 1 ? `${nom} ×${compte.get(nom)}` : nom)).join(', ');
}
export const comparer = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- Parcours d'une réponse ---
// Chemins : « » la réponse, « .x » une clé, « [] » chaque élément d'une liste (« [].achats[] » : chaque achat de
// chaque élément). Rend, pour chaque chemin d'objet, le nombre d'objets et le nombre de ceux qui portent chaque
// clé ; pour chaque chemin de liste, le nom de chacun de ses éléments (null : agrégat ; undefined : valeur simple).
export function parcourir(corps, registre) {
  const objets = new Map();
  const listes = new Map();
  const visiter = (valeur, chemin) => {
    if (Array.isArray(valeur)) {
      const cheminListe = `${chemin}[]`;
      if (!listes.has(cheminListe)) listes.set(cheminListe, []);
      for (const element of valeur) {
        listes.get(cheminListe).push(element && typeof element === 'object' && !Array.isArray(element) ? nommer(element, registre) : undefined);
        visiter(element, cheminListe);
      }
      return;
    }
    if (!valeur || typeof valeur !== 'object') return;
    if (!objets.has(chemin)) objets.set(chemin, { n: 0, cles: new Map() });
    const objet = objets.get(chemin);
    objet.n += 1;
    for (const [cle, sous] of Object.entries(valeur)) {
      const nom = normaliserTexte(cle);
      objet.cles.set(nom, (objet.cles.get(nom) ?? 0) + 1);
      visiter(sous, `${chemin}.${nom}`);
    }
  };
  visiter(corps, '');
  return { objets, listes };
}

// Une liste est décrite (ligne « éléments ») si elle porte au moins un objet nommé, ou si elle est au premier niveau
// de la réponse (« [] » ou « .x[] »), même vide : une liste vue vide est un fait de droits. Une liste vide de valeurs
// simples (types d'un chantier, alertes, permissions, portées) ou de lignes de calcul (barèmes) n'en est pas une.
const LISTES_DE_VALEURS = new Set(['types', 'alertes', 'permissions', 'permissionsIndividuelles', 'scopes', 'intervenantsNonValorises', 'baremeStandard', 'baremeReduit']);
export const listePremierNiveau = (chemin) => chemin === '[]' || (/^\.[^.[\]]+\[\]$/.test(chemin) && !LISTES_DE_VALEURS.has(chemin.slice(1, -2)));
export const afficherChemin = (chemin) => chemin || '.';

// Clés d'un type d'objet : triées ; « ? » marque une clé que ne portent pas tous les objets de ce chemin.
export function clesDecrites({ n, cles }) {
  if (!cles.size) return '(aucune)';
  return [...cles.keys()].sort(comparer).map((cle) => (cles.get(cle) < n ? `${cle}?` : cle)).join(', ');
}

// Objets d'une réponse à un chemin de type (« . », « [] », « .x[] »).
export function objetsAuChemin(corps, chemin) {
  if (chemin === '.') return corps && typeof corps === 'object' && !Array.isArray(corps) ? [corps] : [];
  const morceaux = /^(\.[^.[\]]+)?\[\]$/.exec(chemin);
  if (!morceaux) throw new Error(`chemin de type non pris en charge : ${chemin}`);
  const liste = morceaux[1] ? corps?.[morceaux[1].slice(1)] : corps;
  return Array.isArray(liste) ? liste.filter((e) => e && typeof e === 'object' && !Array.isArray(e)) : [];
}

// Statut d'un champ dans un objet, par son chemin (« a.b », « a[].b ») : l'ensemble trié des statuts rencontrés
// (« présent », « null », « absent ») ; vide si aucun objet ne peut le porter (parent nul ou absent, liste vide).
export function statut(objet, chemin) {
  const segments = chemin.split('.');
  const vus = new Set();
  const aller = (valeur, rang) => {
    if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) return;
    const segment = segments[rang];
    const liste = segment.endsWith('[]');
    const cle = liste ? segment.slice(0, -2) : segment;
    if (rang === segments.length - 1 && !liste) {
      vus.add(!(cle in valeur) ? ABSENT : valeur[cle] === null ? NUL : PRESENT);
      return;
    }
    const sous = valeur[cle];
    if (liste) {
      if (Array.isArray(sous)) for (const element of sous) aller(element, rang + 1);
      return;
    }
    aller(sous, rang + 1);
  };
  aller(objet, 0);
  return [...vus].sort(comparer);
}

// Valeurs d'un champ qui n'est pas un montant (codes, droits) : liste triée, oui ou non, texte normalisé.
export function valeurDecrite(objet, chemin) {
  let valeur = objet;
  for (const segment of chemin.split('.')) {
    if (!valeur || typeof valeur !== 'object' || !(segment in valeur)) return null;
    valeur = valeur[segment];
  }
  if (Array.isArray(valeur)) return valeur.length ? [...valeur].map((v) => normaliserTexte(String(v))).sort(comparer).join('+') : '(aucune)';
  if (typeof valeur === 'boolean') return valeur ? 'oui' : 'non';
  if (valeur === null) return NUL;
  if (typeof valeur === 'string') return normaliserTexte(valeur);
  return '(non affichée)';
}

// --- Présences, pour le test « aucun champ masqué hors de la liste » ---
// Pour un objet (élément nommé ou réponse) : chaque chemin qui porte un nombre, un objet, une liste ou null, avec
// « présent » ou « null » ; les textes et booléens ne sont pas suivis. Dans une liste, un élément nommé garde son nom
// dans le chemin (« achats[achat-chantier-ct].montantHT ») pour qu'on ne compare que le même objet d'un compte à
// l'autre ; un élément sans nom est rangé sous « [] ». `vus` : chemins des objets parcourus (parents possibles).
export function presences(objet, registre) {
  const champs = new Map();
  const vus = new Set(['']);
  const noter = (chemin, valeur) => {
    if (!champs.has(chemin)) champs.set(chemin, new Set());
    champs.get(chemin).add(valeur);
  };
  const visiterObjet = (valeur, chemin) => {
    vus.add(chemin);
    for (const [cle, sous] of Object.entries(valeur)) {
      const ici = chemin ? `${chemin}.${cle}` : cle;
      if (sous === null) noter(ici, NUL);
      else if (Array.isArray(sous)) {
        noter(ici, PRESENT);
        for (const element of sous) {
          // Le nom est gardé tel quel, hors points et crochets, qui découpent le chemin.
          if (element && typeof element === 'object' && !Array.isArray(element)) visiterObjet(element, `${ici}[${(nommer(element, registre) ?? '').replace(/[.[\]]/g, '·')}]`);
        }
      } else if (typeof sous === 'object') { noter(ici, PRESENT); visiterObjet(sous, ici); }
      else if (typeof sous === 'number') noter(ici, PRESENT);
    }
  };
  if (objet && typeof objet === 'object' && !Array.isArray(objet)) visiterObjet(objet, '');
  return { champs, vus };
}
export const parentDe = (chemin) => (chemin.includes('.') ? chemin.slice(0, chemin.lastIndexOf('.')) : '');
export const cheminGenerique = (chemin) => chemin.replace(/\[[^\]]*\]/g, '[]');
