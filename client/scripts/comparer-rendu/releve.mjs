// Relevé d'un client : chaque scénario ouvre une session neuve, va sur un écran, puis enchaîne
// des actions sans écriture (onglets, modales ouvertes puis abandonnées, filtres). Après le
// chargement et après chaque action, l'étape relève l'URL, la liste ordonnée des requêtes API,
// l'état des champs de formulaire et le HTML de <main>, où sont rendues toutes les modales
// (aucun portail), ainsi que tout dialogue ou calque fixe qui serait rendu hors de <main>.
//
// Ordre déterministe des requêtes : l'outil retient les réponses API et les libère une à une,
// dans l'ordre d'émission. Avant chaque libération, et avant de relever, il attend que la page
// soit calme : toutes les requêtes API émises par `fetch` (comptées dans la page) ont été
// interceptées, aucune autre ressource n'est en cours, et le DOM n'a pas changé pendant
// SILENCE_MS. Une requête déclenchée par une action ou par une réponse ne peut donc pas
// échapper au relevé, et les requêtes enchaînées gardent toujours le même rang.
// Toute écriture est bloquée et relevée ; toute requête hors de l'origine du client (polices
// en ligne, services du navigateur) est abandonnée, pour que le relevé ne dépende pas du réseau.
import { jetonPour } from './commun.mjs';
import { scenarios } from './scenarios.mjs';

const SILENCE_MS = Number(process.env.RELEVE_SILENCE_MS || '300');
const DELAI_MAX_MS = 120_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Compteurs tenus dans la page dès son premier script : appels `fetch` vers /api et mutations du DOM.
function instrumenter() {
  const compteurs = { emises: 0, mutations: 0 };
  Object.defineProperty(window, '__releve', { value: compteurs });
  const fetchOrigine = window.fetch;
  window.fetch = function fetchCompte(entree, init) {
    const url = typeof entree === 'string' || entree instanceof URL ? String(entree) : entree.url;
    if (new URL(url, location.href).pathname.startsWith('/api/')) compteurs.emises += 1;
    return fetchOrigine.call(this, entree, init);
  };
  new MutationObserver(() => { compteurs.mutations += 1; })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

async function suivreReseau(contexte, urlBase) {
  const origine = new URL(urlBase).origin;
  const etat = { attente: [], requetes: [], interceptees: 0, enVol: 0 };
  const estApi = (url) => url.origin === origine && url.pathname.startsWith('/api/');
  contexte.on('request', (requete) => { if (!estApi(new URL(requete.url()))) etat.enVol += 1; });
  const fin = (requete) => { if (!estApi(new URL(requete.url()))) etat.enVol -= 1; };
  contexte.on('requestfinished', fin);
  contexte.on('requestfailed', fin);
  await contexte.route('**/*', (route) => {
    const requete = route.request();
    const url = new URL(requete.url());
    if (url.origin !== origine) return route.abort();
    if (!estApi(url)) return route.continue();
    const ligne = `${requete.method()} ${url.pathname}${url.search}`;
    etat.interceptees += 1;
    if (requete.method() !== 'GET') {
      etat.requetes.push(`${ligne}  [écriture bloquée par l'outil]`);
      return route.abort();
    }
    etat.requetes.push(ligne);
    etat.attente.push(route);
  });
  return etat;
}

async function attendreCalme(page, etat) {
  const limite = Date.now() + DELAI_MAX_MS;
  let repere = null;
  let depuis = Date.now();
  for (;;) {
    let compteurs = null;
    try {
      compteurs = await page.evaluate(() => window.__releve ? { emises: window.__releve.emises, mutations: window.__releve.mutations } : null);
    } catch { /* navigation en cours */ }
    const signature = compteurs && etat.enVol === 0 && compteurs.emises === etat.interceptees
      ? `${compteurs.mutations}/${etat.interceptees}` : null;
    if (signature === null || signature !== repere) {
      repere = signature;
      depuis = Date.now();
    } else if (Date.now() - depuis >= SILENCE_MS) {
      return;
    }
    if (Date.now() > limite) {
      throw new Error(`page jamais calme après ${DELAI_MAX_MS / 1000} s : ${etat.enVol} ressource(s) en cours, ${compteurs?.emises ?? '?'} requête(s) API émise(s) pour ${etat.interceptees} interceptée(s)`);
    }
    await pause(25);
  }
}

async function stabiliser(page, etat) {
  for (;;) {
    await attendreCalme(page, etat);
    const route = etat.attente.shift();
    if (!route) return;
    await route.fulfill({ response: await route.fetch() });
  }
}

async function instantane(page, etat) {
  const { html, champs, horsMain } = await page.evaluate(() => {
    const main = document.querySelector('main');
    const description = [...(main?.querySelectorAll('input, select, textarea') ?? [])].map((champ) => [
      champ.tagName.toLowerCase(),
      `name=${champ.getAttribute('name') ?? ''}`,
      `aria-label=${champ.getAttribute('aria-label') ?? ''}`,
      `type=${champ.getAttribute('type') ?? ''}`,
      `value=${JSON.stringify(champ.value)}`,
      champ.type === 'checkbox' || champ.type === 'radio' ? `checked=${champ.checked}` : '',
      champ.tagName === 'SELECT' ? `selectedIndex=${champ.selectedIndex}` : '',
      champ.disabled ? 'disabled' : '',
      document.activeElement === champ ? 'focus' : '',
    ].filter(Boolean).join(' '));
    const dehors = [...document.querySelectorAll('[role="dialog"], .fixed')].filter((element) => !main?.contains(element));
    return {
      html: main ? main.outerHTML : '(aucun <main>)',
      champs: description,
      horsMain: dehors.map((element) => element.outerHTML),
    };
  });
  const url = new URL(page.url());
  const enLignes = (texte) => texte.replace(/></g, '>\n<');
  return [
    `# URL\n${url.pathname}${url.search}`,
    `# Requêtes API (ordre d'émission)\n${etat.requetes.join('\n') || '(aucune)'}`,
    `# Champs\n${champs.join('\n') || '(aucun)'}`,
    `# HTML de <main>\n${enLignes(html)}`,
    `# Dialogues et calques fixes hors de <main>\n${horsMain.map(enLignes).join('\n') || '(aucun)'}`,
    '',
  ].join('\n\n');
}

async function ouvrirSession(navigateur, urlBase, compteId, instant) {
  const contexte = await navigateur.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris', viewport: { width: 1366, height: 900 }, baseURL: urlBase });
  await contexte.clock.setFixedTime(instant);
  const jeton = jetonPour(compteId);
  // Le compte tel que le renvoie /api/me : l'écran lit son rôle dans le localStorage dès le
  // premier rendu (onglet de départ d'Admin, droits de la fiche chantier).
  const reponse = await fetch(`${urlBase}/api/me`, { headers: { Authorization: `Bearer ${jeton}` } });
  if (!reponse.ok) throw new Error(`/api/me pour ${compteId} : ${reponse.status}`);
  const compte = await reponse.json();
  await contexte.addInitScript(([token, user]) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', user);
  }, [jeton, JSON.stringify(compte)]);
  await contexte.addInitScript(instrumenter);
  const etat = await suivreReseau(contexte, urlBase);
  const page = await contexte.newPage();
  page.on('dialog', (dialogue) => dialogue.dismiss());
  return { contexte, page, etat };
}

async function ouvrir(page, etat, url) {
  etat.interceptees = 0;
  await page.goto(url, { waitUntil: 'load' });
  await stabiliser(page, etat);
}

// Chauffe : Vite compile et optimise les modules à la première visite, et peut alors recharger
// la page. Une visite de chaque écran avant le relevé écarte ce rechargement des relevés.
async function chauffer(navigateur, urlBase, donnees, instant) {
  for (const scenario of scenarios(donnees)) {
    const { contexte, page, etat } = await ouvrirSession(navigateur, urlBase, scenario.compte, instant);
    try {
      await ouvrir(page, etat, scenario.url);
    } finally {
      await contexte.close();
    }
  }
}

// `enregistrer(cle, contenu)` est appelé à chaque étape : un relevé interrompu reste lisible.
export async function relever(navigateur, urlBase, donnees, instant, enregistrer) {
  await chauffer(navigateur, urlBase, donnees, instant);
  const releves = {};
  const garder = (cle, contenu) => { releves[cle] = contenu; enregistrer(cle, contenu); };
  for (const scenario of scenarios(donnees)) {
    const { contexte, page, etat } = await ouvrirSession(navigateur, urlBase, scenario.compte, instant);
    try {
      await ouvrir(page, etat, scenario.url);
      garder(scenario.nom, await instantane(page, etat));
      for (const [indice, action] of scenario.actions.entries()) {
        etat.requetes = [];
        await action.faire(page);
        await stabiliser(page, etat);
        garder(`${scenario.nom}.${String(indice + 1).padStart(2, '0')}-${action.nom}`, await instantane(page, etat));
      }
    } finally {
      await contexte.close();
    }
  }
  return releves;
}
