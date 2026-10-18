// Relevé d'un client : chaque scénario ouvre une session neuve, va sur un écran, puis enchaîne
// des actions sans écriture (onglets, modales ouvertes puis abandonnées). Après le chargement
// et après chaque action, l'étape relève l'URL, la liste ordonnée des requêtes API, l'état des
// champs de formulaire et le HTML de <main>, où sont rendues toutes les modales (aucun portail).
//
// Ordre déterministe des requêtes : l'outil retient les réponses API et les libère une à une,
// dans l'ordre d'émission ; après chacune, il attend que la page n'émette plus rien pendant
// SILENCE_MS. Les requêtes déclenchées par une réponse s'enchaînent donc toujours au même
// rang, quel que soit le temps de réponse du serveur. Toute écriture est bloquée et relevée.
import { jetonPour } from './commun.mjs';
import { scenarios } from './scenarios.mjs';

const SILENCE_MS = Number(process.env.RELEVE_SILENCE_MS || '300');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function suivreReseau(contexte, page) {
  const etat = { attente: [], requetes: [], enVol: 0, dernier: Date.now() };
  const activite = () => { etat.dernier = Date.now(); };
  // Ressources hors API (modules servis par Vite) : la page n'est stable qu'une fois chargées.
  page.on('request', (requete) => { if (!new URL(requete.url()).pathname.startsWith('/api/')) { etat.enVol += 1; activite(); } });
  const fin = (requete) => { if (!new URL(requete.url()).pathname.startsWith('/api/')) { etat.enVol -= 1; activite(); } };
  page.on('requestfinished', fin);
  page.on('requestfailed', fin);
  contexte.route('**/api/**', (route) => {
    const requete = route.request();
    const url = new URL(requete.url());
    const ligne = `${requete.method()} ${url.pathname}${url.search}`;
    activite();
    if (requete.method() !== 'GET') {
      etat.requetes.push(`${ligne}  [écriture bloquée par l'outil]`);
      return route.abort();
    }
    etat.requetes.push(ligne);
    etat.attente.push(route);
  });
  return etat;
}

async function stabiliser(etat, page) {
  const limite = Date.now() + 120_000;
  for (;;) {
    while (etat.enVol > 0 || Date.now() - etat.dernier < SILENCE_MS) {
      if (Date.now() > limite) throw new Error(`page jamais stable : ${etat.enVol} ressource(s) en cours, ${etat.attente.length} réponse(s) retenue(s)`);
      await pause(25);
    }
    const route = etat.attente.shift();
    if (!route) break;
    await route.fulfill({ response: await route.fetch() });
    etat.dernier = Date.now();
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function instantane(page, etat) {
  const { html, champs } = await page.evaluate(() => {
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
    return { html: main ? main.outerHTML : '(aucun <main>)', champs: description };
  });
  const url = new URL(page.url());
  return [
    `# URL\n${url.pathname}${url.search}`,
    `# Requêtes API (ordre d'émission)\n${etat.requetes.join('\n') || '(aucune)'}`,
    `# Champs\n${champs.join('\n') || '(aucun)'}`,
    `# HTML de <main>\n${html.replace(/></g, '>\n<')}`,
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
  const page = await contexte.newPage();
  page.on('dialog', (dialogue) => dialogue.dismiss());
  return { contexte, page, etat: suivreReseau(contexte, page) };
}

// Chauffe : Vite compile et optimise les modules à la première visite, et peut alors recharger
// la page. Une visite de chaque écran avant le relevé écarte ce rechargement des relevés.
export async function chauffer(navigateur, urlBase, donnees, instant) {
  for (const scenario of scenarios(donnees)) {
    const { contexte, page, etat } = await ouvrirSession(navigateur, urlBase, scenario.compte, instant);
    await page.goto(scenario.url, { waitUntil: 'load' });
    await stabiliser(etat, page);
    await contexte.close();
  }
}

export async function relever(navigateur, urlBase, donnees, instant) {
  await chauffer(navigateur, urlBase, donnees, instant);
  const releves = {};
  for (const scenario of scenarios(donnees)) {
    const { contexte, page, etat } = await ouvrirSession(navigateur, urlBase, scenario.compte, instant);
    try {
      await page.goto(scenario.url, { waitUntil: 'load' });
      await stabiliser(etat, page);
      releves[scenario.nom] = await instantane(page, etat);
      for (const [indice, action] of scenario.actions.entries()) {
        etat.requetes = [];
        await action.faire(page);
        await stabiliser(etat, page);
        releves[`${scenario.nom}.${String(indice + 1).padStart(2, '0')}-${action.nom}`] = await instantane(page, etat);
      }
    } finally {
      await contexte.close();
    }
  }
  return releves;
}
