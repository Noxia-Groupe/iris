// Lot 6a-4c : rapport de chantier remis au client, produit par le serveur (cadrage du lot 6a-4, version 6 du
// 31-10-2026, section « 6a-4c » ; réponse de Nelson du 31-10-2026, 14:46 UTC, mot pour mot : « Concernant la
// question sur le rapport de chantier envoyé au client, effectivement il ne doit pas y avoir de montant ni de
// heures » ; décisions du 22-10-2026, point 4, « Tous type de document »).
//
// Requêtes HTTP réelles sur l'application montée en mémoire, contre un vrai PostgreSQL. Fichier propre au lot
// (consigne de Claude Code, comme N10 du cadrage) : rien n'est ajouté à api.test.mjs. `node --test` exécute les
// fichiers de tests en parallèle, et api.test.mjs, qui tourne en même temps sur TEST_DATABASE_URL, purge les
// données « TEST » et change l'identité et le fuseau de la société en cours de route. Ce fichier crée donc, sur
// le même serveur PostgreSQL, une base jetable qui n'appartient qu'à lui, la migre, la sert à l'application,
// puis la supprime ; TEST_DATABASE_URL ne sert que de connexion administrative. Sans elle, il s'annonce ignoré :
// un SKIP n'est pas une réussite.
//
// Absence de montant et d'heures (cadrage, « Portée de « ni montant ni heures » » et « Tests ») : des valeurs
// témoins reconnaissables, qui ne recoupent ni un horodatage ni une date (aucune ne s'écrit JJ-MM-AAAA ni HH:MM),
// sont posées dans les budgets, le coût d'achat prévu, les lignes de budget, les achats, les pointages, une
// facture émise et son avoir, les heures et le matériel d'une intervention. Chacune est cherchée sous ses
// écritures plausibles (à la française, à l'anglaise, en heures et minutes, en minutes), et tout le texte de
// chaque rapport est en outre passé au crible de motifs génériques (symbole monétaire, HT/TTC, nombre décimal,
// durée, pourcentage, libellés des montants). La société des tests a un pied de page sans montant.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import { PDFParse } from 'pdf-parse';

const TITRE = 'Lot 6a-4c : rapport de chantier remis au client, produit par le serveur';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Refus du cadrage, mot pour mot : requireAdmin (« Lecteurs »), « 404 « Chantier introuvable » » et « 409 si
// l'identité de la société est incomplète (« … avant d’imprimer un rapport de chantier ») » ; le début du message
// est celui d'IdentiteEmetteurIncompleteError, commun aux autres PDF.
const REFUS_ADMINISTRATION = 'Accès réservé aux administrateurs';
const CHANTIER_INTROUVABLE = 'Chantier introuvable';
const identiteIncomplete = (champs) => `Identité de la société incomplète : renseignez ${champs} dans l’écran Société avant d’imprimer un rapport de chantier.`;
const ROLES_NON_ADMINISTRATEURS = ['CONDUCTEUR_TRAVAUX', 'COMMERCIAL', 'ASSISTANTE_COMMERCIALE', 'TECHNICIEN', 'COMPTABLE', 'DIRECTEUR_COMMERCIAL', 'RESPONSABLE', 'DIRECTEUR'];
const TOUS_LES_SCOPES = ['clients:read', 'clients:write', 'catalogue:read', 'catalogue:write', 'equipements:read', 'equipements:write', 'devis:read', 'devis:write', 'company:read', 'chantiers:read', 'chantiers:write', 'chantiers:archive', 'finances:read'];

// --- Outils sans base : texte et tracés d'un PDF, dates attendues ---

// Texte aplati : un repli de ligne du PDF ne doit pas faire échouer la recherche d'une phrase.
const aplatir = (texte) => texte.replace(/\s+/g, ' ');
const sansBlancs = (texte) => texte.replace(/\s+/g, '');
const occurrences = (texte, motif) => texte.split(motif).length - 1;
const echapper = (texte) => texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// « JJ-MM-AAAA HH:MM » d'un instant dans un fuseau (cadrage : horodatage de chaque compte rendu au fuseau de la
// société, comme sur le PDF du compte rendu).
function dateHeure(instant, fuseau) {
  const parties = new Intl.DateTimeFormat('en-GB', {
    timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const valeur = (type) => parties.find((partie) => partie.type === type).value;
  return `${valeur('day')}-${valeur('month')}-${valeur('year')} ${valeur('hour')}:${valeur('minute')}`;
}
const jour = (instant, fuseau) => dateHeure(instant, fuseau).slice(0, 10);

// Chemins tracés au trait de tous les flux de contenu, en coordonnées de la page (repris de
// compte-rendu-pdf.test.mjs, lot 6a-4a) : la matrice courante (q, Q, cm) est appliquée à chaque point.
function cheminsTraces(octets) {
  const brut = octets.toString('latin1');
  const chemins = [];
  for (const flux of brut.matchAll(/stream\r?\n/g)) {
    const debut = flux.index + flux[0].length;
    let contenu;
    try { contenu = inflateSync(octets.subarray(debut, brut.indexOf('endstream', debut))).toString('latin1'); } catch { continue; }
    let matrice = [1, 0, 0, 1, 0, 0];
    const pile = [];
    let operandes = [];
    let courant = null;
    let enCours = [];
    const appliquer = ([x, y]) => [matrice[0] * x + matrice[2] * y + matrice[4], matrice[1] * x + matrice[3] * y + matrice[5]];
    const jetons = contenu.match(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s/[\]()<>]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+/g) ?? [];
    for (const jeton of jetons) {
      if (/^[-+]?(?:\d|\.\d)/.test(jeton)) { operandes.push(Number(jeton)); continue; }
      if (!/^[A-Za-z'"*]+$/.test(jeton)) continue;
      switch (jeton) {
        case 'q': pile.push(matrice); break;
        case 'Q': matrice = pile.pop() ?? [1, 0, 0, 1, 0, 0]; break;
        case 'cm': {
          const [a, b, c, d, e, f] = operandes.slice(-6);
          const [A, B, C, D, E, F] = matrice;
          matrice = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
          break;
        }
        case 'm': courant = [appliquer(operandes.slice(-2))]; enCours.push(courant); break;
        case 'l': if (courant) courant.push(appliquer(operandes.slice(-2))); break;
        case 'c': case 'v': case 'y': if (courant) { courant.courbe = true; courant.push(appliquer(operandes.slice(-2))); } break;
        case 're': courant = null; break;
        case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': chemins.push(...enCours.filter((chemin) => !chemin.courbe)); enCours = []; courant = null; break;
        case 'f': case 'F': case 'f*': case 'n': enCours = []; courant = null; break;
        default: break;
      }
      operandes = [];
    }
  }
  return chemins;
}

// Ajuste, axe par axe, les points d'un chemin aux points normalisés d'un trait : X = origine + pente × x.
function ajuster(points, normalises) {
  const axe = (mesures, reperes) => {
    const n = mesures.length;
    const moyenneRepere = reperes.reduce((s, v) => s + v, 0) / n;
    const moyenneMesure = mesures.reduce((s, v) => s + v, 0) / n;
    const variance = reperes.reduce((s, v) => s + (v - moyenneRepere) ** 2, 0);
    if (variance === 0) return null;
    const pente = reperes.reduce((s, v, i) => s + (v - moyenneRepere) * (mesures[i] - moyenneMesure), 0) / variance;
    const origine = moyenneMesure - pente * moyenneRepere;
    const ecart = Math.max(...reperes.map((v, i) => Math.abs(mesures[i] - (origine + pente * v))));
    return { pente, origine, ecart };
  };
  const x = axe(points.map(([X]) => X), normalises.map(([px]) => px));
  const y = axe(points.map(([, Y]) => Y), normalises.map(([, py]) => py));
  return x && y ? { x, y } : null;
}

// Le tracé est reproduit en vectoriel s'il existe, pour chaque trait, un chemin tracé de même nombre de points,
// posé sur un même cadre pour tous les traits, au ratio du tracé, ni déformé, ni retourné (comme 6a-4a).
function traceReproduit(chemins, trace) {
  const candidats = trace.traits.map((trait) => chemins
    .filter((chemin) => chemin.length === trait.length)
    .map((chemin) => ajuster(chemin, trait))
    .filter((cadre) => cadre && cadre.x.pente > 10 && cadre.y.pente < -4 && cadre.x.ecart < 0.1 && cadre.y.ecart < 0.1
      && Math.abs(cadre.x.pente / -cadre.y.pente - trace.ratio) < trace.ratio * 0.01));
  const meme = (a, b) => ['x', 'y'].every((k) => Math.abs(a[k].pente - b[k].pente) < 0.2 && Math.abs(a[k].origine - b[k].origine) < 0.2);
  return candidats[0].some((cadre) => candidats.every((liste) => liste.some((autre) => meme(cadre, autre))));
}

// --- Ni montant ni heures (cadrage, « Portée de « ni montant ni heures » ») ---

// Un nombre témoin sous ses écritures plausibles : séparateur des milliers facultatif (espace, espace insécable
// ou fine, point), virgule ou point décimal. Borné par ce qui n'est ni lettre ni chiffre : une empreinte
// hexadécimale, d'un seul tenant, ne le contient jamais par hasard.
function nombreTemoin(valeur, { avecDecimales = true } = {}) {
  const [entier, decimales] = valeur.split('.');
  const groupes = entier.replace(/\B(?=(\d{3})+(?!\d))/g, ' ').split(' ');
  const partieEntiere = groupes.join('[\\s.\\u00a0\\u202f]?');
  const partieDecimale = avecDecimales && decimales ? `[,.]${decimales}` : '';
  return new RegExp(`(?<![\\p{L}\\d])${partieEntiere}${partieDecimale}(?!\\d)`, 'u');
}
// Une durée témoin, en heures décimales, en heures et minutes, et en minutes.
function dureeTemoin(heuresDecimales) {
  const totalMinutes = Math.round(Number(heuresDecimales) * 60);
  const heures = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return [
    nombreTemoin(heuresDecimales),
    new RegExp(`(?<![\\p{L}\\d])${heures}\\s?h\\s?${minutes}(?!\\d)`, 'u'),
    new RegExp(`${nombreTemoin(String(totalMinutes), { avecDecimales: false }).source}\\s?min`, 'u'),
  ];
}

// Motifs génériques, appliqués à tout rapport imprimé par ce fichier : aucun montant ni aucune durée, sous
// quelque forme que ce soit. Les données des tests ne portent aucun de ces motifs (aucun nombre décimal, aucun
// « h », « heures » ni « euros » après un nombre, aucun de ces mots) : un motif trouvé ne peut venir que d'un
// montant ou d'une durée ajoutés au rapport. L'horodatage JJ-MM-AAAA HH:MM des comptes rendus n'en déclenche aucun.
const MOTIFS_INTERDITS = [
  [/€/u, 'symbole euro'],
  [/(?<!\p{L})EUR(?!\p{L})/u, 'code EUR'],
  [/(?<!\p{L})(HT|TTC|TVA)(?!\p{L})/u, 'mention HT, TTC ou TVA'],
  [/\d,\d/u, 'nombre décimal à la française'],
  [/\d\.\d/u, 'nombre décimal à l’anglaise'],
  [/(?<![\p{L}\d])\d+(?:[,.]\d+)?\s?h(?:\s?\d{1,2})?(?!\p{L})/u, 'durée en heures'],
  [/(?<!\p{L})min(?:utes?)?(?!\p{L})/iu, 'durée en minutes'],
  // Un nombre suivi de l'unité en toutes lettres (« 37 heures », « 877 euros ») : un montant ou une durée arrondis
  // n'ont ni décimale ni symbole.
  [/(?<![\p{L}\d])\d+(?:[\s.,\u00a0\u202f]\d+)*\s?(?:heures?|euros?)(?!\p{L})/iu, 'montant ou durée en toutes lettres'],
  [/%/u, 'pourcentage (avancement)'],
  [/budget|marge|vendu|factur|co[uû]t|achat|pointag|avancement|rentabilit|réalis/iu, 'libellé d’un montant ou d’heures'],
];
function verifierSansMontantNiHeure(plat, texte) {
  for (const [motif, libelle] of MOTIFS_INTERDITS) assert.doesNotMatch(plat, motif, `${libelle} imprimé\n${texte}`);
}

// Blocs des interventions imprimées : du libellé « Intervention ‹référence› » de l'une à celui de la suivante.
// Les références doivent figurer dans l'ordre donné, chacune une seule fois.
function blocsInterventions(plat, references) {
  const positions = references.map((reference) => {
    const motif = new RegExp(`Intervention ${echapper(reference)}(?!\\d)`, 'g');
    const trouvees = [...plat.matchAll(motif)];
    assert.equal(trouvees.length, 1, `« Intervention ${reference} » imprimée ${trouvees.length} fois\n${plat}`);
    return trouvees[0].index;
  });
  for (let rang = 1; rang < positions.length; rang += 1) {
    assert.ok(positions[rang - 1] < positions[rang], `ordre des interventions : ${references[rang - 1]} avant ${references[rang]}\n${plat}`);
  }
  return Object.fromEntries(references.map((reference, rang) => [reference, plat.slice(positions[rang], positions[rang + 1] ?? plat.length)]));
}

if (!TEST_DATABASE_URL) {
  describe(TITRE, { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  describe(TITRE, () => {
    const source = new URL(TEST_DATABASE_URL);
    // « test » comme mot (règle de client/scripts/base-jetable.mjs) et un suffixe tiré au hasard : deux
    // exécutions simultanées ne partagent jamais leur base.
    const nomBase = `iris_test_rapport6a4c_${randomBytes(6).toString('hex')}`;
    const maintenance = new URL(source);
    maintenance.pathname = '/postgres';
    const cible = new URL(source);
    cible.pathname = `/${nomBase}`;
    const administrationPg = new pg.Client({ connectionString: maintenance.toString() });
    let baseCreee = false;

    let request; let app; let prisma; let appPrisma; let jwt;
    let session = '';
    let secours = { id: '', name: '' };

    const entete = (jeton) => ({ Authorization: `Bearer ${jeton}` });
    const admin = () => entete(session);
    const jetonDe = (compte) => jwt.sign({ id: compte.id }, process.env.JWT_SECRET);
    let rang = 0;
    const suffixe = () => `${Date.now()}${(rang += 1)}`;

    // Identité de la société : complète, distincte des adresses des clients et des chantiers, avec un pied de
    // page sans montant (cadrage, « Tests »).
    const SOCIETE_A = {
      raisonSociale: 'TEST Émetteur rapport A', nomCommercial: '', siret: '88888888800088', tvaIntra: '',
      adresse: '8 rue du Rapport', codePostal: '50000', ville: 'Saint-Lô', pays: 'France', telephone: '02 33 00 00 08',
      email: 'emetteur-rapport-a@iris.test', siteWeb: '', piedFacture: 'TEST Pied du rapport A, sans montant', couleurPrimaire: '#0f766e', fuseauHoraire: 'Europe/Paris',
    };
    const SOCIETE_B = { ...SOCIETE_A, raisonSociale: 'TEST Émetteur rapport B', siret: '99999999900099', adresse: '9 avenue Changée', piedFacture: 'TEST Pied du rapport B' };

    // Tracés de signature (comme 6a-4a) : deux traits au ratio 2,5 ; un trait au ratio 2.
    const TRACE_DEUX_TRAITS = { ratio: 2.5, traits: [
      [[0.1, 0.2], [0.3, 0.8], [0.5, 0.25], [0.7, 0.9], [0.9, 0.4]],
      [[0.2, 0.6], [0.8, 0.55], [0.6, 0.1]],
    ] };
    const TRACE_SIMPLE = { ratio: 2, traits: [[[0.1, 0.6], [0.25, 0.3], [0.4, 0.7], [0.6, 0.35]]] };

    // --- Aides HTTP ---
    const appeler = (methode, chemin, corps, auth = admin()) => {
      const requete = request(app)[methode](`/api${chemin}`);
      const avecAuth = auth ? requete.set(auth) : requete;
      return methode === 'get' ? avecAuth : avecAuth.send(corps ?? {});
    };
    const ok = async (reponse, statut = 200) => {
      const res = await reponse;
      assert.equal(res.status, statut, `${res.req?.method} ${res.req?.path} : ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const reussi = async (reponse) => {
      const res = await reponse;
      assert.ok(res.status >= 200 && res.status < 300, `${res.req?.method} ${res.req?.path} : ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    };
    const definirSociete = (champs) => ok(appeler('put', '/company', champs));
    // Jour civil de Paris, fuseau de la société pendant les écritures : une facture ne peut pas être future.
    const aujourdhuiParis = () => jour(new Date(), 'Europe/Paris');

    // --- Données ---
    // Client professionnel identifié (lot 6a-2 bis : un devis ne se signe, une facture ne s'émet que pour lui).
    const creerClient = async (raisonSociale) => {
      let client;
      for (let essai = 1; ; essai += 1) {
        const res = await appeler('post', '/clients', { raisonSociale, siren: String(randomInt(100_000_000, 1_000_000_000)) });
        if (res.status === 409 && essai < 5) continue;
        assert.equal(res.status, 201, JSON.stringify(res.body));
        client = res.body;
        break;
      }
      await ok(appeler('post', `/clients/${client.id}/sites`, { nom: 'TEST Facturation rapport', adresse: '3 rue de la Facturation', codePostal: '75002', ville: 'Paris', estSiteFacturation: true }), 201);
      return client;
    };
    const creerCompte = (role, cle, s, extra = {}) => prisma.user.create({ data: { email: `rapport6a4c.${cle}.${s}@iris.test`, name: `TEST ${cle} ${s}`, role, ...extra } });
    // Technicien : un compte et sa fiche d'intervenant, au taux chargé témoin de 48,13 €.
    const compteTechnicien = async (cle, s, nom = cle) => {
      const compte = await prisma.user.create({ data: { email: `rapport6a4c.technicien.${cle.toLowerCase()}.${s}@iris.test`, name: `TEST Technicien ${nom} ${s}`, role: 'TECHNICIEN' } });
      const intervenant = await prisma.intervenant.create({ data: { nom: `TEST Intervenant ${nom} ${s}`, role: 'Technicien', tauxHoraireCharge: 48.13, userId: compte.id } });
      return { compte, jeton: jetonDe(compte), intervenantId: intervenant.id, nomIntervenant: intervenant.nom };
    };
    // Chantier posé en base, toutes valeurs maîtrisées : dates seules à minuit UTC, budgets à zéro sauf témoins.
    const creerChantier = (donnees) => prisma.chantier.create({ data: { budgetGlobalVendu: 0, ...donnees } });
    const creerIntervention = (donnees, auth = admin()) => ok(appeler('post', '/interventions', donnees, auth), 201);
    const planifier = (id, intervenantIds) => ok(appeler('put', `/interventions/${id}/planning`, { dateDebut: new Date().toISOString().slice(0, 10), creneau: 'JOURNEE', intervenantIds }));
    const changerStatut = (id, statut, extra = {}) => ok(appeler('patch', `/interventions/${id}/statut`, { statut, ...extra }));
    const demarrer = async (id) => {
      const { statut } = await prisma.intervention.findUniqueOrThrow({ where: { id }, select: { statut: true } });
      if (statut === 'A_PLANIFIER') await changerStatut(id, 'PLANIFIEE');
      await changerStatut(id, 'EN_COURS');
    };
    const ajouterCompteRendu = (id, contenu, jeton = session) => ok(appeler('post', `/interventions/${id}/rapports`, { contenu, cleEnvoi: randomUUID() }, entete(jeton)), 201);
    const signer = (rapportId, signataire, trace = TRACE_SIMPLE) => ok(appeler('post', `/interventions/rapports/${rapportId}/signature`, { signataire, confirme: true, trace }), 201);
    // Chantier ouvert par la conversion d'un devis signé (seule porte d'ouverture d'une affaire).
    const chantierConverti = async (clientId, objet, ouverture = {}) => {
      const devis = await ok(appeler('post', '/devis', { clientId, objet, lignes: [{ designation: 'TEST Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] }), 201);
      await ok(appeler('put', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' }));
      await ok(appeler('post', `/devis/${devis.id}/signature`, { signataire: 'TEST Signataire du devis', confirme: true }), 201);
      const chantier = await ok(appeler('post', `/devis/${devis.id}/convertir`, { cible: 'CHANTIER', ...ouverture }), 201);
      return { devis: await prisma.devis.findUniqueOrThrow({ where: { id: devis.id } }), chantier };
    };

    // --- Lecture du rapport ---
    const cheminRapport = (id) => `/api/chantiers/${id}/document.pdf`;
    const binaire = (reponse, fin) => { const morceaux = []; reponse.on('data', (m) => morceaux.push(m)); reponse.on('end', () => fin(null, Buffer.concat(morceaux))); };
    const pdfRapport = (id, auth = admin()) => {
      const requete = request(app).get(cheminRapport(id));
      return (auth ? requete.set(auth) : requete).buffer(true).parse(binaire);
    };
    const erreurDe = (res) => JSON.parse(res.body.toString('utf8')).error;
    // Tout rapport lu ici est aussi passé au crible des motifs interdits (aucun montant, aucune durée).
    const lirePdf = async (id, auth = admin()) => {
      const res = await pdfRapport(id, auth);
      assert.equal(res.status, 200, res.body.toString('utf8').slice(0, 500));
      assert.equal(res.headers['content-type'], 'application/pdf');
      assert.equal(res.body.subarray(0, 5).toString('latin1'), '%PDF-');
      const lecteur = new PDFParse({ data: res.body });
      let texte;
      try { texte = (await lecteur.getText()).text; } finally { await lecteur.destroy(); }
      const plat = aplatir(texte);
      verifierSansMontantNiHeure(plat, texte);
      return { octets: res.body, texte, plat, disposition: res.headers['content-disposition'] };
    };
    // Partie du rapport qui décrit le chantier : tout ce qui précède la rubrique des interventions.
    const partieChantier = (plat) => {
      const fin = plat.search(/Interventions|Aucune intervention rattachée\./u);
      assert.ok(fin >= 0, `rubrique « Interventions » absente\n${plat}`);
      return plat.slice(0, fin);
    };
    // État de la base : une impression, acceptée ou refusée, n'écrit rien.
    const etatBase = async () => ({
      chantiers: (await prisma.chantier.findMany({ orderBy: { id: 'asc' }, select: { id: true, statut: true, dateFin: true, updatedAt: true } })).map((c) => JSON.stringify(c)),
      interventions: (await prisma.intervention.findMany({ orderBy: { id: 'asc' }, select: { id: true, statut: true, updatedAt: true } })).map((i) => JSON.stringify(i)),
      rapports: await prisma.interventionRapport.count(),
      signatures: await prisma.interventionSignature.count(),
      journalSaisies: await prisma.journalSaisieChantier.count(),
      journalAdministration: await prisma.journalAdministration.count(),
      envois: await prisma.envoiDocument.count(),
      factures: await prisma.facture.count(),
      societe: JSON.stringify(await prisma.companySettings.findUnique({ where: { id: 'singleton' } })),
    });
    const refusSansEcriture = async (appel, statut, contexte) => {
      const avant = await etatBase();
      const res = await appel();
      assert.equal(res.status, statut, `${contexte} : ${res.status} ${res.body?.toString?.('utf8')?.slice(0, 300)}`);
      assert.notEqual(res.headers['content-type'], 'application/pdf', `${contexte} : un refus ne porte pas de PDF`);
      assert.notEqual(res.body?.subarray?.(0, 5)?.toString('latin1'), '%PDF-', `${contexte} : un refus ne porte pas de PDF`);
      assert.deepEqual(await etatBase(), avant, `${contexte} : rien n’est écrit`);
      return res;
    };

    // Paramétrage comptable et mentions légales publiées, pour émettre une vraie facture sur le chantier témoin
    // (mêmes prérequis que la fixture E2E preparerFacturation).
    const parametrerFacturation = async () => {
      const compte = (code, libelle, nature) => ok(appeler('post', '/comptabilite/comptes', { code, libelle, nature }), 201);
      const clients = await compte('411000', 'TEST Clients rapport', 'ACTIF');
      const prestations = await compte('706000', 'TEST Prestations rapport', 'PRODUIT');
      const articles = await compte('707000', 'TEST Articles rapport', 'PRODUIT');
      const tva = await compte('445710', 'TEST TVA collectée rapport', 'TVA');
      const motif = 'TEST paramétrage comptable du rapport de chantier';
      for (const [cle, donnees] of [['CLIENT', { compteId: clients.id }], ['VENTE_PRESTATION', { compteId: prestations.id }], ['VENTE_ARTICLE', { compteId: articles.id }], ['JOURNAL_VENTES', { journal: 'VE' }]]) {
        await reussi(appeler('put', `/comptabilite/regles/${cle}`, { ...donnees, motif }));
      }
      await reussi(appeler('put', '/comptabilite/tva/20', { compteId: tva.id, motif }));
      const version = await ok(appeler('post', '/mentions-legales', { mentions: 'TEST mentions du rapport', cgv: 'TEST CGV du rapport', penalites: 'TEST pénalités du rapport' }), 201);
      await reussi(appeler('post', `/mentions-legales/${version.version}/publier`));
    };

    before(async () => {
      assert.ok(['127.0.0.1', 'localhost'].includes(source.hostname), 'seul un PostgreSQL local est autorisé');
      await administrationPg.connect();
      await administrationPg.query(`CREATE DATABASE "${nomBase}"`);
      baseCreee = true;
      const dossierServeur = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      execFileSync(resolve(dossierServeur, 'node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', resolve(dossierServeur, 'prisma/schema.prisma')], {
        env: { ...process.env, DATABASE_URL: cible.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 180_000,
      });
      process.env.DATABASE_URL = cible.toString();
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'secret-de-test-uniquement';
      process.env.BREAK_GLASS_EMAIL = 'secours@iris.test';
      process.env.BREAK_GLASS_TOKEN = 'jeton-de-secours-de-test-au-moins-32-caracteres';
      process.env.SUPERADMIN_EMAILS = 'secours@iris.test';
      request = (await import('supertest')).default;
      const serveur = await import('../dist/index.js');
      app = serveur.app;
      appPrisma = serveur.prisma;
      const { PrismaClient } = await import('@prisma/client');
      prisma = new PrismaClient({ datasources: { db: { url: cible.toString() } } });
      jwt = (await import('jsonwebtoken')).default;
      await serveur.initDb();
      await serveur.ensureSuperAdmins();
      const connexion = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(connexion.status, 200, JSON.stringify(connexion.body));
      session = connexion.body.token;
      secours = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { id: true, name: true } });
      assert.ok(secours.name, 'le compte de secours porte un nom');
      await definirSociete(SOCIETE_A);
      await parametrerFacturation();
    });

    after(async () => {
      await prisma?.$disconnect().catch(() => {});
      await appPrisma?.$disconnect().catch(() => {});
      if (baseCreee) await administrationPg.query(`DROP DATABASE IF EXISTS "${nomBase}" WITH (FORCE)`);
      await administrationPg.end().catch(() => {});
    });

    // Cadrage, « Contenu imprimé » : en-tête à l'identité actuelle de la société, pied de page compris ; titre
    // « Rapport de chantier » puis le nom ; « Référence de l'affaire », « Client » (raison sociale de la fiche),
    // « Adresse du chantier », « Nature des travaux », « Début », « Fin », « Statut » ; rubrique « Interventions »,
    // et pour chacune « Intervention ‹référence› », « Demande : ‹titre› », « Date de la demande », « Statut », puis
    // ses comptes rendus rendus comme dans le PDF du compte rendu (horodatage, auteur, texte, signature,
    // empreinte). Choix par défaut, à confirmer : identité actuelle ; libellés. « Jamais imprimés » : ni le
    // commercial, ni le conducteur du chantier en tant que tels ; l'auteur d'un compte rendu reste imprimé.
    test('contenu : identité actuelle et pied de page, titre et nom, référence, client de la fiche, adresse, nature des travaux, début, fin, statut, puis l’intervention et ses comptes rendus ; ni commercial ni conducteur', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client rapport ${s}`);
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur', s, { name: `TEST Zéphyrin Titulaire ${s}` });
      const commercial = await creerCompte('COMMERCIAL', 'commercial', s, { name: `TEST Anatole Vendeur ${s}` });
      // Le libellé historique du chantier diffère de la raison sociale de la fiche : seule la fiche s'imprime.
      const chantier = await creerChantier({
        nom: `TEST Chantier rapport ${s}`, numeroDevis: 'A26-0042', client: `TEST Libellé historique ${s}`, clientId: client.id,
        adresse: '12 rue du Chantier, 14000 Caen', dateDebut: new Date('2026-02-03T00:00:00.000Z'), dateFin: new Date('2026-02-27T00:00:00.000Z'),
        types: ['Vidéo', 'Alarme'], responsableId: conducteur.id, commercialId: commercial.id,
      });
      const technicien = await compteTechnicien('alpha', s, 'Alpha');
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande du chantier ${s}`, dateDemande: '05-02-2026' });
      await planifier(intervention.id, [technicien.intervenantId]);
      await demarrer(intervention.id);
      const premier = await ajouterCompteRendu(intervention.id, 'TEST Premier compte rendu du chantier : diagnostic.', technicien.jeton);
      const second = await ajouterCompteRendu(intervention.id, 'TEST Second compte rendu du chantier : remise en service.');
      const signature = await signer(second.id, 'TEST Claire Dupont', TRACE_DEUX_TRAITS);

      const avant = await etatBase();
      const { texte, plat, disposition } = await lirePdf(chantier.id);
      assert.deepEqual(await etatBase(), avant, 'lire le rapport n’écrit rien');
      assert.match(disposition, new RegExp(`^(inline|attachment); filename="Rapport-chantier-TEST-Chantier-rapport-${s}\\.pdf"$`), disposition);

      // Titre, puis le nom du chantier.
      const titre = plat.indexOf('Rapport de chantier');
      assert.ok(titre >= 0, `titre « Rapport de chantier » absent\n${texte}`);
      assert.ok(plat.indexOf(chantier.nom, titre) > titre, `nom du chantier absent ou avant le titre\n${texte}`);
      // En-tête : identité actuelle de la société ; pied de page tel qu'il est saisi.
      for (const attendu of ['TEST Émetteur rapport A', 'SIRET 88888888800088', '8 rue du Rapport', '50000 Saint-Lô', SOCIETE_A.piedFacture]) {
        assert.ok(plat.includes(attendu), `absent du PDF : ${attendu}\n${texte}`);
      }
      // Chantier.
      const chantierImprime = partieChantier(plat);
      assert.match(chantierImprime, /Référence de l['’]affaire : A26-0042/u, texte);
      assert.ok(chantierImprime.includes(`Client : ${client.raisonSociale}`), `client de la fiche absent\n${texte}`);
      assert.ok(!plat.includes(`TEST Libellé historique ${s}`), `libellé historique imprimé à la place de la fiche\n${texte}`);
      assert.ok(chantierImprime.includes('Adresse du chantier : 12 rue du Chantier, 14000 Caen'), texte);
      const nature = chantierImprime.match(/Nature des travaux : ([^:]+)/u);
      assert.ok(nature && nature[1].includes('Vidéo') && nature[1].includes('Alarme'), `nature des travaux\n${texte}`);
      // Dates seules, telles qu'elles sont enregistrées.
      assert.ok(chantierImprime.includes('Début : 03-02-2026') && chantierImprime.includes('Fin : 27-02-2026'), `début et fin\n${texte}`);
      assert.match(chantierImprime, /Statut : en cours(?!\p{L})/u, `statut du chantier\n${texte}`);
      // Un chantier en cours ne porte aucune mention d'annulation.
      assert.doesNotMatch(plat, /annul/iu, texte);

      // L'intervention et ses comptes rendus, dans l'ordre, rendus comme sur le PDF du compte rendu (6a-4a).
      assert.ok(plat.includes('Interventions'), `rubrique « Interventions » absente\n${texte}`);
      const { [intervention.reference]: bloc } = blocsInterventions(plat, [intervention.reference]);
      for (const attendu of [
        `Demande : TEST Demande du chantier ${s}`, 'Date de la demande : 05-02-2026',
        `${dateHeure(premier.createdAt, 'Europe/Paris')} — ${technicien.compte.name}`, premier.contenu,
        `${dateHeure(second.createdAt, 'Europe/Paris')} — ${secours.name}`, second.contenu,
        `Signé par TEST Claire Dupont le ${jour(signature.accepteLe, 'Europe/Paris')}.`,
      ]) assert.ok(bloc.includes(attendu), `absent du bloc de l’intervention : ${attendu}\n${texte}`);
      assert.match(bloc, /Statut : en cours(?!\p{L})/u, `statut de l’intervention\n${texte}`);
      assert.ok(sansBlancs(bloc).includes(sansBlancs(`Empreinte de la signature (SHA-256) : ${signature.empreinte}`)), `empreinte de la signature absente\n${texte}`);
      assert.ok(bloc.indexOf(premier.contenu) < bloc.indexOf(second.contenu), `ordre des comptes rendus\n${texte}`);
      assert.ok(bloc.indexOf(second.contenu) < bloc.indexOf('Signé par TEST Claire Dupont'), `signature hors de son compte rendu\n${texte}`);
      assert.ok(!bloc.includes('Aucun compte rendu.') && !plat.includes('Non signé par le client'), texte);
      // Ni le commercial ni le conducteur du chantier, ni leur rôle.
      for (const absent of [conducteur.name, commercial.name, 'Zéphyrin', 'Anatole', conducteur.email, commercial.email]) assert.ok(!plat.includes(absent), `imprimé à tort : ${absent}\n${texte}`);
      assert.doesNotMatch(plat, /commercial|conducteur|titulaire|responsable/iu, texte);
      // Ni le courriel de l'auteur d'un compte rendu, donnée personnelle superflue sur un document remis au client :
      // son nom seul, comme sur le PDF du compte rendu (rendu partagé, rendreComptesRendus).
      for (const absent of [technicien.compte.email, process.env.BREAK_GLASS_EMAIL]) {
        assert.ok(absent && !sansBlancs(plat).includes(sansBlancs(absent)), `courriel de l’auteur imprimé : ${absent}\n${texte}`);
      }

      // Identité actuelle (choix par défaut, à confirmer) : le rapport suit l'identité au moment où il s'imprime.
      try {
        await definirSociete(SOCIETE_B);
        const relu = await lirePdf(chantier.id);
        for (const attendu of ['TEST Émetteur rapport B', 'SIRET 99999999900099', '9 avenue Changée', 'TEST Pied du rapport B']) assert.ok(relu.plat.includes(attendu), `${attendu}\n${relu.texte}`);
        for (const ancien of ['TEST Émetteur rapport A', '88888888800088', 'TEST Pied du rapport A']) assert.ok(!relu.plat.includes(ancien), `${ancien}\n${relu.texte}`);
      } finally {
        await definirSociete(SOCIETE_A);
      }
    });

    // Cadrage, « Dates » (N1) : début et fin sont des dates seules, stockées à minuit UTC, imprimées telles
    // quelles, comme à l'écran, par la règle de jourCivilDeDebut (chantiers/suivi.ts), et non relues au fuseau
    // de la société ; la date de la demande, date seule, de même. « Tests » : société au fuseau des Marquises
    // (UTC−9:30) ; l'horodatage JJ-MM-AAAA HH:MM de chaque compte rendu est imprimé au fuseau, ainsi que le jour
    // d'acceptation de la signature (comme 6a-4a). L'horodatage d'un compte rendu et d'une signature est imposé
    // par la base : ce test le fixe en SQL de test, gardes suspendus le temps d'une transaction (comme 6a-4a).
    test('dates au fuseau des Marquises : début, fin et date de la demande telles qu’enregistrées ; horodatage des comptes rendus et jour de la signature au fuseau de la société', async () => {
      const s = suffixe();
      const FUSEAU = 'Pacific/Marquesas';
      const client = await creerClient(`TEST Client dates ${s}`);
      // 01-01-2026 relu aux Marquises tomberait le 31-12-2025 (changement d'année) ; 01-03-2026 le 28-02-2026.
      const chantier = await creerChantier({ nom: `TEST Chantier dates ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-01-01T00:00:00.000Z'), dateFin: new Date('2026-03-01T00:00:00.000Z') });
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande datée ${s}`, dateDemande: '12-01-2026' });
      await demarrer(intervention.id);
      const rapport = await ajouterCompteRendu(intervention.id, 'TEST Compte rendu horodaté.');
      const signature = await signer(rapport.id, 'TEST Signataire horodaté');
      // 16-01-2026 06:05 UTC = 15-01-2026 20:35 aux Marquises = 16-01-2026 07:05 à Paris.
      // 17-01-2026 05:20 UTC = 16-01-2026 19:50 aux Marquises = 17-01-2026 06:20 à Paris.
      await prisma.$transaction([
        prisma.$executeRawUnsafe('ALTER TABLE "InterventionRapport" DISABLE TRIGGER "intervention_rapport_ajout_seul"'),
        prisma.$executeRawUnsafe('ALTER TABLE "InterventionSignature" DISABLE TRIGGER "intervention_signature_figee"'),
        prisma.$executeRawUnsafe('UPDATE "InterventionRapport" SET "createdAt" = $1::timestamp WHERE "id" = $2', '2026-01-16 06:05:00', rapport.id),
        prisma.$executeRawUnsafe('UPDATE "InterventionSignature" SET "accepteLe" = $1::timestamp, "createdAt" = $1::timestamp WHERE "id" = $2', '2026-01-17 05:20:00', signature.id),
        prisma.$executeRawUnsafe('ALTER TABLE "InterventionSignature" ENABLE TRIGGER "intervention_signature_figee"'),
        prisma.$executeRawUnsafe('ALTER TABLE "InterventionRapport" ENABLE TRIGGER "intervention_rapport_ajout_seul"'),
      ]);
      assert.equal((await prisma.interventionRapport.findUniqueOrThrow({ where: { id: rapport.id } })).createdAt.toISOString(), '2026-01-16T06:05:00.000Z');
      // Chantier dont le début et la fin sont des instants (chantier converti avant #130) : la règle de
      // jourCivilDeDebut les lit au fuseau de la société. 01-01-2026 06:00 UTC = 31-12-2025 20:30 aux Marquises ;
      // 01-03-2026 05:00 UTC = 28-02-2026 19:30 aux Marquises.
      const instants = await creerChantier({ nom: `TEST Chantier instants ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-01-01T06:00:00.000Z'), dateFin: new Date('2026-03-01T05:00:00.000Z') });
      await definirSociete({ fuseauHoraire: FUSEAU });
      try {
        const { texte, plat } = await lirePdf(chantier.id);
        const chantierImprime = partieChantier(plat);
        assert.ok(chantierImprime.includes('Début : 01-01-2026'), `début tel qu’enregistré\n${texte}`);
        assert.ok(chantierImprime.includes('Fin : 01-03-2026'), `fin telle qu’enregistrée\n${texte}`);
        for (const decale of ['31-12-2025', '28-02-2026', '11-01-2026']) assert.ok(!plat.includes(decale), `date seule relue au fuseau de la société (${decale})\n${texte}`);
        assert.ok(plat.includes('Date de la demande : 12-01-2026'), `date de la demande telle qu’enregistrée\n${texte}`);
        // Horodatage du compte rendu et jour d'acceptation de la signature, au fuseau de la société.
        assert.ok(plat.includes('15-01-2026 20:35'), `horodatage du compte rendu au fuseau de la société\n${texte}`);
        assert.ok(!plat.includes('16-01-2026 06:05') && !plat.includes('16-01-2026 07:05'), `horodatage lu en UTC ou à Paris\n${texte}`);
        assert.ok(plat.includes('Signé par TEST Signataire horodaté le 16-01-2026.'), `jour d’acceptation au fuseau de la société\n${texte}`);
        assert.ok(!plat.includes('17-01-2026'), `jour d’acceptation lu en UTC ou à Paris\n${texte}`);

        const relu = await lirePdf(instants.id);
        const instantsImprimes = partieChantier(relu.plat);
        assert.ok(instantsImprimes.includes('Début : 31-12-2025') && instantsImprimes.includes('Fin : 28-02-2026'), `instants lus au fuseau de la société, comme à l’écran\n${relu.texte}`);
        assert.ok(!relu.plat.includes('01-01-2026') && !relu.plat.includes('01-03-2026'), `instants lus en UTC\n${relu.texte}`);
      } finally {
        await definirSociete({ fuseauHoraire: 'Europe/Paris' });
      }
    });

    // Réponse de Nelson du 31-10-2026 (« il ne doit pas y avoir de montant ni de heures ») et sa portée retenue
    // (cadrage, « Portée de « ni montant ni heures » », « Jamais imprimés », « Tests ») : aucune somme du
    // chantier, de ses interventions ni de leurs pièces (vendu, budgets, coût d'achat prévu, achats, factures et
    // avoirs, marges, coûts, valorisation des heures), aucune quantité ni durée d'heures (vendues, réalisées,
    // pointées, saisies sur les interventions), ni le matériel ; pas d'avancement (« le statut seul »). Chaque
    // valeur témoin est d'abord relue par l'application : le test ne passe pas à vide.
    test('ni montant ni heures : aucun budget, coût prévu, achat, pointage, facture, avoir, heure ni matériel du chantier ou de ses interventions, sous aucune écriture ; pas d’avancement', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client témoin ${s}`);
      const conducteur = await creerCompte('CONDUCTEUR_TRAVAUX', 'conducteur-temoin', s, { name: `TEST Barnabé Titulaire ${s}` });
      const commercial = await creerCompte('COMMERCIAL', 'commercial-temoin', s, { name: `TEST Céleste Vendeuse ${s}` });
      // Valeurs témoins du chantier : budgets (4 321,09 = 1 987,63 + 2 333,46), 37,25 h vendues (37 h 15, 2 235 min),
      // coût d'achat prévu 1 456,78.
      const chantier = await creerChantier({
        nom: `TEST Chantier témoin ${s}`, numeroDevis: 'A26-0077', client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-04-06T00:00:00.000Z'),
        budgetGlobalVendu: 4321.09, budgetMaterielVendu: 1987.63, budgetMainOeuvreVendu: 2333.46, heuresVendues: 37.25, coutMaterielPrevu: 1456.78,
        responsableId: conducteur.id, commercialId: commercial.id, types: ['Vidéo'],
      });
      // Ligne de budget prévisionnel : 2 718,28 alloués, 20,57 h allouées (20 h 34, 1 234 min).
      const categorie = await prisma.categorie.create({ data: { nom: `TEST Catégorie confidentielle ${s}` } });
      await prisma.ligneBudgetPrevisionnel.create({ data: { chantierId: chantier.id, categorieId: categorie.id, montantAlloue: 2718.28, heuresAllouees: 20.57 } });
      // Achat réel du chantier : 876,54 HT, sa description, son fournisseur et son numéro de facture.
      const fournisseurChantier = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur confidentiel chantier ${s}` } });
      await ok(appeler('post', '/achats', { chantierId: chantier.id, fournisseurId: fournisseurChantier.id, categorieId: categorie.id, date: '10-04-2026', description: 'TEST Câble confidentiel du chantier', montantHT: 876.54, numeroFacture: 'TEST-FF-CONFIDENTIELLE' }));
      // Pointage : 12,75 h (12 h 45, 765 min) au taux de 48,13 €, soit 613,66 € de main-d'œuvre.
      const pointeur = await prisma.intervenant.create({ data: { nom: `TEST Intervenant pointé ${s}`, role: 'Technicien', tauxHoraireCharge: 48.13 } });
      await ok(appeler('post', '/heures', { chantierId: chantier.id, intervenantId: pointeur.id, date: '11-04-2026', nbrHeures: 12.75, commentaire: 'TEST commentaire du pointage confidentiel' }));
      // Facture émise sur le chantier : 3 × 271,13 = 813,39 HT, 162,68 de TVA, 976,07 TTC ; avoir partiel de
      // 271,13 HT, 54,23 de TVA, 325,36 TTC ; facturé net 542,26, reste à facturer 3 778,83.
      const brouillon = await ok(appeler('post', '/factures', {
        clientId: client.id, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: aujourdhuiParis(), dateEcheance: aujourdhuiParis(),
        lignes: [{ designation: 'TEST Prestation confidentielle', quantite: 3, prixUnitaireHt: 271.13, tauxTva: 20 }],
      }), 201);
      const facture = await ok(appeler('post', `/factures/${brouillon.id}/emettre`));
      assert.deepEqual([facture.statut, facture.totalHt, facture.totalTva, facture.totalTtc], ['EMISE', 813.39, 162.68, 976.07]);
      const avoir = await reussi(appeler('post', `/factures/${facture.id}/avoirs`, { lignes: [{ designation: 'TEST Avoir confidentiel', quantite: 1, prixUnitaireHt: 271.13, tauxTva: 20 }] }));
      const avoirEnBase = await prisma.facture.findFirstOrThrow({ where: { factureOrigineId: facture.id, type: 'AVOIR' } });
      assert.deepEqual([Number(avoirEnBase.totalHt), Number(avoirEnBase.totalTva), Number(avoirEnBase.totalTtc)], [271.13, 54.23, 325.36], JSON.stringify(avoir));

      // Intervention du chantier : 6,75 h saisies par le technicien (6 h 45, 405 min ; 324,88 € au taux de
      // 48,13 €), 219,47 € de matériel, puis compte rendu signé et clôture.
      const technicien = await compteTechnicien('temoin', s, 'Témoin');
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande témoin ${s}`, dateDemande: '13-04-2026' });
      await planifier(intervention.id, [technicien.intervenantId]);
      await demarrer(intervention.id);
      await ok(appeler('post', `/interventions/${intervention.id}/couts/heures`, { date: '13-04-2026', nbrHeures: 6.75, commentaire: 'TEST commentaire des heures confidentiel' }, entete(technicien.jeton)), 201);
      const fournisseurIntervention = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur confidentiel intervention ${s}` } });
      await ok(appeler('post', `/interventions/${intervention.id}/couts/achats`, { date: '13-04-2026', description: 'TEST Pièce confidentielle de l’intervention', montantHT: 219.47, fournisseurId: fournisseurIntervention.id }), 201);
      const rapport = await ajouterCompteRendu(intervention.id, 'TEST Compte rendu de la demande témoin.', technicien.jeton);
      await signer(rapport.id, 'TEST Signataire témoin');
      await changerStatut(intervention.id, 'TERMINEE');

      // Les valeurs témoins existent bien, telles que posées : l'application les relit.
      const fiche = await ok(appeler('get', `/chantiers/${chantier.id}`));
      assert.deepEqual([fiche.budgetGlobalVendu, fiche.budgetMaterielVendu, fiche.budgetMainOeuvreVendu, fiche.heuresVendues, fiche.coutMaterielPrevu], [4321.09, 1987.63, 2333.46, 37.25, 1456.78]);
      assert.deepEqual([fiche.achats.length, fiche.pointages.length, fiche.facturation?.totalFactureHt, fiche.facturation?.resteAFacturerHt], [1, 1, 542.26, 3778.83], JSON.stringify(fiche.facturation));
      const couts = await ok(appeler('get', `/interventions/${intervention.id}/couts`));
      assert.deepEqual([couts.heures.length, couts.achats.length], [1, 1]);

      const { texte, plat } = await lirePdf(chantier.id);
      // Le rapport est bien celui de ce chantier et de son intervention.
      assert.ok(plat.includes(chantier.nom) && plat.includes(rapport.contenu) && plat.includes(technicien.compte.name), texte);
      const temoins = [
        // Montants : budgets, coût d'achat prévu, ligne de budget, achat, main-d'œuvre pointée, facture, avoir,
        // facturé net et reste à facturer, taux horaire, heures et matériel de l'intervention.
        ...['4321.09', '1987.63', '2333.46', '1456.78', '2718.28', '876.54', '613.66', '813.39', '162.68', '976.07', '271.13', '54.23', '325.36', '542.26', '3778.83', '48.13', '324.88', '219.47']
          .map((valeur) => [nombreTemoin(valeur), `montant ${valeur}`]),
        // Parties entières des montants à quatre chiffres : un montant arrondi à l'euro reste un montant.
        ...['4321', '1987', '2333', '1456', '2718', '3778'].map((valeur) => [nombreTemoin(valeur, { avecDecimales: false }), `montant arrondi ${valeur}`]),
        // Heures vendues, allouées, pointées et saisies sur l'intervention, sous chacune de leurs écritures.
        ...['37.25', '20.57', '12.75', '6.75'].flatMap((heures) => dureeTemoin(heures).map((motif) => [motif, `durée ${heures} h`])),
      ];
      for (const [motif, libelle] of temoins) assert.doesNotMatch(plat, motif, `${libelle} imprimé\n${texte}`);
      // Ni le matériel (descriptions, fournisseurs, catégorie, pièce d'achat), ni les commentaires des heures.
      for (const absent of [
        'TEST Câble confidentiel', 'TEST Pièce confidentielle', fournisseurChantier.nom, fournisseurIntervention.nom, categorie.nom, 'TEST-FF-CONFIDENTIELLE',
        'TEST commentaire du pointage', 'TEST commentaire des heures', 'TEST Prestation confidentielle', 'TEST Avoir confidentiel', pointeur.nom,
      ]) assert.ok(!plat.includes(absent), `imprimé à tort : ${absent}\n${texte}`);
      assert.doesNotMatch(plat, /confidenti/iu, texte);
      // Ni le commercial, ni le conducteur ; ni les numéros des pièces de vente.
      for (const absent of [conducteur.name, commercial.name, facture.numero, avoirEnBase.numero]) assert.ok(!plat.includes(absent), `imprimé à tort : ${absent}\n${texte}`);
    });

    // Cadrage, « Chantier annulé » (N2) : en tête « CHANTIER ANNULÉ », sans le motif, comme un contrat annulé
    // (choix par défaut, à confirmer) ; « Statut : annulé » ; « Jamais imprimés » : ni le motif d'annulation, ni
    // le motif de clôture ; comptes rendus : « Non signé par le client » pour une intervention terminée sans
    // signature, « jamais le motif » (6a-4a, B1) ; rubrique « Interventions » : sauf les annulées.
    test('chantier annulé : « CHANTIER ANNULÉ » en tête et « Statut : annulé », sans le motif ; ni motif de clôture, ni précision, ni « à suivre » ; l’intervention annulée et son motif absents', async () => {
      const s = suffixe();
      const MOTIF_CHANTIER = 'TEST Motif secret de l’annulation du chantier';
      const PRECISION = 'TEST précision secrète du motif de clôture';
      const MOTIF_INTERVENTION = 'TEST motif secret de l’annulation de l’intervention';
      const client = await creerClient(`TEST Client annulé ${s}`);
      const { devis, chantier } = await chantierConverti(client.id, `TEST Chantier annulé ${s}`, { dateDebut: '04-01-2026' });
      // Trois interventions rattachées avant l'annulation : en cours, terminée sans signature, annulée.
      const enCours = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande en cours ${s}` });
      await demarrer(enCours.id);
      await ajouterCompteRendu(enCours.id, 'TEST Compte rendu de l’intervention en cours.');
      const terminee = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande close sans signature ${s}` });
      await demarrer(terminee.id);
      await ajouterCompteRendu(terminee.id, 'TEST Compte rendu de l’intervention close.');
      await changerStatut(terminee.id, 'TERMINEE', { motifSansSignature: 'AUTRE', precisionMotif: PRECISION, aSuivre: true });
      assert.ok(await prisma.journalSaisieChantier.findFirst({ where: { interventionId: terminee.id, motif: { contains: PRECISION } } }), 'le motif de clôture est bien au journal SAV');
      const annulee = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande annulée ${s}` });
      await demarrer(annulee.id);
      const rapportAnnule = await ajouterCompteRendu(annulee.id, 'TEST Compte rendu de l’intervention annulée.');
      await signer(rapportAnnule.id, 'TEST Signataire de l’annulée');
      await changerStatut(annulee.id, 'ANNULEE', { motif: MOTIF_INTERVENTION });
      await ok(appeler('post', `/devis/${devis.id}/annulation`, { motif: MOTIF_CHANTIER }));
      const enBase = await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } });
      assert.deepEqual([enBase.statut, enBase.motifAnnulation, Boolean(enBase.annuleLe)], ['ANNULE', MOTIF_CHANTIER, true]);
      assert.deepEqual((await prisma.intervention.findMany({ where: { chantierId: chantier.id }, orderBy: { createdAt: 'asc' }, select: { statut: true } })).map((i) => i.statut), ['EN_COURS', 'TERMINEE', 'ANNULEE']);

      const { texte, plat } = await lirePdf(chantier.id);
      const chantierImprime = partieChantier(plat);
      // La mention en tête, avant le client ; puis le statut en libellé français.
      const mention = plat.indexOf('CHANTIER ANNULÉ');
      assert.ok(mention >= 0 && mention < plat.indexOf(`Client : ${client.raisonSociale}`), `mention « CHANTIER ANNULÉ » absente ou après le client\n${texte}`);
      assert.match(chantierImprime, /Statut : annulé(?!\p{L})/u, texte);
      assert.match(chantierImprime, new RegExp(`Référence de l['’]affaire : ${echapper(devis.numero)}`, 'u'), texte);
      // Ni le motif d'annulation du chantier, ni celui de l'intervention annulée, ni le motif de clôture.
      for (const absent of [MOTIF_CHANTIER, 'Motif secret', `Annulation du devis ${devis.numero}`, MOTIF_INTERVENTION, 'motif secret', PRECISION, 'précision secrète', 'Clôture sans signature', 'Autre —']) {
        assert.ok(!plat.includes(absent), `imprimé à tort : ${absent}\n${texte}`);
      }
      assert.doesNotMatch(plat, /motif/iu, texte);
      assert.doesNotMatch(plat, /à suivre/iu, texte);
      // L'intervention annulée n'est pas listée, ni son compte rendu ni sa signature.
      for (const absent of [annulee.reference, `TEST Demande annulée ${s}`, rapportAnnule.contenu, 'TEST Signataire de l’annulée']) assert.ok(!plat.includes(absent), `intervention annulée imprimée : ${absent}\n${texte}`);
      assert.doesNotMatch(plat, /annulée/iu, `statut « annulée » imprimé\n${texte}`);
      // Les deux autres, dans l'ordre de leur demande (même jour), puis de leur création.
      const blocs = blocsInterventions(plat, [enCours.reference, terminee.reference]);
      assert.match(blocs[enCours.reference], /Statut : en cours(?!\p{L})/u, texte);
      assert.match(blocs[terminee.reference], /Statut : terminée(?!\p{L})/u, texte);
      assert.equal(occurrences(plat, 'Non signé par le client'), 1, `mention une fois, pour la seule intervention terminée sans signature\n${texte}`);
      assert.ok(blocs[terminee.reference].includes('Non signé par le client'), texte);
    });

    // Cadrage, « Rubrique « Interventions » » : celles rattachées au chantier (chantierId), sauf les annulées ;
    // ordre : date de la demande croissante, puis date de création, puis identifiant ; sans date de demande en
    // dernier. « Pour chaque intervention » : référence, demande, date de la demande, statut avec les mots de
    // STATUT_VISITE, comptes rendus, « Aucun compte rendu. » sans compte rendu ; « jamais la description, le site,
    // le contact ni les intervenants » (choix le plus restrictif, à confirmer). « Tests » : « ni les annulées, ni
    // celles d'un autre chantier ».
    test('interventions : celles du chantier seules, sauf les annulées, par date de la demande puis de création, sans date en dernier ; statut en français, « Aucun compte rendu. » ; ni description, ni site, ni contact, ni intervenants', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client interventions ${s}`);
      const site = await prisma.clientSite.create({ data: { clientId: client.id, nom: `TEST Site secret ${s}`, adresse: '5 rue du Site secret', codePostal: '14200', ville: 'Hérouville' } });
      const contact = await prisma.clientContact.create({ data: { clientId: client.id, prenom: 'Hortense', nom: 'Secrète', telephone: '06 98 76 54 32', email: 'hortense.secrete@client.test' } });
      const technicien = await compteTechnicien('beta', s, 'Bêta');
      const chantier = await creerChantier({ nom: `TEST Chantier interventions ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-03-02T00:00:00.000Z') });
      const autreChantier = await creerChantier({ nom: `TEST Autre chantier ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-03-02T00:00:00.000Z') });
      const nouvelle = (titre, extra = {}) => creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `${titre} ${s}`, ...extra });
      // Sans date de demande : une intervention antérieure à la date de demande (migration 20261007130000), que
      // l'application ne crée plus et que la base fige une fois datée ; posée directement en base.
      const sansDate = (titre, cle, statut) => prisma.intervention.create({ data: { reference: `TEST-SD-${cle}-${s}`, clientId: client.id, chantierId: chantier.id, titre: `${titre} ${s}`, statut, dateDemande: null } });

      // Créées dans cet ordre : X1 (10-03), X2 (05-03), X3 (sans date), X4 (05-03), X5 (annulée), X6 (sans date).
      const x1 = await nouvelle('TEST X1 à planifier', { dateDemande: '10-03-2026' });
      const x2 = await nouvelle('TEST X2 planifiée', { dateDemande: '05-03-2026' });
      await changerStatut(x2.id, 'PLANIFIEE');
      const x3 = await sansDate('TEST X3 en cours sans date', 'X3', 'EN_COURS');
      const rapportX3 = await ajouterCompteRendu(x3.id, 'TEST Compte rendu de X3.');
      const x4 = await nouvelle('TEST X4 terminée', { dateDemande: '05-03-2026', description: 'TEST Description secrète de X4', siteId: site.id, contactId: contact.id });
      await planifier(x4.id, [technicien.intervenantId]);
      await demarrer(x4.id);
      const rapportX4 = await ajouterCompteRendu(x4.id, 'TEST Compte rendu de X4.', technicien.jeton);
      await signer(rapportX4.id, 'TEST Signataire de X4');
      await changerStatut(x4.id, 'TERMINEE');
      const x5 = await nouvelle('TEST X5 annulée', { dateDemande: '01-03-2026' });
      await demarrer(x5.id);
      await ajouterCompteRendu(x5.id, 'TEST Compte rendu de X5 annulée.');
      await changerStatut(x5.id, 'ANNULEE', { motif: 'TEST motif d’annulation de X5' });
      const x6 = await sansDate('TEST X6 à planifier sans date', 'X6', 'A_PLANIFIER');
      // Écartées : une intervention d'un autre chantier du même client, une intervention sans chantier.
      const autre = await creerIntervention({ clientId: client.id, chantierId: autreChantier.id, titre: `TEST Demande d’un autre chantier ${s}`, dateDemande: '01-03-2026' });
      await demarrer(autre.id);
      await ajouterCompteRendu(autre.id, 'TEST Compte rendu d’un autre chantier.');
      const horsChantier = await creerIntervention({ clientId: client.id, titre: `TEST Demande sans chantier ${s}`, dateDemande: '01-03-2026' });
      await demarrer(horsChantier.id);
      await ajouterCompteRendu(horsChantier.id, 'TEST Compte rendu sans chantier.');

      const { texte, plat } = await lirePdf(chantier.id);
      // X2 et X4 (05-03, X2 créée avant), X1 (10-03), puis X3 et X6 sans date, dans l'ordre de création.
      const blocs = blocsInterventions(plat, [x2.reference, x4.reference, x1.reference, x3.reference, x6.reference]);
      const attendus = [
        [x2, 'planifiée', '05-03-2026', true], [x4, 'terminée', '05-03-2026', false], [x1, 'à planifier', '10-03-2026', true],
        [x3, 'en cours', null, false], [x6, 'à planifier', null, true],
      ];
      for (const [intervention, statut, dateDemande, sansCompteRendu] of attendus) {
        const bloc = blocs[intervention.reference];
        assert.ok(bloc.includes(`Demande : ${intervention.titre}`), `${intervention.titre}\n${texte}`);
        assert.match(bloc, new RegExp(`Statut : ${statut}(?!\\p{L})`, 'u'), `${intervention.titre} : statut ${statut}\n${texte}`);
        if (dateDemande) assert.ok(bloc.includes(`Date de la demande : ${dateDemande}`), `${intervention.titre} : date de la demande\n${texte}`);
        else assert.ok(!bloc.includes('Date de la demande'), `${intervention.titre} : sans date de la demande\n${texte}`);
        assert.equal(bloc.includes('Aucun compte rendu.'), sansCompteRendu, `${intervention.titre} : « Aucun compte rendu. »\n${texte}`);
      }
      assert.ok(blocs[x3.reference].includes(rapportX3.contenu) && blocs[x4.reference].includes(rapportX4.contenu), texte);
      assert.ok(blocs[x4.reference].includes('Signé par TEST Signataire de X4'), texte);
      // Codes techniques jamais imprimés à la place des libellés.
      assert.doesNotMatch(plat, /(?<![\p{L}_])(A_PLANIFIER|PLANIFIEE|EN_COURS|TERMINEE|ANNULEE|TERMINE|ANNULE)(?![\p{L}_])/u, texte);
      // Écartées : l'annulée, celle d'un autre chantier, celle sans chantier, et leurs comptes rendus.
      for (const absent of [x5.reference, x5.titre, 'TEST Compte rendu de X5', autre.reference, autre.titre, 'TEST Compte rendu d’un autre chantier.', horsChantier.reference, horsChantier.titre, 'TEST Compte rendu sans chantier.', autreChantier.nom]) {
        assert.ok(!plat.includes(absent), `imprimé à tort : ${absent}\n${texte}`);
      }
      // Ni la description, ni le site, ni le contact, ni les intervenants.
      for (const absent of ['TEST Description secrète', site.nom, '5 rue du Site secret', 'Hérouville', 'Hortense', 'Secrète', '06 98 76 54 32', 'hortense.secrete@client.test', technicien.nomIntervenant, 'Intervenants']) {
        assert.ok(!plat.includes(absent), `imprimé à tort : ${absent}\n${texte}`);
      }
      // L'auteur du compte rendu reste imprimé (comme sur le PDF du compte rendu) : c'est le compte, non l'intervenant.
      assert.ok(blocs[x4.reference].includes(technicien.compte.name), texte);
    });

    // Cadrage, « Contenu imprimé » : référence « absent sans référence », adresse « absent sans adresse », nature
    // « absent sans type », fin « absent sans date de fin » ; client « à défaut le libellé du chantier » ; « Un
    // chantier sans intervention imprime « Aucune intervention rattachée. », sans refus » ; « Statut : terminé ».
    test('cas limites : chantier sans fiche client, référence, adresse, type, fin ni intervention ; chantier terminé ; intervention sans compte rendu', async () => {
      const s = suffixe();
      const nu = await creerChantier({ nom: `TEST Chantier nu ${s}`, client: `TEST Client du seul libellé ${s}`, dateDebut: new Date('2026-05-04T00:00:00.000Z') });
      const lu = await lirePdf(nu.id);
      const nuImprime = partieChantier(lu.plat);
      assert.ok(nuImprime.includes(`Client : TEST Client du seul libellé ${s}`), `libellé du chantier à défaut de fiche\n${lu.texte}`);
      assert.ok(nuImprime.includes('Début : 04-05-2026'), lu.texte);
      assert.match(nuImprime, /Statut : en cours(?!\p{L})/u, lu.texte);
      for (const absent of ['Référence de l', 'Adresse du chantier', 'Nature des travaux', 'Fin :']) assert.ok(!lu.plat.includes(absent), `${absent} imprimé sans valeur\n${lu.texte}`);
      assert.equal(occurrences(lu.plat, 'Aucune intervention rattachée.'), 1, lu.texte);
      assert.doesNotMatch(lu.plat, /Intervention [A-Z]/u, lu.texte);

      // Chantier terminé par sa clôture : la date de fin est posée au jour de la société.
      const client = await creerClient(`TEST Client terminé ${s}`);
      const termine = await creerChantier({ nom: `TEST Chantier terminé ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-05-04T00:00:00.000Z') });
      const sansCompteRendu = await creerIntervention({ clientId: client.id, chantierId: termine.id, titre: `TEST Demande sans compte rendu ${s}`, dateDemande: '05-05-2026' });
      await ok(appeler('patch', `/chantiers/${termine.id}/statut`, { statut: 'TERMINE' }));
      const finEnBase = (await prisma.chantier.findUniqueOrThrow({ where: { id: termine.id } })).dateFin.toISOString().slice(0, 10).split('-').reverse().join('-');
      const relu = await lirePdf(termine.id);
      const termineImprime = partieChantier(relu.plat);
      assert.match(termineImprime, /Statut : terminé(?!\p{L})/u, relu.texte);
      assert.ok(termineImprime.includes(`Fin : ${finEnBase}`), `fin posée à la clôture\n${relu.texte}`);
      const { [sansCompteRendu.reference]: bloc } = blocsInterventions(relu.plat, [sansCompteRendu.reference]);
      assert.ok(bloc.includes('Aucun compte rendu.') && bloc.includes('Statut : à planifier'), relu.texte);
      assert.ok(!relu.plat.includes('Aucune intervention rattachée.') && !relu.plat.includes('Non signé par le client'), relu.texte);
    });

    // Cadrage, « Pour chaque intervention » : ses comptes rendus « rendus exactement comme dans le PDF du compte
    // rendu (6a-4a) : horodatage au fuseau de la société, auteur, texte, signature avec tracé vectoriel et
    // empreinte, et « Non signé par le client » pour une intervention terminée sans signature, jamais le motif » ;
    // « Rendu partagé » (N7). « Tests » : « comptes rendus : rendus comme dans 6a-4a (signature, tracé, « Non
    // signé ») ». Les lignes de chaque compte rendu sont comparées à celles du PDF du compte rendu.
    test('comptes rendus rendus comme sur le PDF du compte rendu : mêmes lignes, tracé vectoriel au ratio, empreinte ; « Non signé par le client » une fois par intervention terminée sans signature', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client signatures ${s}`);
      const chantier = await creerChantier({ nom: `TEST Chantier signatures ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-06-01T00:00:00.000Z') });
      const nouvelle = async (titre, contenus) => {
        const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `${titre} ${s}`, dateDemande: '02-06-2026' });
        await demarrer(intervention.id);
        const rapports = [];
        for (const contenu of contenus) rapports.push(await ajouterCompteRendu(intervention.id, contenu));
        return { intervention, rapports };
      };
      // I1 : deux comptes rendus, l'un signé à deux traits, l'autre non ; terminée.
      const i1 = await nouvelle('TEST I1 signée', ['TEST I1 compte rendu signé à deux traits.', 'TEST I1 compte rendu non signé.']);
      const signatureDeuxTraits = await signer(i1.rapports[0].id, 'TEST Signataire deux traits', TRACE_DEUX_TRAITS);
      await changerStatut(i1.intervention.id, 'TERMINEE');
      // I2 : terminée sans signature (motif « refus de signer »).
      const i2 = await nouvelle('TEST I2 non signée', ['TEST I2 compte rendu sans signature.']);
      await changerStatut(i2.intervention.id, 'TERMINEE', { motifSansSignature: 'REFUS_SIGNATURE' });
      // I3 : en cours, sans signature : pas de mention.
      const i3 = await nouvelle('TEST I3 en cours', ['TEST I3 compte rendu en cours.']);
      // I4 : terminée sans signature, puis signée après la clôture, à un trait : la mention disparaît.
      const i4 = await nouvelle('TEST I4 signée après clôture', ['TEST I4 compte rendu signé après la clôture.']);
      await changerStatut(i4.intervention.id, 'TERMINEE', { motifSansSignature: 'CLIENT_ABSENT' });
      const signatureUnTrait = await signer(i4.rapports[0].id, 'TEST Signataire un trait', TRACE_SIMPLE);

      const { octets, texte, plat } = await lirePdf(chantier.id);
      const blocs = blocsInterventions(plat, [i1.intervention.reference, i2.intervention.reference, i3.intervention.reference, i4.intervention.reference]);
      assert.equal(occurrences(plat, 'Non signé par le client'), 1, `mention une seule fois\n${texte}`);
      assert.ok(blocs[i2.intervention.reference].includes('Non signé par le client'), `mention dans le bloc de l’intervention terminée sans signature\n${texte}`);
      assert.ok(!plat.includes('Refus de signer') && !plat.includes('Client absent') && !plat.includes('Clôture sans signature'), `motif de clôture imprimé\n${texte}`);
      // Tracés reproduits en vectoriel, à leur ratio, sans image.
      const chemins = cheminsTraces(octets);
      assert.ok(traceReproduit(chemins, TRACE_DEUX_TRAITS), `tracé à deux traits non reproduit (ratio 2,5)\n${JSON.stringify(chemins)}`);
      assert.ok(traceReproduit(chemins, TRACE_SIMPLE), `tracé à un trait non reproduit (ratio 2)\n${JSON.stringify(chemins)}`);
      assert.ok(!octets.includes(Buffer.from('/Subtype /Image')), 'le tracé est imprimé en image');

      // Mêmes lignes que le PDF du compte rendu de chaque intervention : horodatage et auteur, texte, signataire
      // et jour, empreinte ; dans le bloc de l'intervention, dans le même ordre.
      for (const { intervention, rapports } of [i1, i2, i3, i4]) {
        const reponse = await request(app).get(`/api/interventions/${intervention.id}/document.pdf`).set(admin()).buffer(true).parse(binaire);
        assert.equal(reponse.status, 200, reponse.body.toString('utf8').slice(0, 300));
        const lecteur = new PDFParse({ data: reponse.body });
        let texteCompteRendu;
        try { texteCompteRendu = aplatir((await lecteur.getText()).text); } finally { await lecteur.destroy(); }
        const bloc = blocs[intervention.reference];
        let curseur = 0;
        for (const rapport of rapports) {
          const signature = await prisma.interventionSignature.findUnique({ where: { rapportId: rapport.id } });
          const lignes = [`${dateHeure(rapport.createdAt, 'Europe/Paris')} — ${secours.name}`, rapport.contenu];
          if (signature) lignes.push(`Signé par ${signature.signataire} le ${jour(signature.accepteLe, 'Europe/Paris')}.`);
          for (const ligne of lignes) {
            assert.ok(texteCompteRendu.includes(ligne), `ligne absente du PDF du compte rendu : ${ligne}\n${texteCompteRendu}`);
            const position = bloc.indexOf(ligne, curseur);
            assert.ok(position >= curseur, `ligne absente ou hors d’ordre dans le rapport : ${ligne}\n${texte}`);
            curseur = position + ligne.length;
          }
          if (signature) {
            const empreinte = `Empreinte de la signature (SHA-256) : ${signature.empreinte}`;
            assert.ok(sansBlancs(texteCompteRendu).includes(sansBlancs(empreinte)) && sansBlancs(bloc).includes(sansBlancs(empreinte)), `empreinte\n${texte}`);
          }
        }
        assert.equal(bloc.includes('Non signé par le client'), texteCompteRendu.includes('Non signé par le client'), `${intervention.titre} : mention comme sur le PDF du compte rendu\n${texte}`);
      }
      assert.ok([signatureDeuxTraits, signatureUnTrait].every((signature) => sansBlancs(plat).includes(signature.empreinte)));
      assert.ok(blocs[i3.intervention.reference].includes('TEST I3 compte rendu en cours.'));
    });

    // Cadrage, « Lecteurs » : l'administration seule (requireAdmin), choix par défaut, le plus restrictif, à
    // confirmer ; « Route » : en session seulement, sans clé d'intégration ni route /api/v1. « Tests » : « 403
    // pour chaque type de compte non administrateur ; 401 sans session et pour une clé ; /api/v1 en 404 ». Le
    // garde requireAdmin passe avant toute lecture : un compte non administrateur reçoit 403 même pour un
    // chantier introuvable, et le titulaire ou le commercial du chantier, qui en lisent la fiche, aussi.
    test('droits : 403 pour chaque type de compte non administrateur, titulaire et commercial du chantier compris, sans rien écrire ; 401 sans session et par clé ; aucune route /api/v1 ; l’administration imprime', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client droits ${s}`);
      const titulaire = await creerCompte('CONDUCTEUR_TRAVAUX', 'titulaire', s);
      const commercialDuChantier = await creerCompte('COMMERCIAL', 'commercial-du-chantier', s);
      const responsable = await creerCompte('RESPONSABLE', 'responsable-du-titulaire', s);
      await prisma.user.update({ where: { id: titulaire.id }, data: { responsableHierarchiqueId: responsable.id } });
      const chantier = await creerChantier({ nom: `TEST Chantier droits ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-06-01T00:00:00.000Z'), responsableId: titulaire.id, commercialId: commercialDuChantier.id });
      const affecte = await compteTechnicien('affecte', s, 'Affecté');
      const intervention = await creerIntervention({ clientId: client.id, chantierId: chantier.id, titre: `TEST Demande des droits ${s}` });
      await planifier(intervention.id, [affecte.intervenantId]);
      await demarrer(intervention.id);
      await ajouterCompteRendu(intervention.id, 'TEST Compte rendu des droits.', affecte.jeton);
      // Le titulaire, le commercial et le directeur lisent la fiche du chantier : le refus n'est pas de périmètre.
      const directeurTousDroits = await creerCompte('DIRECTEUR', 'directeur-tous-droits', s, { permissions: TOUS_LES_SCOPES, accesFinance: true });
      for (const compte of [titulaire, commercialDuChantier, directeurTousDroits]) {
        assert.equal((await appeler('get', `/chantiers/${chantier.id}`, null, entete(jetonDe(compte)))).status, 200, `${compte.role} lit la fiche`);
      }

      const refuses = [
        ...await Promise.all(ROLES_NON_ADMINISTRATEURS.map(async (role) => [role, await creerCompte(role, role.toLowerCase(), s)])),
        ['CONDUCTEUR_TRAVAUX (titulaire du chantier)', titulaire],
        ['COMMERCIAL (commercial du chantier)', commercialDuChantier],
        ['RESPONSABLE (du titulaire)', responsable],
        ['DIRECTEUR (tous les droits, accès aux finances)', directeurTousDroits],
        ['TECHNICIEN (affecté à une intervention du chantier)', affecte.compte],
      ];
      for (const [libelle, compte] of refuses) {
        for (const id of [chantier.id, randomUUID()]) {
          const res = await refusSansEcriture(() => pdfRapport(id, entete(jetonDe(compte))), 403, `${libelle}, chantier ${id === chantier.id ? 'existant' : 'introuvable'}`);
          assert.equal(erreurDe(res), REFUS_ADMINISTRATION, libelle);
        }
      }

      // Ni visiteur, ni clé d'intégration, même avec tous les scopes ; aucune route /api/v1.
      await refusSansEcriture(() => pdfRapport(chantier.id, null), 401, 'sans session');
      const cle = await ok(appeler('post', '/admin/api-keys', { nom: `TEST clé rapport de chantier ${s}`, scopes: TOUS_LES_SCOPES }), 201);
      const parCle = entete(cle.apiKey);
      assert.equal((await request(app).get('/api/v1/chantiers').set(parCle)).status, 200, 'la clé est valide');
      await refusSansEcriture(() => pdfRapport(chantier.id, parCle), 401, 'clé sur la route en session');
      await refusSansEcriture(() => request(app).get(`/api/v1/chantiers/${chantier.id}/document.pdf`).set(parCle).buffer(true).parse(binaire), 404, 'route /api/v1 par clé');

      // L'administration imprime : le super administrateur (accès de secours), un administrateur, et un
      // administrateur marqué commercial.
      for (const [libelle, auth] of [
        ['SUPERADMIN', admin()],
        ['ADMIN', entete(jetonDe(await creerCompte('ADMIN', 'admin', s)))],
        ['ADMIN commercial', entete(jetonDe(await creerCompte('ADMIN', 'admin-commercial', s, { estCommercial: true })))],
      ]) {
        const avant = await etatBase();
        const { plat } = await lirePdf(chantier.id, auth);
        assert.ok(plat.includes(chantier.nom) && plat.includes('TEST Compte rendu des droits.'), libelle);
        assert.deepEqual(await etatBase(), avant, `${libelle} : lire n’écrit rien`);
      }
    });

    // Cadrage, « Refus », sans rien écrire : « 404 « Chantier introuvable » » ; « 409 si l'identité de la
    // société est incomplète (« … avant d’imprimer un rapport de chantier ») », pour tout chantier, annulé ou sans
    // intervention compris ; un chantier introuvable reste 404 (comme les autres PDF).
    test('refus : 404 « Chantier introuvable » ; identité incomplète en 409 qui nomme les champs manquants, pour tout chantier ; rien n’est écrit', async () => {
      const s = suffixe();
      const client = await creerClient(`TEST Client refus ${s}`);
      const enCours = await creerChantier({ nom: `TEST Chantier refus ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-06-01T00:00:00.000Z') });
      const intervention = await creerIntervention({ clientId: client.id, chantierId: enCours.id, titre: `TEST Demande refus ${s}` });
      const sansIntervention = await creerChantier({ nom: `TEST Chantier refus vide ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-06-01T00:00:00.000Z') });
      const annule = await creerChantier({ nom: `TEST Chantier refus annulé ${s}`, client: client.raisonSociale, clientId: client.id, dateDebut: new Date('2026-06-01T00:00:00.000Z'), statut: 'ANNULE', annuleLe: new Date(), motifAnnulation: 'TEST motif du refus' });

      for (const id of [randomUUID(), 'inexistant', intervention.id]) {
        const res = await refusSansEcriture(() => pdfRapport(id), 404, `identifiant ${id}`);
        assert.equal(erreurDe(res), CHANTIER_INTROUVABLE);
      }

      try {
        await definirSociete({ siret: '', ville: '' });
        for (const chantier of [enCours, sansIntervention, annule]) {
          const res = await refusSansEcriture(() => pdfRapport(chantier.id), 409, chantier.nom);
          assert.equal(erreurDe(res), identiteIncomplete('SIRET, ville'), chantier.nom);
        }
        assert.equal(erreurDe(await refusSansEcriture(() => pdfRapport(randomUUID()), 404, 'introuvable, identité incomplète')), CHANTIER_INTROUVABLE);
        await definirSociete({ siret: SOCIETE_A.siret, ville: SOCIETE_A.ville, raisonSociale: '' });
        assert.equal(erreurDe(await refusSansEcriture(() => pdfRapport(enCours.id), 409, 'raison sociale manquante')), identiteIncomplete('raison sociale'));
      } finally {
        await definirSociete(SOCIETE_A);
      }
      // L'identité complétée, chaque chantier s'imprime.
      for (const chantier of [enCours, sansIntervention, annule]) assert.ok((await lirePdf(chantier.id)).plat.includes(chantier.nom));
    });

    // Cadrage, « Noms de fichiers » (N6) : `Rapport-chantier-<nom>.pdf`, le nom réduit comme l'intitulé d'un
    // contrat (lettres sans accent, chiffres, tiret et tiret bas ; toute autre suite devient un tiret ; ni tiret
    // en tête ni en fin) ; `Rapport-chantier-<identifiant>.pdf` si rien n'en reste. Le nom ne rompt jamais
    // l'en-tête (guillemet, barre, fin de ligne).
    test('nom du fichier : Rapport-chantier-<nom réduit>.pdf, l’identifiant si rien n’en reste ; jamais de guillemet, de barre ni de fin de ligne', async () => {
      const s = suffixe();
      const nouveau = (nom) => creerChantier({ nom, client: `TEST Client fichier ${s}`, dateDebut: new Date('2026-06-01T00:00:00.000Z') });
      const accents = await nouveau(`  TEST Rénovation « chaufferie » n°2 / bâtiment_B — ${s}…  `);
      assert.match((await lirePdf(accents.id)).disposition, new RegExp(`^(inline|attachment); filename="Rapport-chantier-TEST-Renovation-chaufferie-n-2-batiment_B-${s}\\.pdf"$`));
      const vide = await nouveau('« — »');
      assert.match((await lirePdf(vide.id)).disposition, new RegExp(`^(inline|attachment); filename="Rapport-chantier-${vide.id}\\.pdf"$`));
      const piege = await nouveau(`TEST "guillemets" / barre \\ retour fin\r\nligne ${s}`);
      const { disposition } = await lirePdf(piege.id);
      assert.match(disposition, new RegExp(`^(inline|attachment); filename="Rapport-chantier-TEST-guillemets-barre-retour-fin-ligne-${s}\\.pdf"$`), disposition);
    });
  });
}
