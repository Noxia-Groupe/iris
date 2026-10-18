// Données du relevé, créées par l'API en super administrateur, avant les deux relevés.
//
// Les deux clients voient ensuite exactement ces données (mêmes identifiants, mêmes dates) :
// aucune normalisation n'est nécessaire. Elles rendent les sections que le découpage déplace :
// journaux d'achats et d'heures avec correction et archivage, journal d'audit, facture liée,
// barème réduit, chantiers terminés (encaissé ou non), planning de la semaine (chantier,
// hors suivi, événement à deux techniciens, affectation issue d'une intervention), file à
// planifier (visite de contrat et curative), partage publié, barèmes, devis signé à ouvrir,
// comptes de chaque sorte (administrateur, responsable hiérarchique, compte désactivé).
// Les noms portent un suffixe propre à l'exécution, pour qu'une base déjà servie reste
// utilisable ; une base neuve donne des relevés plus courts.
import { JETON_SECOURS, jetonPour } from './commun.mjs';

const FUSEAU = 'Europe/Paris';

// Jour civil de la société, décalé de `jours`, au format JJ-MM-AAAA ou AAAA-MM-JJ.
function jourCivil(jours, format = 'fr') {
  const parties = new Intl.DateTimeFormat('en-GB', { timeZone: FUSEAU, day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(new Date(Date.now() + jours * 86_400_000));
  const valeur = (type) => parties.find((partie) => partie.type === type).value;
  return format === 'fr' ? `${valeur('day')}-${valeur('month')}-${valeur('year')}` : `${valeur('year')}-${valeur('month')}-${valeur('day')}`;
}

// Décalage, en jours, du lundi de la semaine en cours (fuseau de la société).
function decalageLundi() {
  const jour = new Intl.DateTimeFormat('en-GB', { timeZone: FUSEAU, weekday: 'short' }).format(new Date());
  return -['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(jour);
}

export async function preparerDonnees(api) {
  // Le serveur répond avant d'avoir créé le compte de secours (SUPERADMIN_EMAILS) : on réessaie.
  let secours;
  for (let essai = 0; essai < 60; essai += 1) {
    secours = await fetch(`${api}/auth/secours`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: JETON_SECOURS }) });
    if (secours.ok || secours.status !== 403) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!secours.ok) throw new Error(`accès de secours refusé : ${secours.status} ${await secours.text()}`);
  const superAdmin = (await secours.json()).user;
  // Le jeton de secours expire au bout d'une heure ; un jeton signé pour le même compte non.
  const jeton = jetonPour(superAdmin.id);

  const appel = async (methode, chemin, corps) => {
    const reponse = await fetch(`${api}${chemin}`, {
      method: methode,
      headers: { Authorization: `Bearer ${jeton}`, ...(corps === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
    const texte = await reponse.text();
    if (!reponse.ok) throw new Error(`${methode} ${chemin} : ${reponse.status} ${texte}`);
    return texte ? JSON.parse(texte) : null;
  };
  const suffixe = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const nom = (libelle) => `Relevé ${libelle} ${suffixe}`;

  // Comptes.
  const compte = (cle, libelle, role) => appel('POST', '/users', { email: `releve.${cle}.${suffixe}@iris.test`, name: nom(libelle), role });
  const conducteur = await compte('conducteur', 'Conducteur', 'CONDUCTEUR_TRAVAUX');
  const commercial = await compte('commercial', 'Commercial', 'COMMERCIAL');
  const technicien = await compte('technicien', 'Technicien', 'TECHNICIEN');
  // Administration sans super administration (onglets Société et Modules absents), responsable
  // hiérarchique du technicien (choix du responsable non vide), compte désactivé.
  const administrateur = await compte('administrateur', 'Administrateur', 'ADMIN');
  const responsable = await compte('responsable', 'Responsable', 'RESPONSABLE');
  await appel('PATCH', `/users/${technicien.id}/responsable-hierarchique`, { responsableHierarchiqueId: responsable.id });
  const ancien = await compte('ancien', 'Ancien compte', 'CONDUCTEUR_TRAVAUX');
  await appel('PATCH', `/users/${ancien.id}/actif`, { actif: false });

  // Client, référentiels, intervenants (le premier relié au compte technicien).
  const client = await appel('POST', '/clients', { raisonSociale: nom('Client') });
  await appel('POST', `/clients/${client.id}/sites`, { nom: 'Facturation', adresse: '2 rue du Relevé', codePostal: '14000', ville: 'Caen', estSiteFacturation: true });
  const fournisseurs = [await appel('POST', '/fournisseurs', { nom: nom('Fournisseur A'), contact: 'Contact A' }), await appel('POST', '/fournisseurs', { nom: nom('Fournisseur B') })];
  const categories = [await appel('POST', '/categories', { nom: nom('Catégorie A'), description: 'Matériel' }), await appel('POST', '/categories', { nom: nom('Catégorie B') })];
  const intervenants = [
    await appel('POST', '/intervenants', { nom: nom('Intervenant A'), role: 'TECHNICIEN', tauxHoraireCharge: 42.5 }),
    await appel('POST', '/intervenants', { nom: nom('Intervenant B'), role: 'TECHNICIEN', tauxHoraireCharge: 38 }),
  ];
  await appel('PUT', `/intervenants/${intervenants[0].id}/compte`, { userId: technicien.id });

  // Devis signés : deux convertis en chantiers (A au conducteur, B au technicien), un à ouvrir.
  const devisSigne = async (objet) => {
    const devis = await appel('POST', '/devis', { clientId: client.id, objet: nom(objet), lignes: [
      { designation: 'Caméra', nature: 'FOURNITURE', quantite: 2, prixUnitaireHt: 412.5, tauxTva: 20 },
      { designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 6, prixUnitaireHt: 55, tauxTva: 20 },
    ] });
    await appel('PUT', `/devis/${devis.id}/statut`, { statut: 'ENVOYE' });
    await appel('POST', `/devis/${devis.id}/signature`, { signataire: 'Client du relevé', confirme: true });
    return devis;
  };
  const ouvrir = async (devis, responsableId) => appel('POST', `/devis/${devis.id}/convertir`, {
    cible: 'CHANTIER', responsableId, commercialId: commercial.id, types: ['Vidéo'], dateDebut: jourCivil(-20),
  });
  const chantierA = await ouvrir(await devisSigne('Affaire A'), conducteur.id);
  const chantierB = await ouvrir(await devisSigne('Affaire B'), conducteur.id);
  await appel('PATCH', `/chantiers/${chantierB.id}`, { responsableId: technicien.id });
  // Terminés : en attente d'encaissement (badge, bannière) et encaissé.
  const chantierC = await ouvrir(await devisSigne('Affaire terminée'), conducteur.id);
  await appel('PATCH', `/chantiers/${chantierC.id}/statut`, { statut: 'TERMINE' });
  const chantierD = await ouvrir(await devisSigne('Affaire encaissée'), conducteur.id);
  await appel('PATCH', `/chantiers/${chantierD.id}/statut`, { statut: 'TERMINE' });
  await appel('PATCH', `/chantiers/${chantierD.id}/encaisse`, { encaisse: true });
  await appel('PATCH', `/chantiers/${chantierA.id}`, { baremeReduit: true });
  await devisSigne('Affaire à ouvrir');

  // Saisies du chantier A : dates et montants distincts (les tris sont par date et par valeur).
  const achat = (jours, montantHT, i, description) => appel('POST', '/achats', {
    chantierId: chantierA.id, fournisseurId: fournisseurs[i].id, categorieId: categories[i].id, date: jourCivil(jours), description, montantHT, numeroFacture: `F-${-jours}`,
  });
  const achats = [await achat(-12, 120.4, 0, 'Câbles'), await achat(-9, 310, 1, 'Enregistreur'), await achat(-6, 45.25, 0, 'Fixations')];
  await appel('PATCH', `/achats/${achats[0].id}`, { montantHT: 125.4, motifCorrection: 'Facture rectifiée' });
  await appel('DELETE', `/achats/${achats[2].id}`, { motifArchivage: 'Doublon' });
  const heure = (chantierId, jours, intervenantId, nbrHeures) => appel('POST', '/heures', { chantierId, intervenantId, date: jourCivil(jours), nbrHeures, commentaire: `Pose J${jours}` });
  const heures = [await heure(chantierA.id, -11, intervenants[0].id, 7.5), await heure(chantierA.id, -8, intervenants[1].id, 4)];
  await heure(chantierB.id, -7, intervenants[0].id, 3.5);
  await appel('PATCH', `/heures/${heures[1].id}`, { nbrHeures: 4.5, motifCorrection: 'Oubli de la demi-heure' });

  // Facture émise liée au chantier A (prérequis comptables d'une base neuve).
  await preparerFacturation(appel);
  const facture = await appel('POST', '/factures', { clientId: client.id, origine: 'CHANTIER', chantierId: chantierA.id, dateEmission: jourCivil(0), dateEcheance: jourCivil(30), lignes: [{ designation: 'Acompte du relevé', quantite: 1, prixUnitaireHt: 300, tauxTva: 20 }] });
  await appel('POST', `/factures/${facture.id}/emettre`);

  // Planning de la semaine en cours, file à planifier et partage publié.
  const lundi = decalageLundi();
  const type = await appel('POST', '/planning/types', { nom: nom('Formation'), couleur: '#7c3aed' });
  await appel('POST', '/planning/events', { categorie: 'CHANTIER', chantierId: chantierA.id, dateDebut: jourCivil(lundi, 'iso'), dateFin: jourCivil(lundi + 1, 'iso'), intervenantIds: [intervenants[0].id] });
  await appel('POST', '/planning/events', { categorie: 'HORS_CHANTIER', titre: nom('Dépannage'), client: 'Client de passage', creneau: 'MATIN', dateDebut: jourCivil(lundi + 2, 'iso'), intervenantIds: [intervenants[1].id] });
  await appel('POST', '/planning/events', { categorie: 'EVENEMENT', typeEventId: type.id, creneau: 'HEURES', heureDebut: '08:00', heureFin: '12:00', dateDebut: jourCivil(lundi + 3, 'iso'), intervenantIds: [intervenants[0].id, intervenants[1].id] });
  const contrat = await appel('POST', '/contrats-maintenance', { clientId: client.id, titre: nom('Visite annuelle'), periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
  await appel('POST', `/contrats-maintenance/${contrat.id}/generer-intervention`);
  await appel('POST', '/interventions', { clientId: client.id, titre: nom('Panne caméra'), dateSouhaitee: '15-12-2099' });
  // Affectation issue d'une intervention : nature masquée, titre en lecture seule.
  const planifiee = await appel('POST', '/interventions', { clientId: client.id, titre: nom('Remplacement détecteur'), dateSouhaitee: '20-12-2099' });
  await appel('PUT', `/interventions/${planifiee.id}/planning`, { dateDebut: jourCivil(lundi + 4, 'iso'), creneau: 'HEURES', heureDebut: '09:00', heureFin: '10:30', intervenantIds: [intervenants[1].id] });
  await appel('POST', '/planning/share');

  // Barèmes non vides pour l'onglet Marges et commissions.
  await appel('PUT', '/parametres/remuneration', {
    baremeStandard: [{ plafond: 1000, taux: 5 }, { plafond: null, taux: 8 }], baremeReduit: [{ plafond: null, taux: 3 }],
    libelleBaremeReduit: 'Barème réduit du relevé', objectifCaMensuel: 20000, primeObjectifCa: 150, objectifMargeMensuel: 5000, primeObjectifMarge: 100, primeSuiviAdministratif: 50,
  });

  return {
    comptes: { superAdmin: superAdmin.id, administrateur: administrateur.id, conducteur: conducteur.id, technicien: technicien.id },
    noms: { technicien: technicien.name, fournisseurA: fournisseurs[0].nom },
    chantiers: { A: chantierA.id, B: chantierB.id, C: chantierC.id, D: chantierD.id },
    planning: { depannage: nom('Dépannage'), formation: type.nom, planifiee: planifiee.titre ?? nom('Remplacement détecteur') },
  };
}

// Plan comptable, règles, TVA et mentions publiées : sans eux, une facture ne s'émet pas.
async function preparerFacturation(appel) {
  const plan = async () => appel('GET', '/comptabilite');
  const compte = async (code, libelle, nature) => {
    const existant = (await plan()).comptes.find((item) => item.code === code);
    return existant || appel('POST', '/comptabilite/comptes', { code, libelle, nature });
  };
  const comptes = {
    CLIENT: await compte('411000', 'Clients', 'ACTIF'),
    VENTE_PRESTATION: await compte('706000', 'Prestations', 'PRODUIT'),
    VENTE_ARTICLE: await compte('707000', 'Articles', 'PRODUIT'),
  };
  const tva = await compte('445710', 'TVA collectée', 'TVA');
  for (const [cle, donnees] of [...Object.entries(comptes).map(([cle, c]) => [cle, { compteId: c.id }]), ['JOURNAL_VENTES', { journal: 'VE' }]]) {
    const actuelle = (await plan()).regles.find((regle) => regle.cle === cle);
    if (actuelle && (cle === 'JOURNAL_VENTES' ? actuelle.journal === 'VE' : actuelle.compteId === donnees.compteId)) continue;
    const version = actuelle ? { expectedValeur: cle === 'JOURNAL_VENTES' ? actuelle.journal : actuelle.compteId, expectedUpdatedAt: actuelle.updatedAt } : {};
    await appel('PUT', `/comptabilite/regles/${cle}`, { ...donnees, ...version, motif: 'Préparation du relevé' });
  }
  for (const taux of [20, 10]) {
    const existante = (await plan()).reglesTva.find((regle) => regle.taux === taux);
    if (existante?.compteId === tva.id) continue;
    await appel('PUT', `/comptabilite/tva/${taux}`, { compteId: tva.id, motif: 'Préparation du relevé', ...(existante ? { expectedCompteId: existante.compteId, expectedUpdatedAt: existante.updatedAt } : {}) });
  }
  const versions = await appel('GET', '/mentions-legales');
  if (!versions.some((version) => version.actif && version.publieeLe)) {
    const { version } = await appel('POST', '/mentions-legales', { mentions: 'IRIS relevé — 1 rue des Tests, 14000 Caen', cgv: 'CGV du relevé', penalites: 'Pénalités du relevé' });
    await appel('POST', `/mentions-legales/${version}/publier`);
  }
}
