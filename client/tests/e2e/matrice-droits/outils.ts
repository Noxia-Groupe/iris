// Outils de la matrice des droits à l'écran (lot D1a-6, cadrage version 3 du 03-11-2026, publié sur #427, sections 3 et
// 5). Ce fichier ne contient aucun test : Playwright ne lit que les `*.spec.ts`.
//
// - Format et comparaison : recopiés de `server/tests/matrice-droits/outils.mjs` (trier, cleDeLigne, diffParCle,
//   comparerAvecReference), qui importe `pg` et ne se charge donc pas ici (copie assumée, N12 c du contrôle).
// - Normalisation, dans l'ordre du cadrage §5, et garde « aucun montant », une branche par motif.
// - Attentes sans délai fixe pour les routes (témoin sur <main>, page neutre en secours) et calme réseau pour les écrans.
// - Lecture des boutons d'un écran, dans sa portée (tout <main>, hors lignes, ou une ligne cible).
// Aucune variable d'environnement n'est lue (règle permanente 3, N3 du contrôle) : l'obtenu s'écrit dans un dossier
// créé par mkdtempSync, comme au backend.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type Page } from '@playwright/test';

export const SEPARATEUR = ' | ';
export const DOSSIER_REFERENCES = path.dirname(fileURLToPath(import.meta.url));
const RACINE_CLIENT = path.resolve(DOSSIER_REFERENCES, '..', '..', '..');

// --- Format (cadrage §3 et §5) ---
// Cinq champs, `compte | écran | cible | contexte | observation` ; la clé est formée des quatre premiers.
export function ligneMatrice(champs: [string, string, string, string, string]) {
  for (const champ of champs) {
    if (champ.includes('|') || champ !== champ.trim() || /\n/.test(champ) || champ === '') throw new Error(`champ de ligne invalide : « ${champ} »`);
  }
  return champs.join(SEPARATEUR);
}
export const cleDeLigne = (ligne: string) => ligne.split(SEPARATEUR).slice(0, 4).join(SEPARATEUR);
// Tri au code de caractère près, indépendant de la langue de la machine.
export const trier = (lignes: string[]) => [...lignes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// --- Comparaison avec la référence (cadrage §3, sur le modèle de comparerAvecReference du backend) ---
// Une ligne changée se résume en une seule : sa clé, puis ce que l'obtenu ajoute (« + ») et retire (« - ») à la
// référence, élément par élément (`~ clé : + Modifier ; - Rapport client (PDF)`). Une ligne ajoutée ou retirée se lit
// entière, précédée de « + » ou de « - ».
const elements = (observation: string) => observation.split(' ; ').flatMap((segment) => {
  const liste = /^([^:«]+?) : (.*)$/.exec(segment);
  return (liste ? liste[2] : segment).split(', ');
});
export function resumerChangement(avant: string, apres: string) {
  const restants = elements(avant.split(SEPARATEUR)[4] ?? '');
  const ajoutes: string[] = [];
  for (const element of elements(apres.split(SEPARATEUR)[4] ?? '')) {
    const rang = restants.indexOf(element);
    if (rang === -1) ajoutes.push(element); else restants.splice(rang, 1);
  }
  const parties = [...(ajoutes.length ? [`+ ${ajoutes.join(', ')}`] : []), ...(restants.length ? [`- ${restants.join(', ')}`] : [])];
  return parties.length ? parties.join(' ; ') : `+ ${apres.split(SEPARATEUR)[4]} ; - ${avant.split(SEPARATEUR)[4]}`;
}
export function diffParCle(lignesReference: string[], lignesObtenues: string[]) {
  const reference = new Map(lignesReference.map((ligne) => [cleDeLigne(ligne), ligne]));
  const obtenues = new Map(lignesObtenues.map((ligne) => [cleDeLigne(ligne), ligne]));
  const diff: string[] = [];
  for (const cle of trier([...new Set([...reference.keys(), ...obtenues.keys()])])) {
    const avant = reference.get(cle);
    const apres = obtenues.get(cle);
    if (avant === apres) continue;
    if (avant !== undefined && apres !== undefined) { diff.push(`~ ${cle} : ${resumerChangement(avant, apres)}`); continue; }
    if (avant !== undefined) diff.push(`- ${avant}`);
    if (apres !== undefined) diff.push(`+ ${apres}`);
  }
  return diff;
}
// Un diff de plus de 60 lignes est précédé du nombre de lignes de diff par (compte, écran), comme au backend.
function resumeDuDiff(diff: string[]) {
  if (diff.length <= 60) return '';
  const groupes = new Map<string, number>();
  for (const ligne of diff) {
    const cle = ligne.slice(2).split(SEPARATEUR).slice(0, 2).join(SEPARATEUR).split(' : ')[0];
    groupes.set(cle, (groupes.get(cle) ?? 0) + 1);
  }
  const tries = [...groupes].sort(([a, na], [b, nb]) => nb - na || (a < b ? -1 : a > b ? 1 : 0));
  return `Lignes de diff par (compte, écran) (${tries.length} groupe(s)) :\n${tries.slice(0, 30).map(([cle, n]) => `  ${cle} : ${n}`).join('\n')}\n`;
}
// En cas d'écart : le test échoue ; l'obtenu est écrit hors du dépôt, avec la commande `cp` qui l'adopte dans la PR qui
// change volontairement un écran ou un droit ; les 60 premières lignes du diff par clé sont imprimées ; l'obtenu est
// joint au rapport Playwright, que la CI garde en cas d'échec (`.github/workflows/ci.yml`, rapport HTML).
export async function comparerAvecReference(lignesObtenues: string[], nomReference: string) {
  const cheminReference = path.join(DOSSIER_REFERENCES, nomReference);
  const texteObtenu = `${trier(lignesObtenues).join('\n')}\n`;
  let texteReference: string | null = null;
  try { texteReference = readFileSync(cheminReference, 'utf8'); } catch { texteReference = null; }
  if (texteReference === texteObtenu) return;
  const cheminObtenu = path.join(mkdtempSync(path.join(tmpdir(), 'iris-matrice-ecrans-')), nomReference);
  writeFileSync(cheminObtenu, texteObtenu);
  await test.info().attach(`${nomReference} (obtenu)`, { body: texteObtenu, contentType: 'text/plain' });
  const lignesReference = texteReference === null ? [] : texteReference.split('\n').filter((ligne) => ligne !== '');
  const diff = diffParCle(lignesReference, trier(lignesObtenues));
  const entete = texteReference === null
    ? `Référence absente : ${cheminReference}.`
    : `La matrice obtenue diffère de la référence ${cheminReference} (${diff.length} ligne(s) de diff).`;
  const suite = diff.length > 60 ? `\n… ${diff.length - 60} ligne(s) de diff de plus.` : '';
  const ordre = diff.length === 0 ? '\n(Mêmes lignes, ordre ou fin de fichier différents.)' : '';
  throw new Error(`${entete}\nMatrice obtenue (jointe au rapport) : ${cheminObtenu}\nPour l’adopter dans la PR qui change volontairement un écran ou un droit : cp ${cheminObtenu} ${cheminReference}\n${resumeDuDiff(diff)}${diff.slice(0, 60).join('\n')}${suite}${ordre}`);
}
export const lireReference = (nomReference: string) => readFileSync(path.join(DOSSIER_REFERENCES, nomReference), 'utf8').split('\n').filter((ligne) => ligne !== '');

// --- Normalisation (cadrage §5), appliquée aux titres et aux noms des boutons des écrans, dans cet ordre ---
// 1. références et numéros des cibles → leur nom ; 2. noms des comptes → <CT> ; 3. suffixe → <s> ; 4. libellés d'état
// global → leur fonction (liste fermée) ; 5. toute suite de chiffres → #, et le pluriel qui suit un compteur → (s).
// Les lignes du menu et des routes ne sont pas normalisées : la branche « chiffre » de la garde les protège (N11).
//
// Liste fermée des libellés qui suivent un état global de la base, et non le compte. Une entrée ne vaut que pour son
// écran, et porte sa raison.
export const LIBELLES_ETAT_GLOBAL: { ecran: string; libelles: string[]; fonction: string; raison: string }[] = [
  {
    ecran: 'planning',
    libelles: ['Publier', 'Renouveler le lien', 'Partage désactivé'],
    fonction: '<partage du planning>',
    // Planning.tsx:254 : le libellé suit l'état du lien de partage public, réglage unique de la société, que
    // identite-application.spec.ts publie avant cette spec dans l'ordre de la CI.
    raison: 'état du lien de partage public du planning, réglage unique de la société',
  },
];
export type Jeu = { cibles: Record<string, string>; comptes: Record<string, string>; suffixe: string };
export function creerNormaliseur({ cibles, comptes, suffixe }: Jeu) {
  // Les plus longs d'abord : un libellé qui en contiendrait un autre est remplacé entier.
  const parLongueur = (paires: [string, string][]) => paires.filter(([libelle]) => libelle).sort(([a], [b]) => b.length - a.length);
  const references = parLongueur(Object.entries(cibles).map(([nom, libelle]) => [libelle, `<${nom}>`]));
  const noms = parLongueur(Object.entries(comptes).map(([cle, nom]) => [nom, `<${cle}>`]));
  return (texte: string, ecran = '') => {
    let t = texte;
    for (const [libelle, nom] of references) t = t.split(libelle).join(nom);
    for (const [nom, cle] of noms) t = t.split(nom).join(cle);
    if (suffixe) t = t.split(suffixe).join('<s>');
    for (const entree of LIBELLES_ETAT_GLOBAL) if (entree.ecran === ecran && entree.libelles.includes(t)) t = entree.fonction;
    return t.replace(/\p{Nd}+/gu, '#').replace(/#(\s*)(\p{L}+?)s?(?=\P{L}|$)/gu, '#$1$2(s)');
  };
}

// --- Garde « aucun montant » (cadrage §5) : une branche par motif ---
// « chiffre » protège les lignes que la normalisation ne touche pas (menu, routes) ; sur les lignes d'écran, l'étape 5
// ne laisse aucun chiffre, et seuls « € », « % » et « #,# » agissent. Chaque branche a son témoin (test de la spec).
export const BRANCHES_MONTANT: [string, RegExp][] = [
  ['chiffre', /\p{Nd}/u],
  ['€', /€/u],
  ['%', /%/u],
  ['#,#', /#[,.]#/u],
];
export const branchesMontant = (ligne: string) => BRANCHES_MONTANT.filter(([, motif]) => motif.test(ligne)).map(([nom]) => nom);
export const gardeAucunMontant = (lignes: string[]) => lignes.filter((ligne) => branchesMontant(ligne).length > 0).map((ligne) => `${ligne}  ⟵ ${branchesMontant(ligne).join(', ')}`);

// --- Routes du client (cadrage §5, « Couverture ») ---
export const ROUTES_PUBLIQUES = ['/login', '/secours', '/acces-refuse', '/auth/callback', '/planning/public/:token'];
export function routesDuClient() {
  const source = readFileSync(path.join(RACINE_CLIENT, 'src', 'App.tsx'), 'utf8');
  const routes = [...source.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
  // `<Route\b` ne compte ni <Routes>, ni <Router>, ni <RouteAccueil>, <RouteDevis>, <RouteFicheIntervention>, <RouteSociete>.
  return { routes, balises: [...source.matchAll(/<Route\b/g)].length };
}
export const routesPrivees = () => routesDuClient().routes.filter((route) => !ROUTES_PUBLIQUES.includes(route));
// Entrées du menu (lib/menu.ts), relevées par `{ to: '…'` ; leur nombre est comparé à celui des objets `{ to:`, pour
// qu'une entrée écrite autrement fasse échouer le test de couverture.
export function entreesDuMenu() {
  const source = readFileSync(path.join(RACINE_CLIENT, 'src', 'lib', 'menu.ts'), 'utf8');
  return { entrees: [...source.matchAll(/\{ *to: '([^']+)'/g)].map((m) => m[1]), occurrences: [...source.matchAll(/\{ *to:/g)].length };
}

// --- Attentes (cadrage §3, « Navigation et attentes ») ---
export type EtatReseau = { enCours: number; dernier: number };
// Appels /api en cours et instant du dernier mouvement, suivis sur la page.
export function suivreReseau(page: Page): EtatReseau {
  const etat = { enCours: 0, dernier: Date.now() };
  const estApi = (r: { url: () => string }) => new URL(r.url()).pathname.startsWith('/api/');
  page.on('request', (r) => { if (estApi(r)) { etat.enCours += 1; etat.dernier = Date.now(); } });
  const fin = (r: { url: () => string }) => { if (estApi(r)) { etat.enCours = Math.max(0, etat.enCours - 1); etat.dernier = Date.now(); } };
  page.on('requestfinished', fin);
  page.on('requestfailed', fin);
  return etat;
}
// 250 ms sans appel /api en cours, après deux images.
export async function auCalme(page: Page, etat: EtatReseau, calme = 250) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const limite = Date.now() + 15_000;
  while (!(etat.enCours === 0 && Date.now() - etat.dernier >= calme)) {
    if (Date.now() > limite) throw new Error('le réseau n’est jamais au calme (appel /api sans fin)');
    await page.waitForTimeout(20);
  }
}
const chemin = (page: Page) => new URL(page.url()).pathname;
async function versPage(page: Page, cible: string) {
  await page.evaluate((p) => { window.history.pushState(null, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, cible);
}
// Page neutre : /acces-refuse, publique, sans <main> et sans effet tant qu'on n'y clique pas. On y passe, puis on
// rejoue le chemin et on attend un <main> garni.
async function depuisPageNeutre(page: Page, cible: string) {
  await versPage(page, '/acces-refuse');
  await page.waitForFunction(() => !document.querySelector('main'), undefined, { timeout: 10_000 });
  await versPage(page, cible);
  await page.waitForFunction(() => !!document.querySelector('main')?.firstElementChild, undefined, { timeout: 10_000 });
}
// Route : le premier élément de <main> est marqué, puis on attend qu'un nouvel élément l'occupe (page montée, ou
// redirection achevée). Si rien ne change en 2 s alors que l'adresse est restée celle demandée, la route montre le même
// écran que la précédente (mutant M18) : elle est rejouée depuis la page neutre. Rend le chemin d'arrivée.
export async function jouerRoute(page: Page, cible: string) {
  if (chemin(page) === cible) return cible;
  await page.evaluate(() => document.querySelector('main')?.firstElementChild?.setAttribute('data-ancien', ''));
  await versPage(page, cible);
  try {
    await page.waitForFunction(() => { const e = document.querySelector('main')?.firstElementChild; return !!e && !e.hasAttribute('data-ancien'); }, undefined, { timeout: 2_000 });
  } catch (erreur) {
    if (chemin(page) !== cible) throw erreur;
    await depuisPageNeutre(page, cible);
  }
  return chemin(page);
}
// Écran : toujours monté à neuf depuis la page neutre (aucune fiche ni aucun titre de l'écran précédent), puis 250 ms
// de calme, le chronomètre du calme remis à zéro à la navigation. Rend le chemin d'arrivée.
export async function jouerEcran(page: Page, etat: EtatReseau, cible: string) {
  await depuisPageNeutre(page, cible);
  etat.dernier = Date.now();
  await auCalme(page, etat);
  return chemin(page);
}

// --- Lecture d'un écran ---
export const titreDeLEcran = (page: Page) => page.evaluate(() => (document.querySelector('main h1, main h2')?.textContent || '').replace(/\s+/g, ' ').trim());
// Portée des boutons lus (cadrage §6.2) :
//  - « tout » : tout <main> ;
//  - « hors lignes » : <main>, sauf les boutons portés par une ligne (tr, li, article) ;
//  - une ligne cible, désignée par un sélecteur CSS ou par le texte qu'elle porte (la ligne la plus profonde qui le porte).
// Dans toutes les portées : seuls les boutons visibles, la pagination (nav) exclue, son état dépendant du nombre de pièces
// de toute la base. Un bouton présent plusieurs fois est répété. Rend null si la ligne cible est absente.
export type Portee = { tout: true } | { horsLignes: true } | { selecteur: string } | { texte: string };
export async function boutonsDe(page: Page, portee: Portee): Promise<string[] | null> {
  const resultat = await page.evaluate((p) => {
    const main = document.querySelector('main');
    if (!main) return { erreur: 'aucun <main>' };
    let racines: Element[] = [main];
    if ('selecteur' in p) racines = Array.from(main.querySelectorAll(p.selecteur));
    if ('texte' in p) {
      const candidates = Array.from(main.querySelectorAll('tr, li, article')).filter((e) => (e.textContent || '').includes(p.texte));
      racines = candidates.filter((e) => !candidates.some((autre) => autre !== e && e.contains(autre)));
    }
    if (racines.length === 0) return { absente: true };
    if (racines.length > 1) return { erreur: `${racines.length} lignes pour ${JSON.stringify(p)}` };
    const noms: string[] = [];
    for (const el of Array.from(racines[0].querySelectorAll('button, [role="button"]')) as HTMLElement[]) {
      if (!el.checkVisibility()) continue;
      if (el.closest('nav')) continue;
      if ('horsLignes' in p && el.closest('tr, li, article')) continue;
      const nom = (el.getAttribute('aria-label') || (el.textContent || '').replace(/\s+/g, ' ').trim() || el.getAttribute('title') || '').trim();
      noms.push(nom + ((el as HTMLButtonElement).disabled ? ' (désactivé)' : ''));
    }
    return { noms };
  }, portee);
  if ('erreur' in resultat) throw new Error(`lecture des boutons : ${resultat.erreur}`);
  if ('absente' in resultat) return null;
  return resultat.noms;
}
// Commandes d'une ligne (boutons, cases et listes), avec leur état : ligne d'un compte dans Administration ›
// Utilisateurs. Une liste sans nom accessible porte ses options (types de compte proposés) ; une liste nommée ne les
// porte pas, ses options suivant les comptes de toute la base (responsables proposables).
export async function commandesDeLigne(page: Page, selecteur: string) {
  return page.locator(selecteur).evaluate((ligne) => Array.from(ligne.querySelectorAll('button, input[type="checkbox"], select')).map((el) => {
    const etiquette = el.getAttribute('aria-label');
    const nom = (etiquette || (el.tagName === 'SELECT' ? '' : (el.closest('label')?.textContent || el.textContent || '').replace(/\s+/g, ' ').trim()) || el.getAttribute('title') || '').trim();
    const sorte = el.tagName === 'INPUT' ? 'case' : el.tagName === 'SELECT' ? 'liste' : 'bouton';
    const options = el.tagName === 'SELECT' && !etiquette ? ` (options : ${Array.from((el as HTMLSelectElement).options).map((o) => o.textContent?.trim()).join(', ')})` : '';
    return `${sorte} « ${nom} »${options}${(el as HTMLInputElement).disabled ? ' (désactivé)' : ''}`;
  }));
}
