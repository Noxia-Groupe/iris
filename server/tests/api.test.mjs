// Tests d'intégration : l'application Express est montée en mémoire et interrogée par
// de vraies requêtes HTTP, contre une vraie base PostgreSQL. Ce sont ces tests qui
// prouvent que les règles d'accès s'appliquent — pas la lecture du code source.
//
// Ils ont besoin d'une base JETABLE, indiquée par TEST_DATABASE_URL (cf. tests/README.md).
// Sans elle, la suite s'annonce ignorée : mieux vaut un « skip » visible qu'un vert obtenu
// sans avoir rien vérifié.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test, { after, before, describe, mock } from 'node:test';
import { PDFParse } from 'pdf-parse';

// Fige l'horloge du processus (Date seulement : ni les minuteries ni la base) au dernier 21 h UTC
// passé : Wallis y est déjà au lendemain, si bien que le jour de la société diffère toujours de
// celui d'UTC. Sans cela, entre 10 h et 12 h UTC, aucun fuseau admis (UTC−10 à UTC+12) n'en
// diffère et un test du jour de la société ne distinguerait plus le bon calcul du jour UTC.
// L'horloge ne part jamais dans le futur : les sessions de test, valables une heure à compter de
// leur ouverture, y seraient expirées.
// Avec `dimanche`, l'horloge recule jusqu'au dernier dimanche 21 h UTC : Wallis est alors déjà au
// lundi, si bien que la semaine de la société diffère aussi de la semaine UTC.
function figerHorlogeA21hUtc({ dimanche = false } = {}) {
  const maintenant = new Date();
  const aujourdhui21h = Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate(), 21);
  let instant = aujourdhui21h <= maintenant.getTime() ? aujourdhui21h : aujourdhui21h - 86_400_000;
  while (dimanche && new Date(instant).getUTCDay() !== 0) instant -= 86_400_000;
  mock.timers.enable({ apis: ['Date'], now: instant });
}

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  describe('API HTTP', { skip: 'TEST_DATABASE_URL absent — voir tests/README.md' }, () => {
    test('non exécuté', () => {});
  });
} else {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'secret-de-test-uniquement';
  process.env.BREAK_GLASS_EMAIL = 'secours@iris.test';
  process.env.BREAK_GLASS_TOKEN = 'jeton-de-secours-de-test-au-moins-32-caracteres';
  process.env.SUPERADMIN_EMAILS = 'secours@iris.test';

  const request = (await import('supertest')).default;
  const { app, initDb, ensureSuperAdmins, jourCivilEntreprise, prisma: appPrisma } = await import('../dist/index.js');
  const { PrismaClient } = await import('@prisma/client');
  const jwt = (await import('jsonwebtoken')).default;
  const prisma = new PrismaClient();
  // Fixtures historiques : leurs transitions restent motivées, même hors HTTP.
  const auteurFixture = async tx => tx.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { id: true, name: true } });
  const regleFixture = async (cle, compteId, db = prisma) => {
    const ancienne = await db.regleComptable.findUnique({ where: { cle } });
    const journal = cle === 'JOURNAL_VENTES' ? compteId : null;
    const prochain = cle === 'JOURNAL_VENTES' ? journal : compteId;
    if (ancienne && (ancienne.journal ?? ancienne.compteId) === prochain) return ancienne;
    const mettre = async tx => {
      const avant = await tx.regleComptable.findUnique({ where: { cle } });
      const valeur = avant?.journal ?? avant?.compteId;
      const auteur = await auteurFixture(tx);
      if (!avant) {
        const creee = await tx.regleComptable.create({ data: { cle, compteId: journal ? null : compteId, journal } });
        await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'CREATION', apres: prochain, motif: 'Création de fixture comptable', auteurId: auteur.id, auteurNom: auteur.name } });
        return creee;
      }
      const apres = await tx.regleComptable.update({ where: { cle }, data: { compteId: journal ? null : compteId, journal } });
      await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'REMAPPAGE', avant: valeur, apres: prochain, motif: 'Correction de fixture comptable', auteurId: auteur.id, auteurNom: auteur.name } });
      return apres;
    };
    return db === prisma ? prisma.$transaction(mettre) : mettre(db);
  };
  const tvaFixture = async (taux, compteId, db = prisma) => {
    const ancienne = await db.regleTvaComptable.findUnique({ where: { taux } });
    if (ancienne?.compteId === compteId) return ancienne;
    const mettre = async tx => {
      const avant = await tx.regleTvaComptable.findUnique({ where: { taux } });
      const auteur = await auteurFixture(tx);
      if (!avant) {
        const creee = await tx.regleTvaComptable.create({ data: { taux, compteId } });
        await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'CREATION', apres: compteId, motif: 'Création de fixture TVA', auteurId: auteur.id, auteurNom: auteur.name } });
        return creee;
      }
      const apres = await tx.regleTvaComptable.update({ where: { taux }, data: { compteId } });
      await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'REMAPPAGE', avant: avant.compteId, apres: compteId, motif: 'Correction de fixture comptable', auteurId: auteur.id, auteurNom: auteur.name } });
      return apres;
    };
    return db === prisma ? prisma.$transaction(mettre) : mettre(db);
  };
  const versionRegle = async cle => {
    const regle = await prisma.regleComptable.findUnique({ where: { cle } });
    return regle ? { expectedValeur: regle.journal ?? regle.compteId, expectedUpdatedAt: regle.updatedAt.toISOString() } : {};
  };
  const versionTva = async taux => {
    const regle = (await prisma.regleTvaComptable.findMany()).find(r => Number(r.taux) === taux);
    return regle ? { expectedCompteId: regle.compteId, expectedUpdatedAt: regle.updatedAt.toISOString() } : {};
  };
  const retirerTvaFixture = async taux => prisma.$transaction(async tx => {
    const avant = await tx.regleTvaComptable.findUnique({ where: { taux } });
    if (!avant) return;
    await tx.regleTvaComptable.delete({ where: { taux } });
    const auteur = await auteurFixture(tx);
    await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'RETRAIT', avant: avant.compteId, motif: 'Retrait de fixture comptable', auteurId: auteur.id, auteurNom: auteur.name } });
  });
  const retirerRegleFixture = async cle => prisma.$transaction(async tx => {
    const avant = await tx.regleComptable.findUnique({ where: { cle } });
    if (!avant) return;
    await tx.regleComptable.delete({ where: { cle } });
    const auteur = await auteurFixture(tx);
    await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'RETRAIT', avant: avant.journal ?? avant.compteId, motif: 'Retrait de fixture comptable', auteurId: auteur.id, auteurNom: auteur.name } });
  });
  const configurerTva55 = async () => {
    const compte = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
    await tvaFixture(5.5, compte.id);
  };
  const purgerEcrituresJetables = async id => {
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_immutable"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_equilibre"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_equilibre_immediat"');
      await prisma.ecritureFacture.deleteMany({ where: { factureId: id } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_equilibre_immediat"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_equilibre"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_immutable"');
    }
  };

  let cleApi = '';

  const nettoyer = async () => {
    // La signature dépend du devis : elle part avant le devis pour garder ce teardown explicite.
    // Elle est figée en base (lot pilote 2) : le nettoyage de la base jetable suspend ce garde le
    // temps de purger les fixtures, puis le réactive.
    // Une seule transaction : un arrêt en cours de route ne peut pas laisser le garde désactivé.
    await prisma.$transaction([
      prisma.$executeRawUnsafe('ALTER TABLE "DevisSignature" DISABLE TRIGGER "devis_signature_figee"'),
      prisma.devisSignature.deleteMany({ where: { devis: { client: { raisonSociale: { startsWith: 'TEST ' } } } } }),
      prisma.$executeRawUnsafe('ALTER TABLE "DevisSignature" ENABLE TRIGGER "devis_signature_figee"'),
    ]);
    // Une conversion garde le lien vers le devis : elle part avant le devis et sa fiche client.
    await prisma.devisConversion.deleteMany({ where: { devis: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    // Les devis dépendent du client ; ils doivent être retirés avant la fiche client.
    await prisma.devis.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    // Le parc dépend à la fois du client/site et du catalogue : il part donc en premier.
    await prisma.equipementInstalle.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    // Les attestations dépendent des rapports ; elles partent avant les interventions.
    await prisma.interventionSignature.deleteMany({ where: { rapport: { intervention: { client: { raisonSociale: { startsWith: 'TEST ' } } } } } });
    // Les interventions SAV portent éventuellement un site/contact : elles partent avant
    // ces fiches afin de respecter les clés étrangères RESTRICT.
    // Les snapshots ont une FK RESTRICT et sont append-only : purge uniquement sur la base jetable.
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_immutable"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_equilibre"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_equilibre_immediat"');
      await prisma.ecritureFacture.deleteMany({ where: { facture: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_equilibre_immediat"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_equilibre"');
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_immutable"');
    }
    await prisma.factureLigne.deleteMany({ where: { facture: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    await prisma.journalFacture.deleteMany({ where: { facture: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
    // Les règlements sont immuables par trigger : seul ce nettoyage de base jetable les purge,
    // avant leurs factures et leurs clients de test.
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "AffectationReglement" DISABLE TRIGGER "affectation_reglement_immuable"');
      await prisma.$executeRawUnsafe('ALTER TABLE "Reglement" DISABLE TRIGGER "reglement_immuable"');
      await prisma.affectationReglement.deleteMany({ where: { reglement: { client: { raisonSociale: { startsWith: 'TEST ' } } } } });
      await prisma.reglement.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "Reglement" ENABLE TRIGGER "reglement_immuable"');
      await prisma.$executeRawUnsafe('ALTER TABLE "AffectationReglement" ENABLE TRIGGER "affectation_reglement_immuable"');
    }
    // Les avoirs référencent leur facture source par RESTRICT : les documents enfants partent
    // donc avant les factures de test. Ceci conserve le teardown rejouable avec plusieurs avoirs.
    await prisma.facture.deleteMany({ where: { type: 'AVOIR', client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.facture.deleteMany({ where: { type: 'FACTURE', client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.mentionsLegalesVersion.deleteMany({});
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalRegleComptable" DISABLE TRIGGER "journal_regle_append_only"');
      await prisma.journalRegleComptable.deleteMany({});
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalRegleComptable" ENABLE TRIGGER "journal_regle_append_only"');
    }
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "TransitionRegleComptable" DISABLE TRIGGER "transition_regle_guard"');
      await prisma.$executeRawUnsafe('DELETE FROM "TransitionRegleComptable"');
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "TransitionRegleComptable" ENABLE TRIGGER "transition_regle_guard"');
    }
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" DISABLE TRIGGER "regle_capturer_creation"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleTvaComptable" DISABLE TRIGGER "tva_capturer_creation"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" DISABLE TRIGGER "regle_journal_creation"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleTvaComptable" DISABLE TRIGGER "tva_journal_creation"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" DISABLE TRIGGER "regle_capturer_transition"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleTvaComptable" DISABLE TRIGGER "tva_capturer_transition"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" DISABLE TRIGGER "regle_journal_transition"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" DISABLE TRIGGER "regle_journal_transition_delete"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleTvaComptable" DISABLE TRIGGER "tva_journal_transition_delete"');
      await prisma.regleComptable.deleteMany({});
      await prisma.regleTvaComptable.deleteMany({});
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" ENABLE TRIGGER "regle_capturer_creation"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleTvaComptable" ENABLE TRIGGER "tva_capturer_creation"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" ENABLE TRIGGER "regle_journal_creation"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleTvaComptable" ENABLE TRIGGER "tva_journal_creation"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" ENABLE TRIGGER "regle_capturer_transition"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleTvaComptable" ENABLE TRIGGER "tva_capturer_transition"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" ENABLE TRIGGER "regle_journal_transition"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleComptable" ENABLE TRIGGER "regle_journal_transition_delete"');
      await prisma.$executeRawUnsafe('ALTER TABLE "RegleTvaComptable" ENABLE TRIGGER "tva_journal_transition_delete"');
    }
    await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT IF EXISTS "journal_test_refus_insertion"');
    // Le journal est append-only : le nettoyage de la base jetable désactive le trigger
    // uniquement le temps de purger les fixtures, puis le réactive même en cas d'échec.
    try {
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DISABLE TRIGGER "journal_compte_append_only"');
      await prisma.journalCompteComptable.deleteMany({});
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" ENABLE TRIGGER "journal_compte_append_only"');
    }
    await prisma.compteComptable.deleteMany({});
    await prisma.sequenceFacture.deleteMany({});
    await prisma.sequenceAvoir.deleteMany({});
    const interventionIds = (await prisma.intervention.findMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } }, select: { id: true } })).map((intervention) => intervention.id);
    await prisma.journalSaisieChantier.deleteMany({ where: { interventionId: { in: interventionIds } } });
    await prisma.coutInterventionHeure.deleteMany({ where: { interventionId: { in: interventionIds } } });
    await prisma.coutInterventionAchat.deleteMany({ where: { interventionId: { in: interventionIds } } });
    await prisma.intervention.deleteMany({ where: { id: { in: interventionIds } } });
    const contratIds = (await prisma.contratMaintenance.findMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } }, select: { id: true } })).map((contrat) => contrat.id);
    await prisma.journalSaisieChantier.deleteMany({ where: { contratMaintenanceId: { in: contratIds } } });
    await prisma.contratMaintenance.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.clientSite.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.clientContact.deleteMany({ where: { client: { raisonSociale: { startsWith: 'TEST ' } } } });
    await prisma.cataloguePrestation.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.catalogueArticle.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.catalogueEquipement.deleteMany({ where: { reference: { startsWith: 'TEST-' } } });
    await prisma.apiAccessKey.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    // Domaine chantier : l'ordre suit les clés étrangères — les lignes rattachées d'abord.
    const chantierIds = (await prisma.chantier.findMany({ where: { nom: { startsWith: 'TEST ' } }, select: { id: true } })).map((chantier) => chantier.id);
    await prisma.journalSaisieChantier.deleteMany({ where: { chantierId: { in: chantierIds } } });
    await prisma.achatReel.deleteMany({ where: { chantier: { nom: { startsWith: 'TEST ' } } } });
    await prisma.pointageHeure.deleteMany({ where: { chantier: { nom: { startsWith: 'TEST ' } } } });
    await prisma.chantier.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    // Un chantier né d'une conversion porte la raison sociale du client dans `client` ; son
    // `nom` reprend l'objet du devis et n'a donc pas le préfixe TEST. Sans cette ligne,
    // chaque exécution en laisserait un derrière elle. Elle vient APRÈS les achats et les
    // heures, qui référencent le chantier.
    await prisma.chantier.deleteMany({ where: { client: { startsWith: 'TEST ' } } });
    await prisma.client.deleteMany({ where: { raisonSociale: { startsWith: 'TEST ' } } });
    await prisma.intervenant.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    await prisma.categorie.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    await prisma.fournisseur.deleteMany({ where: { nom: { startsWith: 'TEST ' } } });
    const emailsUtilisateursTest = [
      'cycle.conducteur@iris.test', 'regles95@iris.test', 'conducteur.test@iris.test', 'correcteur.test@iris.test', 'auteur.journal@iris.test', 'permissions@iris.test', 'commercial.permissions@iris.test', 'finances.archive.achat@iris.test', 'finances.archive.pointage@iris.test', 'finances.archive.conducteur.pointage@iris.test',
      'sav.non-affecte@iris.test', 'sav.premier@iris.test', 'sav.second@iris.test', 'sav.journal@iris.test', 'sav.rapport@iris.test', 'sav.intrus@iris.test', 'sav.conducteur@iris.test', 'sav.responsable@iris.test', 'sav.tiers@iris.test', 'sav.cout.heures@iris.test', 'sav.cout.second@iris.test', 'sav.cout.confidentiel@iris.test', 'sav.cout.garde.technicien@iris.test', 'sav.cout.garde.collegue@iris.test', 'sav.cout.garde.conducteur@iris.test', 'sav.cout.garde.commercial@iris.test', 'sav.cout.garde.taux@iris.test', 'sav.cout.garde.responsable@iris.test', 'contrat.conducteur@iris.test', 'contrat.couverture.technicien@iris.test', 'contrat.couverture.lecteur@iris.test', 'facture.conducteur@iris.test', 'comptabilite.conducteur@iris.test', 'comptabilite.modification.conducteur@iris.test', 'comptabilite.modification.admin@iris.test', 'comptabilite.import.autre.admin@iris.test', 'comptabilite.admin@iris.test', 'journal.comptable.sql@iris.test', 'journal.comptable.auteur@iris.test', 'journal.regle.auteur@iris.test', 'phase8bis.conducteur@iris.test', 'phase8bis.commercial@iris.test', 'rentabilite.conducteur@iris.test', 'suivi.conducteur@iris.test',
      'chaine.conducteur@iris.test', 'chaine.secteur@iris.test', 'chaine.regional@iris.test', 'chaine.autre.responsable@iris.test', 'chaine.autre.conducteur@iris.test', 'chaine.directeur@iris.test', 'chaine.admin@iris.test', 'chaine.inactif@iris.test', 'chaine.commercial@iris.test', 'chaine.technicien@iris.test',
      'budgets.technicien@iris.test', 'budgets.comptable@iris.test', 'budgets.conducteur@iris.test', 'budgets.responsable@iris.test', 'budgets.autre.responsable@iris.test', 'budgets.directeur@iris.test', 'budgets.commercial@iris.test', 'budgets.finance.technicien@iris.test', 'budgets.reconversion@iris.test',
      'annuaire.technicien@iris.test', 'annuaire.autre.technicien@iris.test', 'annuaire.conducteur@iris.test', 'annuaire.directeur@iris.test', 'annuaire.commercial@iris.test', 'annuaire.responsable@iris.test',
      'ouverture.conducteur@iris.test', 'ouverture.autre.conducteur@iris.test', 'ouverture.commercial@iris.test', 'ouverture.commercial.inactif@iris.test', 'ouverture.ancien.conducteur@iris.test',
      'taux.responsable@iris.test', 'taux.conducteur@iris.test', 'taux.directeur@iris.test', 'taux.commercial@iris.test',
      'fiche111.titulaire@iris.test', 'permissions.autre@iris.test', 'sans.plan.commercial@iris.test',
      'catalogue.devis.commercial@iris.test', 'catalogue.devis.technicien@iris.test', 'catalogue.devis.conducteur@iris.test',
      'pilote3.technicien@iris.test', 'pilote3.autre.technicien@iris.test', 'pilote3.inactif@iris.test', 'pilote3.conducteur@iris.test', 'pilote3.tiers@iris.test',
      'pilote3.reconverti@iris.test', 'pilote3.promu@iris.test', 'pilote3.admin@iris.test', 'pilote3.superadmin@iris.test', 'pilote3.concurrent.a@iris.test', 'pilote3.concurrent.b@iris.test', 'pilote3.demarrage@iris.test',
      'dernier.super.a@iris.test', 'dernier.super.b@iris.test', 'dernier.super.admin@iris.test', 'dernier.super.responsable@iris.test', 'dernier.super.collaborateur@iris.test',
      'garde.verrou.cible@iris.test', 'garde.verrou.responsable@iris.test', 'garde.verrou.ancien@iris.test',
      ...Array.from({ length: 20 }, (_, i) => `pilote3.course.${i}@iris.test`),
      ...Array.from({ length: 10 }, (_, i) => `pilote3.suppression.${i}@iris.test`),
      ...Array.from({ length: 15 }, (_, i) => `pilote3.supprtype.${i}@iris.test`),
    ];
    // Les journaux sont maintenant référentiellement reliés à leurs auteurs : ils partent
    // avant les comptes afin que le harnais reste rejouable après une interruption.
    await prisma.journalSaisieChantier.deleteMany({ where: { auteur: { email: { in: emailsUtilisateursTest } } } });
    await prisma.user.deleteMany({ where: { email: { in: emailsUtilisateursTest } } });
  };

  before(async () => {
    await initDb();
    await ensureSuperAdmins();
    // Le test du dernier super administrateur désactive le compte de secours le temps d'un test :
    // une exécution interrompue ne doit pas le laisser désactivé (le démarrage promeut sans réactiver).
    await prisma.user.update({ where: { email: 'secours@iris.test' }, data: { actif: true } });
    // Une exécution précédente interrompue a pu laisser des enregistrements : on part
    // toujours d'un état propre, sinon la suite n'est rejouable qu'une fois.
    await nettoyer();
    await prisma.mentionsLegalesVersion.create({ data: { version: 1, mentions: 'TEST Mentions légales', cgv: 'TEST Conditions générales', penalites: 'TEST Pénalités de retard', actif: true, publieeLe: new Date() } });
  });

  after(async () => {
    await nettoyer();
    await prisma.$disconnect();
  });

  describe('Accès de secours', () => {
    test('annonce sa disponibilité sans révéler le jeton', async () => {
      const res = await request(app).get('/api/auth/secours/etat');
      assert.equal(res.status, 200);
      assert.equal(res.body.disponible, true);
      assert.equal(JSON.stringify(res.body).includes('jeton-de-secours'), false);
    });

    test('refuse un jeton erroné', async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: 'mauvais-jeton' });
      assert.equal(res.status, 401);
      assert.equal(res.body.token, undefined);
    });

    test('refuse une requête sans jeton', async () => {
      const res = await request(app).post('/api/auth/secours').send({});
      assert.equal(res.status, 401);
    });

    test('ouvre une session d’une heure pour le bon jeton', async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.token, 'un jeton de session doit être émis');
      assert.equal(res.body.user.role, 'SUPERADMIN');
      assert.equal(res.body.expiresIn, 3600);
    });
  });

  describe('Protection des routes', () => {
    test('sans jeton, le référentiel client est fermé', async () => {
      assert.equal((await request(app).get('/api/clients')).status, 401);
      assert.equal((await request(app).get('/api/catalogue/articles')).status, 401);
      assert.equal((await request(app).get('/api/company')).status, 401);
    });

    test('un jeton fabriqué avec une autre clé est rejeté', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const faux = jwt.sign({ id: 'nimporte-quoi', role: 'SUPERADMIN' }, 'la-mauvaise-cle');
      const res = await request(app).get('/api/clients').set('Authorization', `Bearer ${faux}`);
      assert.equal(res.status, 401);
    });

    test('un jeton signé pour un compte inexistant est rejeté', async () => {
      // Le rôle est relu en base à chaque requête : un jeton bien signé mais orphelin
      // ne doit ouvrir aucune porte, même s'il se prétend SUPERADMIN.
      const jwt = (await import('jsonwebtoken')).default;
      const orphelin = jwt.sign({ id: 'compte-supprime', role: 'SUPERADMIN' }, process.env.JWT_SECRET);
      const res = await request(app).get('/api/clients').set('Authorization', `Bearer ${orphelin}`);
      assert.equal(res.status, 401);
    });

    test("l'API d'intégration refuse une clé inconnue", async () => {
      const res = await request(app).get('/api/v1/clients').set('Authorization', 'Bearer iris_cle_inventee');
      assert.equal(res.status, 401);
    });
  });

  describe('Référentiel client via une session humaine', () => {
    let session = '';
    let clientId = '';

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
    });

    test('#111 : recherche un client au-delà des 200 premiers sans exposer les inactifs', async () => {
      await prisma.client.createMany({ data: Array.from({ length: 201 }, (_, i) => ({ raisonSociale: `TEST 111 A ${String(i).padStart(3, '0')}` })) });
      const cible = await prisma.client.create({ data: { raisonSociale: 'TEST 111 Z cible' } });
      const inactif = await prisma.client.create({ data: { raisonSociale: 'TEST 111 Z inactif', actif: false } });
      const get = (query) => request(app).get(`/api/clients${query}`).set('Authorization', `Bearer ${session}`);
      const initial = await get('');
      assert.equal(initial.status, 200);
      assert.equal(initial.body.clients.length, 200);
      assert.equal(initial.body.clients.some(c => c.id === cible.id), false);
      const trouve = await get('?q=111%20Z');
      assert.equal(trouve.status, 200);
      assert.ok(trouve.body.clients.some(c => c.id === cible.id));
      assert.equal(trouve.body.clients.some(c => c.id === inactif.id), false);
      assert.equal((await get('?q=111%20Z&actif=false')).body.clients.some(c => c.id === inactif.id), true);
    });

    test('crée un client puis le relit', async () => {
      const creation = await request(app).post('/api/clients')
        .set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Boulangerie Martin', siren: '552 100 554' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.siren, '552100554', 'le SIREN doit être normalisé');
      clientId = creation.body.id;

      const lecture = await request(app).get(`/api/clients/${clientId}`).set('Authorization', `Bearer ${session}`);
      assert.equal(lecture.status, 200);
      assert.equal(lecture.body.raisonSociale, 'TEST Boulangerie Martin');
    });

    test('refuse une saisie invalide avec un message utile', async () => {
      const res = await request(app).post('/api/clients')
        .set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Siren faux', siren: '42' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /SIREN/);
    });

    test('un seul site de facturation par client', async () => {
      const site = (nom, facturation) => request(app).post(`/api/clients/${clientId}/sites`)
        .set('Authorization', `Bearer ${session}`)
        .send({ nom, adresse: '1 rue des Tests', codePostal: '14000', ville: 'Caen', estSiteFacturation: facturation });

      assert.equal((await site('Siège', true)).status, 201);
      assert.equal((await site('Dépôt', true)).status, 201);

      const client = await request(app).get(`/api/clients/${clientId}`).set('Authorization', `Bearer ${session}`);
      const facturation = client.body.sites.filter((s) => s.estSiteFacturation);
      assert.equal(facturation.length, 1, 'poser le drapeau doit retirer le précédent');
      assert.equal(facturation[0].nom, 'Dépôt');
    });

    test('la désactivation retire le client des listes sans le supprimer', async () => {
      assert.equal((await request(app).delete(`/api/clients/${clientId}`).set('Authorization', `Bearer ${session}`)).status, 200);
      const liste = await request(app).get('/api/clients').set('Authorization', `Bearer ${session}`);
      assert.equal(liste.body.clients.some((c) => c.id === clientId), false);
      assert.ok(await prisma.client.findUnique({ where: { id: clientId } }), 'la fiche doit rester en base');
    });
  });

  describe('API d’intégration (agent)', () => {
    let session = '';

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
      const cle = await request(app).post('/api/admin/api-keys')
        .set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST agent lecture', scopes: ['clients:read'] });
      cleApi = cle.body.apiKey;
    });

    test('le secret n’est révélé qu’à la création', async () => {
      assert.match(cleApi, /^iris_/);
      const liste = await request(app).get('/api/admin/api-keys').set('Authorization', `Bearer ${session}`);
      const creee = liste.body.find((k) => k.nom === 'TEST agent lecture');
      assert.ok(creee, 'la clé doit apparaître dans la liste');
      assert.equal(creee.secretHash, undefined, 'la liste ne doit jamais exposer l’empreinte');
      assert.equal(JSON.stringify(liste.body).includes(cleApi), false, 'le secret ne doit jamais ressortir');
    });

    test('la clé ouvre les routes de son scope', async () => {
      const res = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${cleApi}`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.clients));
    });

    test('elle est refusée sur un scope qu’elle n’a pas', async () => {
      // Lecture seule : l'écriture doit renvoyer 403, pas 401 — la clé est valide, c'est
      // le droit qui manque.
      const res = await request(app).post('/api/v1/clients')
        .set('Authorization', `Bearer ${cleApi}`)
        .send({ raisonSociale: 'TEST Interdit' });
      assert.equal(res.status, 403);
      assert.match(res.body.error, /clients:write/);
    });

    test('une clé révoquée cesse immédiatement de fonctionner', async () => {
      const liste = await request(app).get('/api/admin/api-keys').set('Authorization', `Bearer ${session}`);
      const cible = liste.body.find((k) => k.nom === 'TEST agent lecture');
      await request(app).post(`/api/admin/api-keys/${cible.id}/revoke`).set('Authorization', `Bearer ${session}`);
      const res = await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${cleApi}`);
      assert.equal(res.status, 401);
    });

    test('un agent en écriture applique les mêmes règles qu’un humain', async () => {
      const cle = await request(app).post('/api/admin/api-keys')
        .set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST agent ecriture', scopes: ['clients:write', 'catalogue:write'] });
      const secret = cle.body.apiKey;

      // Même validation que par l'interface : c'est le même handler.
      const invalide = await request(app).post('/api/v1/clients').set('Authorization', `Bearer ${secret}`).send({});
      assert.equal(invalide.status, 400);
      assert.match(invalide.body.error, /raison sociale/);

      const valide = await request(app).post('/api/v1/clients')
        .set('Authorization', `Bearer ${secret}`)
        .send({ raisonSociale: 'TEST Client créé par un agent' });
      assert.equal(valide.status, 201);

      const fiche = await request(app).post('/api/v1/catalogue/prestations')
        .set('Authorization', `Bearer ${secret}`)
        .send({ reference: 'TEST-POSE-01', nom: 'Pose de caméra', prixVenteHt: '250', tauxTva: '20' });
      assert.equal(fiche.status, 201, JSON.stringify(fiche.body));
      assert.equal(fiche.body.prixVenteHt, 250);
    });
  });

  // Chaque scénario possède son commercial et son chantier : les autres coûts du harnais ne
  // peuvent pas masquer une régression financière. Le barème global réglé à 10 % ne produit
  // aucune commission : sans plan commercial, il n'y en a pas (décision du 17-10-2026).
  describe('Archivage Travaux : coûts, marge, et aucune commission sans plan commercial', () => {
    for (const scenario of [
      { nom: 'achat', chemin: '/api/achats', cible: 'ACHAT', cout: 120,
        corps: (chantierId, categorieId, fournisseurId) => ({ chantierId, categorieId, fournisseurId, date: '2026-09-05', description: 'TEST achat financier', montantHT: 120 }) },
      { nom: 'pointage', chemin: '/api/heures', cible: 'HEURE', cout: 80,
        corps: (chantierId, _categorieId, _fournisseurId, intervenantId) => ({ chantierId, intervenantId, date: '2026-09-05', nbrHeures: 2 }) },
    ]) {
      test(`${scenario.nom} : avant, archive et restauration rétablissent la marge sans toucher au journal, toujours sans commission`, async () => {
        const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
        assert.equal(login.status, 200);
        const auth = { Authorization: `Bearer ${login.body.token}` };
        const ancienParametres = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
        const anciennesRegles = await prisma.parametresRemuneration.findUnique({ where: { id: 'singleton' } });
        try {
          const activation = await request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: true });
          assert.equal(activation.status, 200);
          const bareme = await request(app).put('/api/parametres/remuneration').set(auth).send({
            baremeStandard: [{ plafond: null, taux: 10 }], baremeReduit: [], libelleBaremeReduit: 'Réduit',
            objectifCaMensuel: 0, primeObjectifCa: 0, objectifMargeMensuel: 0,
            primeObjectifMarge: 0, primeSuiviAdministratif: 0,
          });
          assert.equal(bareme.status, 200);
          const commercial = await prisma.user.create({ data: {
            email: `finances.archive.${scenario.nom}@iris.test`, name: `TEST Commercial ${scenario.nom}`, role: 'COMMERCIAL',
          } });
          const conducteur = scenario.nom === 'pointage' ? await prisma.user.create({ data: {
            email: `finances.archive.conducteur.${scenario.nom}@iris.test`, name: `TEST Conducteur ${scenario.nom}`, role: 'CONDUCTEUR_TRAVAUX',
          } }) : null;
          const chantier = await prisma.chantier.create({ data: {
            nom: `TEST Finances ${scenario.nom}`, client: 'TEST Client finances', dateDebut: new Date(),
            budgetGlobalVendu: 1000, budgetMaterielVendu: 500, heuresVendues: 10, commercialId: commercial.id,
            responsableId: conducteur?.id,
          } });
          const affectation = await request(app).patch(`/api/chantiers/${chantier.id}/commercial`).set(auth).send({ commercialId: commercial.id });
          assert.equal(affectation.status, 200, JSON.stringify(affectation.body));
          const cloture = await request(app).patch(`/api/chantiers/${chantier.id}/statut`).set(auth).send({ statut: 'TERMINE' });
          assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
          const encaisse = await request(app).patch(`/api/chantiers/${chantier.id}/encaisse`).set(auth).send({ encaisse: true });
          assert.equal(encaisse.status, 200, JSON.stringify(encaisse.body));
          const ref = cloture.body.dateFin.slice(0, 7);
          const categorie = await prisma.categorie.create({ data: { nom: `TEST Finances catégorie ${scenario.nom}` } });
          const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Finances fournisseur ${scenario.nom}` } });
          const intervenant = await prisma.intervenant.create({ data: { nom: `TEST Finances intervenant ${scenario.nom}`, role: 'Technicien', tauxHoraireCharge: 40 } });
          // Le global n'expose pas les relations : épingler son total de période avec
          // le rôle qui y a accès (admin pour achats, conducteur pour heures).
          const authGlobal = conducteur
            ? { Authorization: `Bearer ${jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET)}` }
            : auth;
          const global = () => request(app).get('/api/stats/global')
            .query({ period: 'month', ref: '2026-09-05' }).set(authGlobal);
          const totalGlobal = scenario.nom === 'achat' ? 'achatsTotal' : 'heuresTotal';
          const avantGlobal = await global();
          assert.equal(avantGlobal.status, 200, JSON.stringify(avantGlobal.body));
          assert.equal(typeof avantGlobal.body[totalGlobal], 'number');
          const creation = await request(app).post(scenario.chemin).set(auth)
            .send(scenario.corps(chantier.id, categorie.id, fournisseur.id, intervenant.id));
          assert.equal(creation.status, 200, JSON.stringify(creation.body));
          const id = creation.body.id;
          const verifier = async (cout, actif) => {
            const detail = await request(app).get(`/api/chantiers/${chantier.id}`).set(auth);
            assert.equal(detail.status, 200);
            assert.equal(detail.body.metrics.materielReel, scenario.nom === 'achat' ? cout : 0);
            assert.equal(detail.body.metrics.moReel, scenario.nom === 'pointage' ? cout : 0);
            assert.equal(detail.body.metrics.heuresRealisees, scenario.nom === 'pointage' && actif ? 2 : 0);
            assert.equal(detail.body.metrics.totalDepenses, cout);
            assert.equal(detail.body.metrics.margeCommerciale, 1000 - cout);
            assert.equal(detail.body[scenario.nom === 'achat' ? 'achats' : 'pointages'].some(ligne => ligne.id === id), actif);
            const liste = await request(app).get('/api/chantiers').set(auth);
            assert.equal(liste.status, 200, JSON.stringify(liste.body));
            const chantierListe = liste.body.find(ligne => ligne.id === chantier.id);
            assert.ok(chantierListe, 'chantier isolé présent dans la liste');
            assert.equal(chantierListe[scenario.nom === 'achat' ? 'achats' : 'pointages'].some(ligne => ligne.id === id), actif,
              `${scenario.nom} : relation de la liste exclut les archives`);
            assert.equal(chantierListe.metrics.materielReel, scenario.nom === 'achat' ? cout : 0);
            assert.equal(chantierListe.metrics.moReel, scenario.nom === 'pointage' ? cout : 0);
            assert.equal(chantierListe.metrics.heuresRealisees, scenario.nom === 'pointage' && actif ? 2 : 0);
            assert.equal(chantierListe.metrics.totalDepenses, cout);
            assert.equal(chantierListe.metrics.margeCommerciale, 1000 - cout);
            const statsGlobal = await global();
            assert.equal(statsGlobal.status, 200, JSON.stringify(statsGlobal.body));
            assert.equal(statsGlobal.body[totalGlobal], avantGlobal.body[totalGlobal]
              + (actif ? scenario.nom === 'achat' ? scenario.cout : 2 : 0),
              `${scenario.nom} : total global de période n'inclut que les saisies actives`);
            const stats = await request(app).get('/api/stats/commerciaux').query({ period: 'month', ref }).set(auth);
            assert.equal(stats.status, 200, JSON.stringify(stats.body));
            const resultat = stats.body.commerciaux.find(ligne => ligne.id === commercial.id);
            assert.ok(resultat, 'commercial isolé présent');
            assert.equal(resultat.caTotal, 1000, 'affaire terminée et encaissée comptabilisée');
            assert.equal(resultat.margeTotal, 1000 - cout);
            assert.equal(resultat.sansPlanCommercial, true);
            assert.equal(resultat.commissionBareme, 0, 'barème global non appliqué sans plan commercial');
            assert.equal(resultat.commissionTotal, 0);
            const ligne = resultat.chantiers.find(c => c.id === chantier.id);
            assert.equal(ligne.comptabiliseDansPeriode, true);
            assert.equal(ligne.margeCommerciale, 1000 - cout);
            assert.equal(ligne.commissionEstimee, 0);
          };
          await verifier(scenario.cout, true);
          const archive = await request(app).delete(`${scenario.chemin}/${id}`).set(auth).send({ motifArchivage: 'Saisie en double' });
          assert.equal(archive.status, 200, JSON.stringify(archive.body));
          await verifier(0, false);
          const restauration = await request(app).post(`${scenario.chemin}/${id}/restaurer`).set(auth)
            .send({ motifRestauration: 'Saisie vérifiée et rétablie' });
          assert.equal(restauration.status, 200, JSON.stringify(restauration.body));
          await verifier(scenario.cout, true);
          const traces = await prisma.journalSaisieChantier.findMany({ where: { cible: scenario.cible, cibleId: id }, orderBy: { createdAt: 'asc' } });
          assert.deepEqual(traces.map(t => t.action), ['CREATION', 'ARCHIVAGE', 'RESTAURATION']);
          assert.equal(traces[1].motif, 'Saisie en double');
          assert.equal(traces[2].motif, 'Saisie vérifiée et rétablie');
          assert.ok(traces[1].apres.archivedAt);
          assert.equal(traces[2].apres.archivedAt, null);
        } finally {
          if (ancienParametres) await prisma.parametres.update({ where: { id: 'singleton' }, data: { margeCommercialeActive: ancienParametres.margeCommercialeActive } });
          if (anciennesRegles) await prisma.parametresRemuneration.update({ where: { id: 'singleton' }, data: {
            baremeStandard: anciennesRegles.baremeStandard, baremeReduit: anciennesRegles.baremeReduit,
            libelleBaremeReduit: anciennesRegles.libelleBaremeReduit,
            objectifCaMensuel: anciennesRegles.objectifCaMensuel, primeObjectifCa: anciennesRegles.primeObjectifCa,
            objectifMargeMensuel: anciennesRegles.objectifMargeMensuel, primeObjectifMarge: anciennesRegles.primeObjectifMarge,
            primeSuiviAdministratif: anciennesRegles.primeSuiviAdministratif,
          } });
        }
      });
    }
  });

  // Décision de Nelson du 17-10-2026 : sans plan commercial, un commercial ne touche aucune
  // commission ni prime, jusqu'à l'attribution d'un plan à date. Aucun plan n'existe encore :
  // le barème global, les objectifs et la prime de suivi administratif, même réglés et
  // atteints, ne produisent rien, ni pour l'administrateur ni pour le commercial.
  test('sans plan commercial : ni commission ni prime, malgré un barème, des objectifs atteints et un suivi administratif validé', async () => {
    const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
    assert.equal(login.status, 200);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const ancienParametres = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
    const anciennesRegles = await prisma.parametresRemuneration.findUnique({ where: { id: 'singleton' } });
    const suffixe = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    let commercial = null;
    try {
      assert.equal((await request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: true })).status, 200);
      const regles = await request(app).put('/api/parametres/remuneration').set(auth).send({
        baremeStandard: [{ plafond: null, taux: 10 }], baremeReduit: [{ plafond: null, taux: 5 }], libelleBaremeReduit: 'Réduit sans plan',
        objectifCaMensuel: 500, primeObjectifCa: 100, objectifMargeMensuel: 100,
        primeObjectifMarge: 50, primeSuiviAdministratif: 30,
      });
      assert.equal(regles.status, 200, JSON.stringify(regles.body));
      // Adresse fixe, purgée par le nettoyage du harnais avec ses chantiers « TEST ».
      commercial = await prisma.user.create({ data: {
        email: 'sans.plan.commercial@iris.test', name: `TEST Commercial sans plan ${suffixe}`, role: 'COMMERCIAL',
      } });
      const clotures = [];
      for (const [nom, montant, baremeReduit] of [['standard', 1000, false], ['réduit', 600, true]]) {
        const chantier = await prisma.chantier.create({ data: {
          nom: `TEST Sans plan ${nom} ${suffixe}`, client: 'TEST Client sans plan', dateDebut: new Date(),
          budgetGlobalVendu: montant, budgetMaterielVendu: 0, heuresVendues: 0, commercialId: commercial.id, baremeReduit,
        } });
        const cloture = await request(app).patch(`/api/chantiers/${chantier.id}/statut`).set(auth).send({ statut: 'TERMINE' });
        assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
        assert.equal((await request(app).patch(`/api/chantiers/${chantier.id}/encaisse`).set(auth).send({ encaisse: true })).status, 200);
        clotures.push(cloture.body.dateFin);
      }
      const ref = clotures[0].slice(0, 7);
      assert.equal(clotures[1].slice(0, 7), ref, 'les deux chantiers sont clôturés le même mois');
      // Le suivi administratif reste un fait enregistré et journalisé ; il n'ouvre aucune prime.
      const suivi = await request(app).put(`/api/commerciaux/${commercial.id}/prime-mensuelle`).set(auth).send({ periode: ref, suiviAdministratif: true });
      assert.equal(suivi.status, 200, JSON.stringify(suivi.body));

      const authCommercial = { Authorization: `Bearer ${jwt.sign({ id: commercial.id }, process.env.JWT_SECRET)}` };
      for (const [qui, enTete] of [['administrateur', auth], ['commercial', authCommercial]]) {
        const stats = await request(app).get('/api/stats/commerciaux').query({ period: 'month', ref }).set(enTete);
        assert.equal(stats.status, 200, JSON.stringify(stats.body));
        assert.ok(!('bareme' in stats.body) && !('objectifs' in stats.body), `${qui} : ni barème ni objectifs exposés`);
        const resultat = stats.body.commerciaux.find((ligne) => ligne.id === commercial.id);
        assert.ok(resultat, `${qui} : commercial présent`);
        assert.deepEqual(
          [resultat.caTotal, resultat.margeTotal, resultat.margeStandard, resultat.margeReduite, resultat.suiviAdministratif],
          [1600, 1600, 1000, 600, true],
          `${qui} : CA et marge validés restent calculés`,
        );
        assert.deepEqual(
          [resultat.commissionStandard, resultat.commissionReduite, resultat.commissionBareme, resultat.primeCA, resultat.primeMarge, resultat.primeAdmin, resultat.commissionTotal],
          [0, 0, 0, 0, 0, 0, 0],
          `${qui} : aucune commission ni prime`,
        );
        assert.equal(resultat.sansPlanCommercial, true);
        assert.equal(resultat.chantiers.length, 2);
        for (const ligne of resultat.chantiers) assert.deepEqual([ligne.comptabiliseDansPeriode, ligne.commissionEstimee], [true, 0], ligne.nom);
      }

      const globalAdmin = await request(app).get('/api/stats/global').query({ period: 'month', ref: clotures[0] }).set(auth);
      assert.equal(globalAdmin.status, 200, JSON.stringify(globalAdmin.body));
      assert.deepEqual([globalAdmin.body.commissionCommercialeTotal, globalAdmin.body.sansPlanCommercial], [0, true]);
      const globalCommercial = await request(app).get('/api/stats/global').query({ period: 'month', ref: clotures[0] }).set(authCommercial);
      assert.equal(globalCommercial.status, 200, JSON.stringify(globalCommercial.body));
      assert.deepEqual(
        [globalCommercial.body.margeTotal, globalCommercial.body.commissionTotal, globalCommercial.body.sansPlanCommercial],
        [1600, 0, true],
      );
    } finally {
      if (ancienParametres) await prisma.parametres.update({ where: { id: 'singleton' }, data: { margeCommercialeActive: ancienParametres.margeCommercialeActive } });
      if (anciennesRegles) await prisma.parametresRemuneration.update({ where: { id: 'singleton' }, data: {
        baremeStandard: anciennesRegles.baremeStandard, baremeReduit: anciennesRegles.baremeReduit,
        libelleBaremeReduit: anciennesRegles.libelleBaremeReduit,
        objectifCaMensuel: anciennesRegles.objectifCaMensuel, primeObjectifCa: anciennesRegles.primeObjectifCa,
        objectifMargeMensuel: anciennesRegles.objectifMargeMensuel, primeObjectifMarge: anciennesRegles.primeObjectifMarge,
        primeSuiviAdministratif: anciennesRegles.primeSuiviAdministratif,
      } });
      if (commercial) {
        const chantierIds = (await prisma.chantier.findMany({ where: { commercialId: commercial.id }, select: { id: true } })).map((c) => c.id);
        await prisma.journalSaisieChantier.deleteMany({ where: { chantierId: { in: chantierIds } } });
        await prisma.chantier.deleteMany({ where: { id: { in: chantierIds } } });
        await prisma.user.delete({ where: { id: commercial.id } });
      }
    }
  });

  // Cœur de la correction : ces journaux renvoyaient TOUS les achats et TOUTES les heures
  // de TOUS les chantiers, chacun avec son chantier complet — budgets vendus compris — à
  // n'importe quel compte connecté. Les tests ci-dessous vérifient les deux moitiés du
  // défaut : le périmètre (qui voit quoi) et le contenu (ce que porte chaque ligne).
  describe('Journaux d’achats et d’heures : périmètre et montants', () => {
    let session = '';
    let sessionConducteur = '';
    let sessionCorrecteur = '';
    let idConducteur = '';
    let idCorrecteur = '';
    let idChantierA = '';
    let idChantierB = '';
    let idCategorie = '';
    let idFournisseur = '';
    let idIntervenant = '';

    // Remplace temporairement les permissions ; les permissions initiales sont restaurées ensuite.
    async function avecDelegation(userId, permissions, corps) {
      const avant = (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { permissions: true } })).permissions;
      await prisma.user.update({ where: { id: userId }, data: { permissions } });
      try {
        return await corps();
      } finally {
        await prisma.user.update({ where: { id: userId }, data: { permissions: avant } });
      }
    }

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;

      // Un conducteur, responsable d'un seul des deux chantiers.
      const conducteur = await prisma.user.upsert({
        where: { email: 'conducteur.test@iris.test' },
        update: { role: 'CONDUCTEUR_TRAVAUX', actif: true },
        create: { email: 'conducteur.test@iris.test', name: 'TEST Conducteur', role: 'CONDUCTEUR_TRAVAUX' },
      });
      idConducteur = conducteur.id;
      const correcteur = await prisma.user.upsert({
        where: { email: 'correcteur.test@iris.test' },
        update: { role: 'ADMIN', actif: true },
        create: { email: 'correcteur.test@iris.test', name: 'TEST Correcteur', role: 'ADMIN' },
      });
      idCorrecteur = correcteur.id;
      const jwt = (await import('jsonwebtoken')).default;
      sessionConducteur = jwt.sign({ id: conducteur.id, role: 'CONDUCTEUR_TRAVAUX' }, process.env.JWT_SECRET);
      sessionCorrecteur = jwt.sign({ id: correcteur.id, role: 'ADMIN' }, process.env.JWT_SECRET);

      const chantier = (nom, responsableId) => prisma.chantier.create({
        data: { nom, client: 'TEST Client', dateDebut: new Date(), budgetGlobalVendu: 100000, responsableId },
      });
      idChantierA = (await chantier('TEST Chantier du conducteur', conducteur.id)).id;
      idChantierB = (await chantier('TEST Chantier d’un autre', null)).id;

      const categorie = await prisma.categorie.upsert({
        where: { nom: 'TEST Catégorie' }, update: {}, create: { nom: 'TEST Catégorie' },
      });
      const fournisseur = await prisma.fournisseur.upsert({
        where: { nom: 'TEST Fournisseur' }, update: {}, create: { nom: 'TEST Fournisseur' },
      });
      const intervenant = await prisma.intervenant.create({
        data: { nom: 'TEST Intervenant', role: 'Technicien', tauxHoraireCharge: 40 },
      });

      idCategorie = categorie.id;
      idFournisseur = fournisseur.id;
      idIntervenant = intervenant.id;

      for (const chantierId of [idChantierA, idChantierB]) {
        await prisma.achatReel.create({
          data: { date: new Date(), description: 'TEST achat', montantHT: 1000, chantierId, categorieId: categorie.id, fournisseurId: fournisseur.id, createdById: idConducteur, updatedById: idConducteur },
        });
        await prisma.pointageHeure.create({
          data: { date: new Date(), nbrHeures: 7, tauxHoraireApplique: 40, chantierId, intervenantId: intervenant.id, createdById: idConducteur, updatedById: idConducteur },
        });
      }
    });

    test('un conducteur ne reçoit que les lignes de SES chantiers', async () => {
      const achats = await request(app).get('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(achats.status, 200);
      const chantiersVus = new Set(achats.body.map((a) => a.chantier?.id));
      assert.ok(chantiersVus.has(idChantierA), 'son propre chantier doit être visible');
      assert.equal(chantiersVus.has(idChantierB), false, 'le chantier d’un autre ne doit pas apparaître');

      const heures = await request(app).get('/api/heures').set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(heures.status, 200);
      const chantiersHeures = new Set(heures.body.map((h) => h.chantier?.id));
      assert.equal(chantiersHeures.has(idChantierB), false);
    });

    test('un conducteur ne peut écrire que dans son chantier et avec des valeurs positives', async () => {
      const achatInterdit = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierB, categorieId: idCategorie, fournisseurId: idFournisseur, date: '2026-09-05', description: 'TEST interdit', montantHT: 10,
      });
      assert.equal(achatInterdit.status, 404);
      const achatNegatif = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '2026-09-05', description: 'TEST négatif', montantHT: -10,
      });
      assert.equal(achatNegatif.status, 400);
      for (const date of ['', 'not-a-date', '2026-02-31', '31-02-2026', '2026-13-01']) {
        const invalide = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
          chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date, description: 'TEST date', montantHT: 10,
        });
        assert.equal(invalide.status, 400, `date ${date} doit être refusée`);
      }
      const dateFrancaise = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST date française', montantHT: 10,
      });
      assert.equal(dateFrancaise.status, 200);
      const achatGratuit = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST remplacement sous garantie', montantHT: 0,
      });
      assert.equal(achatGratuit.status, 200);
      for (const montantHT of ['0.001', '1.999', '1e-3', '99999999999']) {
        const invalide = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
          chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '2026-09-05', description: 'TEST précision', montantHT,
        });
        assert.equal(invalide.status, 400, `montant ${montantHT} doit être refusé`);
      }
      const heuresInterdites = await request(app).post('/api/heures').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierB, intervenantId: idIntervenant, date: '2026-09-05', nbrHeures: 2,
      });
      assert.equal(heuresInterdites.status, 404);
    });

    test('la création et la correction conservent leurs auteurs distincts', async () => {
      const scenarios = [
        { nom: 'achat', chemin: '/api/achats', creation: { chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST auteurs achat', montantHT: 10 }, correction: { montantHT: 11, motifCorrection: 'Correction de montant' }, modele: prisma.achatReel },
        { nom: 'pointage', chemin: '/api/heures', creation: { chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2 }, correction: { nbrHeures: 3, motifCorrection: 'Correction des heures' }, modele: prisma.pointageHeure },
      ];
      for (const scenario of scenarios) {
        const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
        assert.equal(creation.status, 200, `${scenario.nom} créé`);
        const cree = await scenario.modele.findUniqueOrThrow({ where: { id: creation.body.id } });
        assert.equal(cree.createdById, idConducteur, `${scenario.nom} : auteur de création`);
        assert.equal(cree.updatedById, idConducteur, `${scenario.nom} : dernier auteur initial`);
        const correction = await request(app).patch(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${sessionCorrecteur}`).send(scenario.correction);
        assert.equal(correction.status, 200, `${scenario.nom} corrigé`);
        const corrige = await scenario.modele.findUniqueOrThrow({ where: { id: creation.body.id } });
        assert.equal(corrige.createdById, idConducteur, `${scenario.nom} : l’auteur de création est immuable`);
        assert.equal(corrige.updatedById, idCorrecteur, `${scenario.nom} : le dernier correcteur est conservé`);
      }
    });

    test('une correction exige un motif et le conserve avec ses snapshots', async () => {
      const scenarios = [
        { nom: 'achat', chemin: '/api/achats', creation: { chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST motif achat', montantHT: 10 }, correction: { montantHT: 11 } },
        { nom: 'pointage', chemin: '/api/heures', creation: { chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2 }, correction: { nbrHeures: 3 } },
      ];
      for (const scenario of scenarios) {
        const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
        assert.equal(creation.status, 200, `${scenario.nom} créé`);
        for (const motifCorrection of ['', 'x', 'x'.repeat(501), '😀😀']) {
          const refus = await request(app).patch(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`)
            .send({ ...scenario.correction, motifCorrection });
          assert.equal(refus.status, 400, `${scenario.nom} : motif de correction invalide refusé`);
        }
        const motifCorrection = 'Valeur de saisie rectifiée';
        const correction = await request(app).patch(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`)
          .send({ ...scenario.correction, motifCorrection });
        assert.equal(correction.status, 200, `${scenario.nom} corrigé`);
        const trace = await prisma.journalSaisieChantier.findFirstOrThrow({ where: { cibleId: creation.body.id, action: 'CORRECTION' } });
        assert.equal(trace.motif, motifCorrection, `${scenario.nom} : motif conservé dans le journal`);
        assert.ok(trace.avant && trace.apres, `${scenario.nom} : snapshots conservés`);
      }
    });

    test('aucune ligne ne transporte les montants vendus du chantier', async () => {
      // Le défaut d'origine : `include: { chantier: true }` renvoyait l'enregistrement
      // entier. Un administrateur y a droit ailleurs, mais pas ici — ces journaux n'ont
      // aucune raison de véhiculer un budget.
      for (const chemin of ['/api/achats', '/api/heures']) {
        const res = await request(app).get(chemin).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 200);
        assert.ok(res.body.length > 0, `${chemin} doit renvoyer des lignes`);
        for (const ligne of res.body) {
          assert.equal(ligne.chantier?.budgetGlobalVendu, undefined, `${chemin} expose budgetGlobalVendu`);
          assert.equal(ligne.chantier?.budgetMaterielVendu, undefined, `${chemin} expose budgetMaterielVendu`);
          assert.equal(ligne.chantier?.budgetMainOeuvreVendu, undefined, `${chemin} expose budgetMainOeuvreVendu`);
          assert.equal(ligne.chantier?.heuresVendues, undefined, `${chemin} expose heuresVendues`);
        }
      }
    });

    test('un archivage sort une écriture des journaux et laisse une trace immutable', async () => {
      const creation = await request(app).post('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`).send({
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '2026-09-05', description: 'TEST archive', montantHT: 500,
      });
      assert.equal(creation.status, 200);
      const correction = await request(app).patch(`/api/achats/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send({ montantHT: 50, motifCorrection: 'Montant facturé erroné' });
      assert.equal(correction.status, 200);
      const archiveConducteur = await request(app).delete(`/api/achats/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Saisie en double' });
      assert.equal(archiveConducteur.status, 403, 'un conducteur ne peut pas archiver sans délégation');

      await avecDelegation(idConducteur, ['chantiers:archive'], async () => {
        const archive = await request(app).delete(`/api/achats/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Saisie en double' });
        assert.equal(archive.status, 200, 'la délégation individuelle d’archivage est effective');
        const journal = await request(app).get('/api/achats').set('Authorization', `Bearer ${sessionConducteur}`);
        assert.equal(journal.body.some((a) => a.id === creation.body.id), false);
        const traces = await prisma.journalSaisieChantier.findMany({ where: { cibleId: creation.body.id }, orderBy: { createdAt: 'asc' } });
        assert.equal(traces.length, 3);
        assert.equal(Number(traces.find((t) => t.action === 'CORRECTION').avant.montantHT), 500);
        assert.equal(Number(traces.find((t) => t.action === 'CORRECTION').apres.montantHT), 50);
      });
    });

    test('un archivage se restaure avec un motif et réintègre les coûts actifs', async () => {
      const scenarios = [
        { nom: 'achat', chemin: '/api/achats', cible: 'ACHAT', creation: { chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST achat restauré', montantHT: 42 } },
        { nom: 'pointage', chemin: '/api/heures', cible: 'HEURE', creation: { chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2 } },
      ];
      for (const scenario of scenarios) {
        const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
        assert.equal(creation.status, 200, `${scenario.nom} créé`);
        const archivage = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`)
          .send({ motifArchivage: 'Saisie suspendue à vérifier' });
        assert.equal(archivage.status, 200, `${scenario.nom} archivé`);

        const motifRestauration = 'Saisie vérifiée et rétablie';
        const restauration = await request(app).post(`${scenario.chemin}/${creation.body.id}/restaurer`).set('Authorization', `Bearer ${session}`)
          .send({ motifRestauration });
        assert.equal(restauration.status, 200, `${scenario.nom} restauré`);
        const actif = await request(app).get(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`);
        assert.ok(actif.body.some((ligne) => ligne.id === creation.body.id), `${scenario.nom} restauré réintègre le journal actif`);
        const trace = await prisma.journalSaisieChantier.findFirstOrThrow({ where: { cible: scenario.cible, cibleId: creation.body.id, action: 'RESTAURATION' } });
        assert.equal(trace.motif, motifRestauration, `${scenario.nom} : motif de restauration tracé`);
        assert.equal(trace.avant.archivedAt === null, false, `${scenario.nom} : snapshot avant archivé`);
        assert.equal(trace.apres.archivedAt, null, `${scenario.nom} : snapshot après actif`);
      }
    });

    test('la restauration exige la délégation d’archivage, le périmètre, une archive et un motif', async () => {
      // Les deux routes de restauration portent chacune leurs gardes : celles de l'achat ne
      // couvrent pas celles du pointage. Chaque refus est épinglé séparément sur les deux.
      const scenarios = [
        { nom: 'achat', chemin: '/api/achats', creation: (chantierId) => ({ chantierId, categorieId: idCategorie, fournisseurId: idFournisseur, date: '06-09-2026', description: 'TEST restauration gardée', montantHT: 12 }) },
        { nom: 'pointage', chemin: '/api/heures', creation: (chantierId) => ({ chantierId, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 1 }) },
      ];
      const motifRestauration = 'Saisie vérifiée et rétablie';
      for (const scenario of scenarios) {
        const restaurer = (ecritureId, jeton, corps = { motifRestauration }) => request(app).post(`${scenario.chemin}/${ecritureId}/restaurer`)
          .set('Authorization', `Bearer ${jeton}`).send(corps);
        const dansA = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${session}`).send(scenario.creation(idChantierA));
        const dansB = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${session}`).send(scenario.creation(idChantierB));
        assert.equal(dansA.status, 200, `${scenario.nom} créé dans le chantier du conducteur`);
        assert.equal(dansB.status, 200, `${scenario.nom} créé hors de son périmètre`);
        assert.equal((await restaurer(dansA.body.id, session)).status, 409, `${scenario.nom} actif : rien à restaurer`);

        for (const ecritureId of [dansA.body.id, dansB.body.id]) {
          const archivage = await request(app).delete(`${scenario.chemin}/${ecritureId}`).set('Authorization', `Bearer ${session}`)
            .send({ motifArchivage: 'Saisie à vérifier' });
          assert.equal(archivage.status, 200, `${scenario.nom} archivé`);
        }
        assert.equal((await restaurer(dansA.body.id, sessionConducteur)).status, 403, `${scenario.nom} : chantiers:write ne suffit pas`);
        await avecDelegation(idConducteur, ['chantiers:archive'], async () => {
          assert.equal((await restaurer(dansB.body.id, sessionConducteur)).status, 404, `${scenario.nom} hors périmètre : même réponse qu’une affaire absente`);
          assert.equal((await restaurer(dansA.body.id, sessionConducteur, {})).status, 400, `${scenario.nom} sans motif`);
          assert.equal((await restaurer(dansA.body.id, sessionConducteur, { motifRestauration: ' ok ' })).status, 400, `${scenario.nom} motif trop court`);
          assert.equal((await restaurer(dansA.body.id, sessionConducteur)).status, 200, `${scenario.nom} restauré avec la délégation`);
        });
        assert.equal((await restaurer(dansA.body.id, session)).status, 409, `${scenario.nom} déjà restauré`);

        const statuts = (await Promise.all([restaurer(dansB.body.id, session), restaurer(dansB.body.id, session)])).map((res) => res.status).sort();
        assert.deepEqual(statuts, [200, 409], `${scenario.nom} : une seule restauration concurrente aboutit`);
        for (const ecritureId of [dansA.body.id, dansB.body.id]) {
          const traces = await prisma.journalSaisieChantier.count({ where: { cibleId: ecritureId, action: 'RESTAURATION' } });
          assert.equal(traces, 1, `${scenario.nom} : une seule restauration tracée`);
        }
      }
    });

    test('l’archivage d’un pointage exige la même délégation que celui d’un achat', async () => {
      // Les deux DELETE ont des gardes indépendantes : protéger un achat ne protège pas un
      // pointage. Ce compte dédié évite de dépendre de la délégation d'une fixture partagée.
      const email = 'archiviste.pointage@iris.test';
      const residu = await prisma.user.findUnique({ where: { email } });
      if (residu) {
        await prisma.journalSaisieChantier.deleteMany({ where: { auteurId: residu.id } });
        await prisma.pointageHeure.deleteMany({ where: { OR: [{ createdById: residu.id }, { updatedById: residu.id }, { archivedById: residu.id }] } });
        await prisma.user.delete({ where: { id: residu.id } });
      }
      const archiviste = await prisma.user.create({ data: { email, name: 'TEST Archiviste pointage', role: 'CONDUCTEUR_TRAVAUX', permissions: [] } });
      await prisma.chantier.update({ where: { id: idChantierA }, data: { responsableId: archiviste.id } });
      const jetonArchiviste = jwt.sign({ id: archiviste.id, role: 'CONDUCTEUR_TRAVAUX' }, process.env.JWT_SECRET);
      try {
        const creation = await request(app).post('/api/heures').set('Authorization', `Bearer ${jetonArchiviste}`)
          .send({ chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2 });
        assert.equal(creation.status, 200, 'chantiers:write suffit pour saisir un pointage');
        const refus = await request(app).delete(`/api/heures/${creation.body.id}`).set('Authorization', `Bearer ${jetonArchiviste}`)
          .send({ motifArchivage: 'Saisie en double' });
        assert.equal(refus.status, 403, 'archiver un pointage exige chantiers:archive');
        await prisma.user.update({ where: { id: archiviste.id }, data: { permissions: ['chantiers:archive'] } });
        const archive = await request(app).delete(`/api/heures/${creation.body.id}`).set('Authorization', `Bearer ${jetonArchiviste}`)
          .send({ motifArchivage: 'Saisie en double' });
        assert.equal(archive.status, 200, 'la délégation rend l’archivage du pointage possible');
      } finally {
        await prisma.chantier.update({ where: { id: idChantierA }, data: { responsableId: idConducteur } });
        await prisma.journalSaisieChantier.deleteMany({ where: { auteurId: archiviste.id } });
        await prisma.pointageHeure.deleteMany({ where: { OR: [{ createdById: archiviste.id }, { updatedById: archiviste.id }, { archivedById: archiviste.id }] } });
        await prisma.user.delete({ where: { id: archiviste.id } });
      }
    });

    test('une écriture archivée ne peut plus être corrigée ni archivée une seconde fois', async () => {
      const scenarios = [
        {
          nom: 'achat', chemin: '/api/achats', creation: {
            chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur,
            date: '06-09-2026', description: 'TEST achat figé', montantHT: 25,
          },
          correction: { montantHT: 30, motifCorrection: 'Correction nécessaire' }, cible: 'ACHAT',
        },
        {
          nom: 'pointage', chemin: '/api/heures', creation: {
            chantierId: idChantierA, intervenantId: idIntervenant,
            date: '06-09-2026', nbrHeures: 2,
          },
          correction: { nbrHeures: 3, motifCorrection: 'Correction nécessaire' }, cible: 'HEURE',
        },
      ];
      for (const scenario of scenarios) {
        const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
        assert.equal(creation.status, 200, `${scenario.nom} créé`);
        // PostgreSQL compte les caractères (char_length), JavaScript .length compte les unités
        // UTF-16 : les emoji doivent suivre la même règle à la frontière API.
        for (const motifArchivage of ['', 'x', 'x'.repeat(501), '😀😀']) {
          const invalide = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`).send({ motifArchivage });
          assert.equal(invalide.status, 400, `${scenario.nom} : motif invalide refusé (${[...motifArchivage].length} caractère(s))`);
        }
        const motifLong = '😀'.repeat(300);
        const archiveLongue = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`).send({ motifArchivage: motifLong });
        assert.equal(archiveLongue.status, 200, `${scenario.nom} : 300 caractères doivent être acceptés`);
        const modele = scenario.nom === 'achat' ? prisma.achatReel : prisma.pointageHeure;
        await modele.update({ where: { id: creation.body.id }, data: { archivedAt: null, archivedById: null, motifArchivage: null } });
        await prisma.journalSaisieChantier.deleteMany({ where: { cibleId: creation.body.id, action: 'ARCHIVAGE' } });
        const archive = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`).send({ motifArchivage: 'Saisie en double' });
        assert.equal(archive.status, 200, `${scenario.nom} archivé`);
        const correction = await request(app).patch(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.correction);
        assert.equal(correction.status, 409, `${scenario.nom} archivé ne doit plus être corrigible`);
        const secondeArchive = await request(app).delete(`${scenario.chemin}/${creation.body.id}`).set('Authorization', `Bearer ${session}`).send({ motifArchivage: 'Deuxième demande' });
        assert.equal(secondeArchive.status, 409, `${scenario.nom} archivé ne doit plus être archivable`);
        const traces = await prisma.journalSaisieChantier.findMany({ where: { cible: scenario.cible, cibleId: creation.body.id } });
        assert.equal(traces.length, 2, `${scenario.nom} ne crée aucune trace après archivage`);
      }
    });

    test('la base refuse un archivage incomplet', async () => {
      await assert.rejects(() => prisma.achatReel.create({ data: {
        date: new Date(), description: 'TEST archivage incomplet', montantHT: 1,
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur,
        createdById: idConducteur, updatedById: idConducteur,
        archivedAt: new Date(), motifArchivage: 'Motif sans auteur',
      } }));
      await assert.rejects(() => prisma.pointageHeure.create({ data: {
        date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40,
        chantierId: idChantierA, intervenantId: idIntervenant,
        createdById: idConducteur, updatedById: idConducteur,
        archivedAt: new Date(), archivedById: idConducteur,
      } }));
      await assert.rejects(() => prisma.achatReel.create({ data: {
        date: new Date(), description: 'TEST auteur d’archivage inconnu', montantHT: 1,
        chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur,
        createdById: idConducteur, updatedById: idConducteur,
        archivedAt: new Date(), archivedById: 'compte-inexistant', motifArchivage: 'Auteur inconnu',
      } }));
      await assert.rejects(() => prisma.pointageHeure.create({ data: {
        date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40,
        chantierId: idChantierA, intervenantId: idIntervenant,
        createdById: idConducteur, updatedById: idConducteur,
        archivedAt: new Date(), archivedById: 'compte-inexistant', motifArchivage: 'Auteur inconnu',
      } }));
    });

    test('la base relie les auteurs de saisie et fige l’auteur de création', async () => {
      const scenarios = [
        {
          nom: 'achat', modele: prisma.achatReel,
          creation: { date: new Date(), description: 'TEST auteurs achat SQL', montantHT: 1, chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, createdById: idConducteur, updatedById: idConducteur },
        },
        {
          nom: 'pointage', modele: prisma.pointageHeure,
          creation: { date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40, chantierId: idChantierA, intervenantId: idIntervenant, createdById: idConducteur, updatedById: idConducteur },
        },
      ];
      for (const scenario of scenarios) {
        await assert.rejects(() => scenario.modele.create({ data: { ...scenario.creation, createdById: 'compte-inexistant' } }), `${scenario.nom} : auteur de création inconnu refusé`);
        await assert.rejects(() => scenario.modele.create({ data: { ...scenario.creation, updatedById: 'compte-inexistant' } }), `${scenario.nom} : dernier auteur inconnu refusé`);
        const ecriture = await scenario.modele.create({ data: scenario.creation });
        await assert.rejects(() => scenario.modele.update({ where: { id: ecriture.id }, data: { createdById: idCorrecteur } }), `${scenario.nom} : auteur de création immuable en base`);
        assert.equal((await scenario.modele.findUniqueOrThrow({ where: { id: ecriture.id } })).createdById, idConducteur);
      }
    });

    test('un compte ayant archivé une écriture n’est pas supprimable', async () => {
      const scenarios = ['achat', 'pointage'];
      for (const nom of scenarios) {
        const email = `archiveur.${nom}.protege@iris.test`;
        const residu = await prisma.user.findUnique({ where: { email } });
        if (residu) {
          const referencesAuteur = { OR: [{ createdById: residu.id }, { updatedById: residu.id }, { archivedById: residu.id }] };
          await prisma.achatReel.deleteMany({ where: referencesAuteur });
          await prisma.pointageHeure.deleteMany({ where: referencesAuteur });
          await prisma.user.delete({ where: { id: residu.id } });
        }
        const auteur = await prisma.user.create({ data: { email, name: 'TEST Archiveur protégé', role: 'ADMIN' } });
        const ecriture = nom === 'achat'
          ? await prisma.achatReel.create({ data: { date: new Date(), description: 'TEST achat auteur protégé', montantHT: 1, chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, createdById: auteur.id, updatedById: auteur.id, archivedAt: new Date(), archivedById: auteur.id, motifArchivage: 'Saisie en double' } })
          : await prisma.pointageHeure.create({ data: { date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40, chantierId: idChantierA, intervenantId: idIntervenant, createdById: auteur.id, updatedById: auteur.id, archivedAt: new Date(), archivedById: auteur.id, motifArchivage: 'Saisie en double' } });
        const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
        assert.equal(suppression.status, 409, `${nom} : la suppression doit expliquer la protection de la preuve`);
        assert.match(suppression.body.error, /preuve de traçabilité/);
        assert.match(suppression.body.error, /Désactivez-le plutôt/);
        assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
        if (nom === 'achat') await prisma.achatReel.delete({ where: { id: ecriture.id } });
        else await prisma.pointageHeure.delete({ where: { id: ecriture.id } });
        await prisma.user.delete({ where: { id: auteur.id } });
      }
    });

    test('un compte auteur de saisie n’est pas supprimable', async () => {
      const scenarios = [
        { nom: 'achat créé', modele: prisma.achatReel, creation: (auteurId) => ({ date: new Date(), description: 'TEST achat auteur de saisie', montantHT: 1, chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, createdById: auteurId, updatedById: idConducteur }) },
        { nom: 'achat corrigé', modele: prisma.achatReel, creation: (auteurId) => ({ date: new Date(), description: 'TEST achat correcteur protégé', montantHT: 1, chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur, createdById: idConducteur, updatedById: auteurId }) },
        { nom: 'pointage créé', modele: prisma.pointageHeure, creation: (auteurId) => ({ date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40, chantierId: idChantierA, intervenantId: idIntervenant, createdById: auteurId, updatedById: idConducteur }) },
        { nom: 'pointage corrigé', modele: prisma.pointageHeure, creation: (auteurId) => ({ date: new Date(), nbrHeures: 1, tauxHoraireApplique: 40, chantierId: idChantierA, intervenantId: idIntervenant, createdById: idConducteur, updatedById: auteurId }) },
      ];
      for (const [index, scenario] of scenarios.entries()) {
        const auteur = await prisma.user.create({ data: { email: `auteur.saisie.${index}@iris.test`, name: 'TEST Auteur de saisie', role: 'ADMIN' } });
        const ecriture = await scenario.modele.create({ data: scenario.creation(auteur.id) });
        const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
        assert.equal(suppression.status, 409, `${scenario.nom} : suppression refusée`);
        assert.match(suppression.body.error, /preuve de traçabilité/);
        assert.match(suppression.body.error, /Désactivez-le plutôt/);
        assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
        await scenario.modele.delete({ where: { id: ecriture.id } });
        await prisma.user.delete({ where: { id: auteur.id } });
      }
    });

    test('une écriture archivée hors périmètre reste invisible', async () => {
      await avecDelegation(idConducteur, ['chantiers:archive'], async () => {
        // Le 409 « déjà archivé » ne doit jamais précéder le contrôle de périmètre : il révélerait
        // l’existence et l’état d’une écriture sur une affaire que l’appelant ne peut pas voir.
        const archivees = {
          achat: await prisma.achatReel.create({ data: {
            date: new Date(), description: 'TEST achat archivé hors périmètre', montantHT: 10,
            chantierId: idChantierB, categorieId: idCategorie, fournisseurId: idFournisseur,
            createdById: idConducteur, updatedById: idConducteur,
            archivedAt: new Date(), archivedById: idConducteur, motifArchivage: 'Test de confidentialité',
          } }),
          heure: await prisma.pointageHeure.create({ data: {
            date: new Date(), nbrHeures: 2, tauxHoraireApplique: 40,
            chantierId: idChantierB, intervenantId: idIntervenant,
            createdById: idConducteur, updatedById: idConducteur,
            archivedAt: new Date(), archivedById: idConducteur, motifArchivage: 'Test de confidentialité',
          } }),
        };
        const scenarios = [
          { nom: 'achat', chemin: '/api/achats', correction: { montantHT: 20 } },
          { nom: 'heure', chemin: '/api/heures', correction: { nbrHeures: 3 } },
        ];
        for (const scenario of scenarios) {
          const id = archivees[scenario.nom].id;
          const correction = await request(app).patch(`${scenario.chemin}/${id}`)
            .set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.correction);
          assert.equal(correction.status, 404, `${scenario.nom} archivé hors périmètre : correction invisible`);
          const archivage = await request(app).delete(`${scenario.chemin}/${id}`)
            .set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Deuxième demande' });
          assert.equal(archivage.status, 404, `${scenario.nom} archivé hors périmètre : archivage invisible`);
        }
      });
    });

    test('deux archivages simultanés n’en retiennent qu’un seul', async () => {
      await avecDelegation(idConducteur, ['chantiers:archive'], async () => {
        // Sans le filtre archivedAt: null dans l’UPDATE, deux requêtes concurrentes écrasent la
        // première trace. Les deux modèles portent le même verrou, donc les deux sont couverts.
        const scenarios = [
          { nom: 'achat', chemin: '/api/achats', cible: 'ACHAT', creation: {
            chantierId: idChantierA, categorieId: idCategorie, fournisseurId: idFournisseur,
            date: '06-09-2026', description: 'TEST archivage concurrent', montantHT: 25,
          } },
          { nom: 'pointage', chemin: '/api/heures', cible: 'HEURE', creation: {
            chantierId: idChantierA, intervenantId: idIntervenant, date: '06-09-2026', nbrHeures: 2,
          } },
        ];
        for (const scenario of scenarios) {
          const creation = await request(app).post(scenario.chemin).set('Authorization', `Bearer ${sessionConducteur}`).send(scenario.creation);
          assert.equal(creation.status, 200, `${scenario.nom} créé`);
          const supprimer = () => request(app).delete(`${scenario.chemin}/${creation.body.id}`)
            .set('Authorization', `Bearer ${sessionConducteur}`).send({ motifArchivage: 'Saisie en double' });
          const resultats = await Promise.all([supprimer(), supprimer()]);
          assert.deepEqual(resultats.map((res) => res.status).sort(), [200, 409], `${scenario.nom} : un seul archivage doit réussir`);
          const traces = await prisma.journalSaisieChantier.findMany({ where: { cible: scenario.cible, cibleId: creation.body.id, action: 'ARCHIVAGE' } });
          assert.equal(traces.length, 1, `${scenario.nom} : un seul archivage doit être journalisé`);
        }
      });
    });

    test('le journal d’audit respecte le périmètre du conducteur', async () => {
      // Une trace ne doit pas devenir une porte latérale vers un chantier non rattaché.
      await prisma.journalSaisieChantier.create({
        data: { chantierId: idChantierB, cible: 'ACHAT', cibleId: 'test-hors-perimetre', action: 'CREATION', auteurId: idConducteur, auteurNom: 'TEST Conducteur' },
      });
      const interdit = await request(app).get(`/api/chantiers/${idChantierB}/journal-saisies`).set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(interdit.status, 404);
      const autorise = await request(app).get(`/api/chantiers/${idChantierA}/journal-saisies`).set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(autorise.status, 200);
    });

    test('le journal d’audit référence un auteur réel et protège son compte', async () => {
      // En SQL brut : Prisma refuse un auteurId absent avant PostgreSQL. Cette insertion
      // prouve donc réellement que la contrainte NOT NULL existe encore dans la base.
      await assert.rejects(() => prisma.$executeRawUnsafe(
        `INSERT INTO "JournalSaisieChantier" (id, "chantierId", cible, "cibleId", action, "auteurNom", "createdAt")
         VALUES (gen_random_uuid()::text, $1, 'ACHAT', 'test-auteur-absent', 'CREATION', 'Sans auteur', now())`,
        idChantierA,
      ), 'une trace sans auteur doit être refusée par la base');
      await assert.rejects(() => prisma.journalSaisieChantier.create({
        data: { chantierId: idChantierA, cible: 'ACHAT', cibleId: 'test-auteur-inconnu', action: 'CREATION', auteurId: 'compte-inexistant', auteurNom: 'Auteur inconnu' },
      }));
      const auteur = await prisma.user.create({ data: { email: 'auteur.journal@iris.test', name: 'TEST Auteur journal', role: 'ADMIN' } });
      const trace = await prisma.journalSaisieChantier.create({
        data: { chantierId: idChantierA, cible: 'ACHAT', cibleId: 'test-auteur-journal', action: 'CREATION', auteurId: auteur.id, auteurNom: auteur.name },
      });
      const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 409);
      assert.match(suppression.body.error, /preuve de traçabilité/);
      assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
      await prisma.journalSaisieChantier.delete({ where: { id: trace.id } });
      await prisma.user.delete({ where: { id: auteur.id } });
    });

    test('un administrateur voit bien toutes les lignes', async () => {
      // Le filtrage ne doit pas amputer ceux qui ont légitimement la vue complète.
      const achats = await request(app).get('/api/achats').set('Authorization', `Bearer ${session}`);
      const vus = new Set(achats.body.map((a) => a.chantier?.id));
      assert.ok(vus.has(idChantierA) && vus.has(idChantierB));
    });
  });

  describe('Domaine chantier ouvert à un agent', () => {
    let session = '';
    let cleChantiers = '';
    let cleAvecFinances = '';

    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
      const creer = async (nom, scopes) => {
        const r = await request(app).post('/api/admin/api-keys')
          .set('Authorization', `Bearer ${session}`).send({ nom, scopes });
        return r.body.apiKey;
      };
      cleChantiers = await creer('TEST agent chantiers', ['chantiers:read']);
      cleAvecFinances = await creer('TEST agent finances', ['chantiers:read', 'finances:read']);
    });

    test('une clé chantiers:read lit chantiers, achats et heures', async () => {
      for (const chemin of ['/api/v1/chantiers', '/api/v1/achats', '/api/v1/heures']) {
        const res = await request(app).get(chemin).set('Authorization', `Bearer ${cleChantiers}`);
        assert.equal(res.status, 200, `${chemin} → ${res.status}`);
        assert.ok(Array.isArray(res.body));
      }
    });

    test('elle voit tout le parc : une clé n’a pas de rôle qui la restreindrait', async () => {
      const res = await request(app).get('/api/v1/achats').set('Authorization', `Bearer ${cleChantiers}`);
      const vus = new Set(res.body.map((a) => a.chantier?.id));
      assert.ok(vus.size >= 2, 'un agent autorisé sur le domaine voit l’ensemble des chantiers');
    });

    test('sans finances:read, les montants vendus restent masqués', async () => {
      const res = await request(app).get('/api/v1/chantiers').set('Authorization', `Bearer ${cleChantiers}`);
      assert.equal(res.status, 200);
      const chantier = res.body.find((c) => String(c.nom).startsWith('TEST Chantier'));
      assert.ok(chantier, 'les chantiers de test doivent être visibles');
      assert.equal(chantier.budgetGlobalVendu, null, 'le budget vendu ne doit pas sortir sans finances:read');
      assert.equal(chantier.metrics.margeCommerciale, null, 'la marge ne doit pas sortir sans finances:read');
    });

    test('avec finances:read, ils sortent', async () => {
      const res = await request(app).get('/api/v1/chantiers').set('Authorization', `Bearer ${cleAvecFinances}`);
      const chantier = res.body.find((c) => String(c.nom).startsWith('TEST Chantier'));
      assert.equal(chantier.budgetGlobalVendu, 100000);
      assert.notEqual(chantier.metrics.margeCommerciale, null);
    });

    test('une clé d’un autre domaine reste refusée', async () => {
      const r = await request(app).post('/api/admin/api-keys')
        .set('Authorization', `Bearer ${session}`).send({ nom: 'TEST agent clients', scopes: ['clients:read'] });
      const res = await request(app).get('/api/v1/achats').set('Authorization', `Bearer ${r.body.apiKey}`);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /chantiers:read/);
    });
  });

  // Les alertes de suivi sont calculées par le serveur, une seule fois, pour que la liste,
  // le tableau de bord et l'API d'intégration signalent les mêmes dérives. Le signe de la
  // marge reste une donnée commerciale : « en perte » ne sort que là où la marge sort.
  describe('Suivi de rentabilité : dérives et perte signalées par chantier', () => {
    let auth = {};
    let authConducteur = {};
    let cleSansFinances = '';
    let cleAvecFinances = '';
    let derive;
    let sain;
    let ancienParametres;
    const DERIVES = ['HEURES_DEPASSEES', 'MATERIEL_DEPASSE', 'MAIN_OEUVRE_DEPASSEE'];

    before(async () => {
      const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(login.status, 200);
      auth = { Authorization: `Bearer ${login.body.token}` };
      ancienParametres = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      const activation = await request(app).put('/api/parametres').set(auth)
        .send({ margeCommercialeActive: true, rentabiliteConducteur: true, rentabiliteHierarchie: true, rentabiliteDirecteurs: true });
      assert.equal(activation.status, 200, JSON.stringify(activation.body));
      const conducteur = await prisma.user.create({ data: {
        email: 'rentabilite.conducteur@iris.test', name: 'TEST Conducteur rentabilité', role: 'CONDUCTEUR_TRAVAUX',
      } });
      authConducteur = { Authorization: `Bearer ${jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET)}` };
      const categorie = await prisma.categorie.create({ data: { nom: 'TEST Rentabilité catégorie' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: 'TEST Rentabilité fournisseur' } });
      const intervenant = await prisma.intervenant.create({ data: { nom: 'TEST Rentabilité intervenant', role: 'Technicien', tauxHoraireCharge: 50 } });
      // Même devis pour les deux affaires : 300 € de matériel et 700 € de main-d'œuvre pour
      // 10 h. La dérive est vendue 1 000 € ; l'affaire saine 3 000 €, pour que sa marge
      // estimée reste nettement au-dessus du seuil quel que soit l'historique de la base.
      const vente = { client: 'TEST Client rentabilité', dateDebut: new Date(), budgetGlobalVendu: 1000, budgetMaterielVendu: 300, budgetMainOeuvreVendu: 700, heuresVendues: 10, responsableId: conducteur.id };
      derive = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Rentabilité dérive' } });
      sain = await prisma.chantier.create({ data: { ...vente, budgetGlobalVendu: 3000, nom: 'TEST Rentabilité sain' } });
      // Saisies du jour : aucune de ces affaires n'est « sans saisie ».
      const aujourdhui = jourCivilEntreprise(new Date());
      const achat = (chantierId, montantHT) => request(app).post('/api/achats').set(auth)
        .send({ chantierId, categorieId: categorie.id, fournisseurId: fournisseur.id, date: aujourdhui, description: 'TEST achat rentabilité', montantHT });
      const heures = (chantierId, nbrHeures) => request(app).post('/api/heures').set(auth)
        .send({ chantierId, intervenantId: intervenant.id, date: aujourdhui, nbrHeures });
      // Dérive : 400 € de matériel et 16 h à 50 € (800 €), soit 1 200 € dépensés pour 1 000 € vendus.
      for (const reponse of [await achat(derive.id, 400), await heures(derive.id, 16), await achat(sain.id, 100), await heures(sain.id, 4)]) {
        assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      }
      // Une saisie archivée ne doit déclencher aucune alerte, même énorme.
      const enDouble = await achat(sain.id, 5000);
      assert.equal(enDouble.status, 200, JSON.stringify(enDouble.body));
      const archive = await request(app).delete(`/api/achats/${enDouble.body.id}`).set(auth).send({ motifArchivage: 'Saisie en double' });
      assert.equal(archive.status, 200, JSON.stringify(archive.body));
      const creer = async (nom, scopes) => {
        const r = await request(app).post('/api/admin/api-keys').set(auth).send({ nom, scopes });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        return r.body.apiKey;
      };
      cleSansFinances = await creer('TEST agent rentabilité', ['chantiers:read']);
      cleAvecFinances = await creer('TEST agent rentabilité finances', ['chantiers:read', 'finances:read']);
    });

    after(async () => {
      if (ancienParametres) await prisma.parametres.update({ where: { id: 'singleton' }, data: {
        margeCommercialeActive: ancienParametres.margeCommercialeActive,
        rentabiliteConducteur: ancienParametres.rentabiliteConducteur,
      } });
    });

    const lire = async (chemin, entetes) => {
      const res = await request(app).get(chemin).set(entetes);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const trouver = id => {
        const chantier = res.body.find(c => c.id === id);
        assert.ok(chantier, `chantier ${id} absent de ${chemin}`);
        return chantier;
      };
      return { derive: trouver(derive.id), sain: trouver(sain.id) };
    };

    test('un administrateur voit chaque dépassement et la perte, et rien sur une affaire saine', async () => {
      const liste = await lire('/api/chantiers', auth);
      assert.deepEqual(liste.derive.metrics.alertes, [...DERIVES, 'EN_PERTE']);
      assert.equal(liste.derive.metrics.margeCommerciale, -200);
      assert.equal(Math.round(liste.derive.metrics.pctMainOeuvre), Math.round(800 / 700 * 100));
      assert.deepEqual(liste.sain.metrics.alertes, [], 'l’achat archivé ne compte pas');
      assert.equal(liste.sain.metrics.materielReel, 100);
      assert.equal(liste.sain.metrics.margeCommerciale, 2700);
    });

    test('destinataire par défaut, le conducteur voit la perte de son chantier sur la liste comme sur sa fiche', async () => {
      const liste = await lire('/api/chantiers', authConducteur);
      assert.deepEqual(liste.derive.metrics.alertes, [...DERIVES, 'EN_PERTE']);
      assert.equal(liste.derive.metrics.margeCommerciale, -200);
      assert.equal(liste.derive.budgetGlobalVendu, 1000);
      assert.deepEqual(liste.sain.metrics.alertes, []);
      const fiche = await request(app).get(`/api/chantiers/${derive.id}`).set(authConducteur);
      assert.equal(fiche.status, 200, JSON.stringify(fiche.body));
      assert.equal(fiche.body.metrics.margeCommerciale, -200);
      assert.deepEqual(fiche.body.metrics.alertes, [...DERIVES, 'EN_PERTE']);
    });

    test('la société peut retirer la rentabilité au conducteur : il garde les dépassements, sans le signe de la marge', async () => {
      const retrait = await request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: true, rentabiliteConducteur: false });
      assert.equal(retrait.status, 200, JSON.stringify(retrait.body));
      try {
        const liste = await lire('/api/chantiers', authConducteur);
        assert.deepEqual(liste.derive.metrics.alertes, DERIVES);
        assert.equal(liste.derive.metrics.margeCommerciale, null);
        assert.equal(liste.derive.budgetGlobalVendu, null);
        const fiche = await request(app).get(`/api/chantiers/${derive.id}`).set(authConducteur);
        assert.equal(fiche.status, 200, JSON.stringify(fiche.body));
        assert.deepEqual(fiche.body.metrics.alertes, DERIVES);
        assert.equal(fiche.body.metrics.margeCommerciale, null);
        assert.equal(fiche.body.budgetGlobalVendu, null);
        assert.equal(fiche.body.facturation, undefined, 'la facturation suit la marge');
        // Les écritures qu'il garde ne lui renvoient pas le vendu, et il ne peut pas l'écraser.
        const renommage = await request(app).patch(`/api/chantiers/${derive.id}`).set(authConducteur).send({ nom: 'TEST Rentabilité dérive' });
        assert.equal(renommage.status, 200, JSON.stringify(renommage.body));
        assert.equal(renommage.body.budgetGlobalVendu, null);
        const ecrasement = await request(app).patch(`/api/chantiers/${derive.id}`).set(authConducteur).send({ budgetGlobalVendu: 1 });
        assert.equal(ecrasement.status, 403, JSON.stringify(ecrasement.body));
        const commercial = await prisma.user.findFirst({ where: { role: 'COMMERCIAL', actif: true }, select: { id: true } });
        const affectation = await request(app).patch(`/api/chantiers/${derive.id}/commercial`).set(authConducteur).send({ commercialId: commercial?.id ?? null });
        assert.equal(affectation.status, 200, JSON.stringify(affectation.body));
        assert.equal(affectation.body.budgetGlobalVendu, null);
        const aClore = await prisma.chantier.create({ data: { nom: 'TEST Rentabilité clôture', client: 'TEST Client rentabilité', dateDebut: new Date(), budgetGlobalVendu: 1000, responsableId: derive.responsableId } });
        const cloture = await request(app).patch(`/api/chantiers/${aClore.id}/statut`).set(authConducteur).send({ statut: 'TERMINE' });
        assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
        assert.equal(cloture.body.budgetGlobalVendu, null);
        // L'administrateur, lui, la voit toujours, et le vendu est intact.
        assert.deepEqual((await lire('/api/chantiers', auth)).derive.metrics.alertes, [...DERIVES, 'EN_PERTE']);
        assert.equal(Number((await prisma.chantier.findUnique({ where: { id: derive.id } })).budgetGlobalVendu), 1000);
        const vueAdmin = await request(app).patch(`/api/chantiers/${derive.id}`).set(auth).send({ nom: 'TEST Rentabilité dérive' });
        assert.equal(Number(vueAdmin.body.budgetGlobalVendu), 1000, 'l’administrateur reçoit toujours le vendu');
        // L'administrateur, lui, corrige toujours le vendu.
        const correctionAdmin = await request(app).patch(`/api/chantiers/${derive.id}`).set(auth).send({ budgetGlobalVendu: 1500 });
        assert.equal(correctionAdmin.status, 200, JSON.stringify(correctionAdmin.body));
        assert.equal(Number((await prisma.chantier.findUnique({ where: { id: derive.id } })).budgetGlobalVendu), 1500);
      } finally {
        // Remise en état directe : un échec ci-dessus ne doit pas fausser les tests suivants.
        await prisma.chantier.update({ where: { id: derive.id }, data: { budgetGlobalVendu: 1000 } });
        const retour = await request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: true, rentabiliteConducteur: true });
        assert.equal(retour.status, 200, JSON.stringify(retour.body));
      }
    });

    test('destinataire, le conducteur corrige le vendu de son chantier', async () => {
      try {
        // Une vraie valeur nouvelle : une écriture ignorée en silence ne passerait pas.
        const correction = await request(app).patch(`/api/chantiers/${derive.id}`).set(authConducteur).send({ budgetGlobalVendu: 1200 });
        assert.equal(correction.status, 200, JSON.stringify(correction.body));
        assert.equal(Number(correction.body.budgetGlobalVendu), 1200);
        assert.equal(Number((await prisma.chantier.findUnique({ where: { id: derive.id } })).budgetGlobalVendu), 1200);
      } finally {
        await prisma.chantier.update({ where: { id: derive.id }, data: { budgetGlobalVendu: 1000 } });
      }
    });

    test('une clé sans finances:read ne déduit pas la perte de l’alerte', async () => {
      const sansFinances = await lire('/api/v1/chantiers', { Authorization: `Bearer ${cleSansFinances}` });
      assert.deepEqual(sansFinances.derive.metrics.alertes, DERIVES);
      const avecFinances = await lire('/api/v1/chantiers', { Authorization: `Bearer ${cleAvecFinances}` });
      assert.deepEqual(avecFinances.derive.metrics.alertes, [...DERIVES, 'EN_PERTE']);
    });

    test('marge commerciale désactivée : plus d’alerte de perte, même pour un administrateur', async () => {
      const desactivation = await request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: false });
      assert.equal(desactivation.status, 200, JSON.stringify(desactivation.body));
      try {
        const liste = await lire('/api/chantiers', auth);
        assert.deepEqual(liste.derive.metrics.alertes, DERIVES);
        assert.equal(liste.derive.metrics.margeCommerciale, null);
      } finally {
        const reactivation = await request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: true });
        assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      }
    });
  });

  // Le calcul lui-même est couvert par les tests unitaires (validation.test.mjs). Ici : les
  // références société lues en base, les paramètres réglables, la contrainte SQL et la
  // visibilité de l'estimation selon le rôle ou la clé.
  describe('Marge estimée et alertes de suivi : paramètres, références société et visibilité', () => {
    let auth = {};
    let authConducteur = {};
    let cleSansFinances = '';
    let ancienParametres;
    let sansHeure;
    let endormi;
    let ilYa30Jours = '';
    const reglages = (corps) => request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: true, ...corps });

    before(async () => {
      const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(login.status, 200);
      auth = { Authorization: `Bearer ${login.body.token}` };
      ancienParametres = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      const initial = await reglages({ seuilMargeFaible: 15, joursSansSaisie: 14, rentabiliteConducteur: true });
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      const conducteur = await prisma.user.create({ data: { email: 'suivi.conducteur@iris.test', name: 'TEST Conducteur suivi', role: 'CONDUCTEUR_TRAVAUX' } });
      authConducteur = { Authorization: `Bearer ${jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET)}` };
      const societe = await prisma.companySettings.findUnique({ where: { id: 'singleton' } });
      const aujourdhui = jourCivilEntreprise(new Date(), societe?.fuseauHoraire || 'Europe/Paris');
      ilYa30Jours = new Date(Date.parse(`${aujourdhui}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
      const categorie = await prisma.categorie.create({ data: { nom: 'TEST Suivi catégorie' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: 'TEST Suivi fournisseur' } });
      const vente = { client: 'TEST Client suivi', budgetMaterielVendu: 500, budgetMainOeuvreVendu: 1500, heuresVendues: 20, responsableId: conducteur.id };
      sansHeure = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Suivi sans heure', dateDebut: new Date(), budgetGlobalVendu: 2000 } });
      endormi = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Suivi endormi', dateDebut: new Date(Date.now() - 60 * 86_400_000), budgetGlobalVendu: 5000 } });
      const achat = await request(app).post('/api/achats').set(auth)
        .send({ chantierId: endormi.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: ilYa30Jours, description: 'TEST achat ancien', montantHT: 50 });
      assert.equal(achat.status, 200, JSON.stringify(achat.body));
      const cle = await request(app).post('/api/admin/api-keys').set(auth).send({ nom: 'TEST agent suivi', scopes: ['chantiers:read'] });
      assert.equal(cle.status, 201, JSON.stringify(cle.body));
      cleSansFinances = cle.body.apiKey;
    });

    after(async () => {
      if (ancienParametres) await prisma.parametres.update({ where: { id: 'singleton' }, data: {
        margeCommercialeActive: ancienParametres.margeCommercialeActive,
        seuilMargeFaible: ancienParametres.seuilMargeFaible,
        joursSansSaisie: ancienParametres.joursSansSaisie,
        rentabiliteConducteur: ancienParametres.rentabiliteConducteur,
      } });
    });

    const lire = async (chemin, entetes) => {
      const res = await request(app).get(chemin).set(entetes);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const trouver = id => {
        const chantier = res.body.find(c => c.id === id);
        assert.ok(chantier, `chantier ${id} absent de ${chemin}`);
        return chantier;
      };
      return { sansHeure: trouver(sansHeure.id), endormi: trouver(endormi.id) };
    };

    test('les réglages refusent les valeurs hors bornes et acceptent le vide (délai désactivé, seuil retiré)', async () => {
      for (const corps of [{ seuilMargeFaible: 101 }, { seuilMargeFaible: -1 }, { seuilMargeFaible: 'abc' }, { joursSansSaisie: 0 }, { joursSansSaisie: 366 }, { joursSansSaisie: 2.5 }, { joursSansSaisie: '7j' }]) {
        const refus = await reglages(corps);
        assert.equal(refus.status, 400, `${JSON.stringify(corps)} → ${refus.status}`);
      }
      const inchange = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      assert.equal(Number(inchange.seuilMargeFaible), 15);
      assert.equal(inchange.joursSansSaisie, 14);
      const vide = await reglages({ seuilMargeFaible: '', joursSansSaisie: null });
      assert.equal(vide.status, 200, JSON.stringify(vide.body));
      assert.equal(vide.body.seuilMargeFaible, null);
      assert.equal(vide.body.joursSansSaisie, null);
      const decimal = await reglages({ seuilMargeFaible: '12,5', joursSansSaisie: '21' });
      assert.equal(decimal.status, 200, JSON.stringify(decimal.body));
      assert.equal(decimal.body.seuilMargeFaible, 12.5);
      assert.equal(decimal.body.joursSansSaisie, 21);
      assert.equal((await reglages({ seuilMargeFaible: 15, joursSansSaisie: 14 })).status, 200);
    });

    test('la base refuse un réglage hors bornes écrit sans passer par l’API', async () => {
      await assert.rejects(prisma.parametres.update({ where: { id: 'singleton' }, data: { seuilMargeFaible: 150 } }));
      await assert.rejects(prisma.parametres.update({ where: { id: 'singleton' }, data: { joursSansSaisie: 0 } }));
    });

    test('coût horaire et ratio matériel viennent des saisies réelles de la société', async () => {
      // Références recalculées ici indépendamment de la requête SQL du serveur.
      const pointages = await prisma.pointageHeure.findMany({ where: { archivedAt: null, chantier: { statut: { not: 'ANNULE' } } } });
      const heures = pointages.reduce((s, p) => s + Number(p.nbrHeures), 0);
      const coutHoraire = heures > 0 ? pointages.reduce((s, p) => s + Number(p.nbrHeures) * Number(p.tauxHoraireApplique), 0) / heures : null;
      const termines = await prisma.chantier.findMany({ where: { statut: 'TERMINE', budgetMaterielVendu: { gt: 0 } }, include: { achats: { where: { archivedAt: null } } } });
      const vendu = termines.reduce((s, c) => s + Number(c.budgetMaterielVendu), 0);
      const ratio = vendu > 0 ? termines.reduce((s, c) => s + c.achats.reduce((t, a) => t + Number(a.montantHT), 0), 0) / vendu : null;

      const { sansHeure: vue } = await lire('/api/chantiers', auth);
      const e = vue.metrics.estimation;
      assert.equal(e.sourceCoutHoraire, coutHoraire === null ? 'VENDU' : 'SOCIETE');
      assert.equal(e.sourceMateriel, ratio === null ? 'VENDU' : 'HISTORIQUE');
      if (coutHoraire !== null) assert.ok(Math.abs(e.coutHoraireReference - coutHoraire) < 1e-6, `${e.coutHoraireReference} ≠ ${coutHoraire}`);
      assert.ok(Math.abs(e.ratioMateriel - (ratio ?? 1)) < 1e-6, `${e.ratioMateriel} ≠ ${ratio ?? 1}`);
      const attendu = 2000 - (coutHoraire === null ? 1500 : 20 * coutHoraire) - 500 * (ratio ?? 1);
      assert.ok(Math.abs(vue.metrics.margeEstimee - attendu) < 1e-6, `${vue.metrics.margeEstimee} ≠ ${attendu}`);
    });

    test('un chantier sans saisie depuis le délai réglé est signalé à tous ceux qui le voient', async () => {
      const admin = await lire('/api/chantiers', auth);
      assert.equal(admin.endormi.metrics.derniereSaisie, ilYa30Jours);
      assert.equal(admin.endormi.metrics.joursSansSaisie, 30);
      assert.ok(admin.endormi.metrics.alertes.includes('SANS_SAISIE'));
      assert.ok(!admin.sansHeure.metrics.alertes.includes('SANS_SAISIE'), 'démarré aujourd’hui');
      const conducteur = await lire('/api/chantiers', authConducteur);
      assert.ok(conducteur.endormi.metrics.alertes.includes('SANS_SAISIE'));
      const fiche = await request(app).get(`/api/chantiers/${endormi.id}`).set(authConducteur);
      assert.equal(fiche.status, 200, JSON.stringify(fiche.body));
      assert.ok(fiche.body.metrics.alertes.includes('SANS_SAISIE'), 'sur la fiche du conducteur aussi');
      try {
        // Ce n'est pas une donnée de rentabilité : la retirer au conducteur ne la masque pas.
        assert.equal((await reglages({ rentabiliteConducteur: false })).status, 200);
        assert.ok((await lire('/api/chantiers', authConducteur)).endormi.metrics.alertes.includes('SANS_SAISIE'));
        assert.equal((await reglages({ rentabiliteConducteur: true })).status, 200);
        assert.equal((await reglages({ joursSansSaisie: 31 })).status, 200);
        assert.ok(!(await lire('/api/chantiers', auth)).endormi.metrics.alertes.includes('SANS_SAISIE'));
        assert.equal((await reglages({ joursSansSaisie: '' })).status, 200);
        const desactive = await lire('/api/chantiers', auth);
        assert.ok(!desactive.endormi.metrics.alertes.includes('SANS_SAISIE'));
        assert.equal(desactive.endormi.metrics.joursSansSaisie, 30);
      } finally {
        assert.equal((await reglages({ joursSansSaisie: 14 })).status, 200);
      }
    });

    test('la marge estimée et la marge faible ne sortent que pour les destinataires de la rentabilité', async () => {
      const sansRentabilite = async (qui, entetes, chemin) => {
        const vue = await lire(chemin, entetes);
        assert.ok(!vue.sansHeure.metrics.alertes.includes('MARGE_FAIBLE'), qui);
        assert.equal(vue.sansHeure.metrics.margeEstimee, null, qui);
        assert.equal(vue.sansHeure.metrics.estimation, null, qui);
      };
      try {
        // Seuil à 100 % : toute marge estimée positive est « faible », l'alerte est certaine.
        assert.equal((await reglages({ seuilMargeFaible: 100 })).status, 200);
        const admin = await lire('/api/chantiers', auth);
        assert.ok(admin.sansHeure.metrics.alertes.includes('MARGE_FAIBLE'));
        assert.equal(typeof admin.sansHeure.metrics.margeEstimee, 'number');
        // Le conducteur du chantier en est destinataire par défaut, sur la liste comme sur sa fiche.
        const conducteur = await lire('/api/chantiers', authConducteur);
        assert.ok(conducteur.sansHeure.metrics.alertes.includes('MARGE_FAIBLE'));
        assert.equal(conducteur.sansHeure.metrics.margeEstimee, admin.sansHeure.metrics.margeEstimee);
        const fiche = await request(app).get(`/api/chantiers/${sansHeure.id}`).set(authConducteur);
        assert.equal(fiche.status, 200, JSON.stringify(fiche.body));
        assert.ok(fiche.body.metrics.alertes.includes('MARGE_FAIBLE'));
        // La marge estimée, sans son coût total : le coût de main-d'œuvre est réservé à l'administration.
        assert.equal(typeof fiche.body.metrics.margeEstimee, 'number');
        assert.equal(fiche.body.metrics.estimation.coutEstime, null);
        await sansRentabilite('clé sans finances:read', { Authorization: `Bearer ${cleSansFinances}` }, '/api/v1/chantiers');
        // Retirée au conducteur : ni sur la liste, ni sur la fiche.
        assert.equal((await reglages({ rentabiliteConducteur: false })).status, 200);
        await sansRentabilite('conducteur retiré', authConducteur, '/api/chantiers');
        const ficheRetiree = await request(app).get(`/api/chantiers/${sansHeure.id}`).set(authConducteur);
        assert.equal(ficheRetiree.status, 200, JSON.stringify(ficheRetiree.body));
        assert.ok(!ficheRetiree.body.metrics.alertes.includes('MARGE_FAIBLE'));
        assert.equal(ficheRetiree.body.metrics.estimation, null);
      } finally {
        assert.equal((await reglages({ seuilMargeFaible: 15, rentabiliteConducteur: true })).status, 200);
      }
    });
  });

  // Organisation testée : Régional → Secteur → Conducteur, chantier confié au conducteur ;
  // un autre responsable dirige une autre branche ; un directeur pilote toute la société.
  describe('Rentabilité selon la hiérarchie, profil Directeur et rattachements', () => {
    let auth = {};
    let superId = '';
    let ancienParametres;
    const comptes = {};
    const jetons = {};
    let chantier;
    let chantierAutreBranche;
    let chantierDuDirecteur;
    let saisie = {};
    const entete = (qui) => ({ Authorization: `Bearer ${jetons[qui]}` });
    const reglages = (corps) => request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: true, ...corps });
    const rattacher = (qui, responsableId, entetes = auth) => request(app).patch(`/api/users/${comptes[qui].id}/responsable-hierarchique`).set(entetes)
      .send({ responsableHierarchiqueId: responsableId });
    const vue = async (qui, cible = chantier) => {
      const liste = await request(app).get('/api/chantiers').set(entete(qui));
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      const fiche = await request(app).get(`/api/chantiers/${cible.id}`).set(entete(qui));
      return { liste: liste.body.find((c) => c.id === cible.id), fiche };
    };
    const voitLaPerte = async (qui, attendu) => {
      const { liste, fiche } = await vue(qui);
      assert.ok(liste, `${qui} doit voir le chantier dans sa liste`);
      assert.equal(fiche.status, 200, `${qui} : ${JSON.stringify(fiche.body)}`);
      if (attendu) {
        assert.equal(liste.metrics.margeCommerciale, -200, qui);
        assert.ok(liste.metrics.alertes.includes('EN_PERTE'), qui);
        assert.equal(liste.budgetGlobalVendu, 1000, qui);
        assert.equal(fiche.body.metrics.margeCommerciale, -200, qui);
        assert.equal(typeof fiche.body.metrics.margeEstimee, 'number', qui);
        assert.ok(fiche.body.metrics.estimation, qui);
      } else {
        assert.equal(liste.metrics.margeCommerciale, null, qui);
        assert.ok(!liste.metrics.alertes.includes('EN_PERTE'), qui);
        assert.equal(liste.budgetGlobalVendu, null, qui);
        assert.equal(fiche.body.metrics.margeCommerciale, null, qui);
        assert.equal(fiche.body.metrics.estimation, null, qui);
        assert.equal(fiche.body.budgetGlobalVendu, null, qui);
      }
      // Les dépassements ne sont pas une donnée de rentabilité : chacun les voit.
      assert.ok(liste.metrics.alertes.includes('MATERIEL_DEPASSE'), qui);
    };

    before(async () => {
      const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(login.status, 200);
      auth = { Authorization: `Bearer ${login.body.token}` };
      superId = login.body.user.id;
      ancienParametres = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      assert.equal((await reglages({ rentabiliteConducteur: true, rentabiliteHierarchie: true, rentabiliteDirecteurs: true })).status, 200);
      const creer = async (qui, role, actif = true) => {
        comptes[qui] = await prisma.user.create({ data: { email: `chaine.${qui}@iris.test`, name: `TEST Chaîne ${qui}`, role, actif } });
        jetons[qui] = jwt.sign({ id: comptes[qui].id }, process.env.JWT_SECRET);
      };
      await creer('conducteur', 'CONDUCTEUR_TRAVAUX');
      await creer('secteur', 'RESPONSABLE');
      await creer('regional', 'RESPONSABLE');
      await creer('autre.responsable', 'RESPONSABLE');
      await creer('autre.conducteur', 'CONDUCTEUR_TRAVAUX');
      await creer('admin', 'ADMIN');
      await creer('inactif', 'RESPONSABLE', false);
      // Le directeur est créé par l'API : le type de compte fait partie des rôles autorisés.
      const directeur = await request(app).post('/api/users').set(auth).send({ email: 'chaine.directeur@iris.test', name: 'TEST Chaîne directeur', role: 'DIRECTEUR' });
      assert.equal(directeur.status, 201, JSON.stringify(directeur.body));
      assert.equal(directeur.body.role, 'DIRECTEUR');
      comptes.directeur = directeur.body;
      jetons.directeur = jwt.sign({ id: directeur.body.id }, process.env.JWT_SECRET);
      // Vendu 1 000 € dont 300 € de matériel ; 1 200 € d'achats : chantier en perte de 200 €.
      const vente = { client: 'TEST Client chaîne', dateDebut: new Date(), budgetGlobalVendu: 1000, budgetMaterielVendu: 300, budgetMainOeuvreVendu: 700, heuresVendues: 10 };
      chantier = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Chaîne chantier', responsableId: comptes.conducteur.id } });
      chantierAutreBranche = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Chaîne autre branche', responsableId: comptes['autre.conducteur'].id } });
      // Chantier resté au nom d'un compte devenu directeur (conducteur promu, par exemple).
      chantierDuDirecteur = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Chaîne ancien chantier du directeur', responsableId: comptes.directeur.id } });
      const categorie = await prisma.categorie.create({ data: { nom: 'TEST Chaîne catégorie' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: 'TEST Chaîne fournisseur' } });
      saisie = { categorieId: categorie.id, fournisseurId: fournisseur.id, date: jourCivilEntreprise(new Date()), description: 'TEST achat chaîne' };
      const achat = await request(app).post('/api/achats').set(auth).send({ ...saisie, chantierId: chantier.id, montantHT: 1200 });
      assert.equal(achat.status, 200, JSON.stringify(achat.body));
    });

    after(async () => {
      if (ancienParametres) await prisma.parametres.update({ where: { id: 'singleton' }, data: {
        margeCommercialeActive: ancienParametres.margeCommercialeActive,
        rentabiliteConducteur: ancienParametres.rentabiliteConducteur,
        rentabiliteHierarchie: ancienParametres.rentabiliteHierarchie,
        rentabiliteDirecteurs: ancienParametres.rentabiliteDirecteurs,
      } });
    });

    test('les rattachements se règlent par l’administration et refusent soi-même, l’inconnu, l’inactif et la boucle', async () => {
      const direct = await rattacher('conducteur', comptes.secteur.id);
      assert.equal(direct.status, 200, JSON.stringify(direct.body));
      assert.deepEqual(direct.body.responsableHierarchique, { id: comptes.secteur.id, name: 'TEST Chaîne secteur' });
      assert.equal((await rattacher('secteur', comptes.regional.id)).status, 200);
      const refus = [
        ['soi-même', await rattacher('regional', comptes.regional.id)],
        ['boucle', await rattacher('regional', comptes.conducteur.id)],
        ['boucle directe', await rattacher('secteur', comptes.conducteur.id)],
        ['inconnu', await rattacher('regional', '00000000-0000-0000-0000-000000000000')],
        ['inactif', await rattacher('regional', comptes.inactif.id)],
        ['type invalide', await rattacher('regional', 42)],
        // Un tableau serait lu comme l'identifiant qu'il contient sans le contrôle de type.
        ['tableau', await rattacher('autre.conducteur', [comptes.secteur.id])],
      ];
      for (const [cas, reponse] of refus) assert.equal(reponse.status, 400, `${cas} → ${reponse.status} ${JSON.stringify(reponse.body)}`);
      assert.match(refus[1][1].body.error, /boucle/);
      // Réservé à l'administration, et un simple administrateur ne rattache personne à un
      // super administrateur, qu'il ne voit pas.
      assert.equal((await rattacher('autre.conducteur', comptes.regional.id, entete('regional'))).status, 403);
      assert.equal((await rattacher('autre.conducteur', comptes.regional.id, entete('directeur'))).status, 403);
      assert.equal((await rattacher('autre.conducteur', superId, entete('admin'))).status, 400);
      assert.equal((await request(app).patch(`/api/users/${superId}/responsable-hierarchique`).set(entete('admin')).send({ responsableHierarchiqueId: comptes.admin.id })).status, 403);
      // La liste des comptes montre le rattachement ; la base refuse l'auto-rattachement écrit hors API.
      const utilisateurs = await request(app).get('/api/users').set(auth);
      assert.deepEqual(utilisateurs.body.find((u) => u.id === comptes.secteur.id).responsableHierarchique, { id: comptes.regional.id, name: 'TEST Chaîne regional' });
      assert.equal(utilisateurs.body.find((u) => u.id === comptes.regional.id).responsableHierarchique, null);
      await assert.rejects(prisma.user.update({ where: { id: comptes.regional.id }, data: { responsableHierarchiqueId: comptes.regional.id } }));
      // Un super administrateur responsable n'apparaît pas à un simple administrateur.
      assert.equal((await rattacher('autre.conducteur', superId)).status, 200);
      try {
        const vuParAdmin = await request(app).get('/api/users').set(entete('admin'));
        assert.equal(vuParAdmin.body.find((u) => u.id === comptes['autre.conducteur'].id).responsableHierarchique, null);
        assert.equal(JSON.stringify(vuParAdmin.body).includes(superId), false);
        const vuParSuper = await request(app).get('/api/users').set(auth);
        assert.equal(vuParSuper.body.find((u) => u.id === comptes['autre.conducteur'].id).responsableHierarchique.id, superId);
      } finally {
        assert.equal((await rattacher('autre.conducteur', null)).status, 200);
      }
      const chaine = await prisma.user.findMany({ where: { id: { in: [comptes.conducteur.id, comptes.secteur.id, comptes.regional.id] } }, select: { id: true, responsableHierarchiqueId: true } });
      assert.deepEqual(Object.fromEntries(chaine.map((u) => [u.id, u.responsableHierarchiqueId])), {
        [comptes.conducteur.id]: comptes.secteur.id, [comptes.secteur.id]: comptes.regional.id, [comptes.regional.id]: null,
      });
    });

    test('toute la chaîne hiérarchique voit le chantier et sa rentabilité ; une autre branche n’en voit rien', async () => {
      await voitLaPerte('conducteur', true);
      await voitLaPerte('secteur', true);
      await voitLaPerte('regional', true);
      const autre = await vue('autre.responsable');
      assert.equal(autre.liste, undefined);
      assert.equal(autre.fiche.status, 404);
      // Le responsable régional voit le conducteur dans ses statistiques, comme son N+1.
      const statistiques = await request(app).get('/api/stats/conducteurs').set(entete('regional'));
      assert.equal(statistiques.status, 200, JSON.stringify(statistiques.body));
      assert.ok(statistiques.body.some((ligne) => ligne.id === comptes.conducteur.id));
      assert.ok(!statistiques.body.some((ligne) => ligne.id === comptes['autre.conducteur'].id));
    });

    test('la branche suit chaque rattachement sans reconnexion', async () => {
      try {
        assert.equal((await rattacher('secteur', null)).status, 200);
        const detache = await vue('regional');
        assert.equal(detache.liste, undefined);
        assert.equal(detache.fiche.status, 404);
        await voitLaPerte('secteur', true);
      } finally {
        assert.equal((await rattacher('secteur', comptes.regional.id)).status, 200);
      }
      await voitLaPerte('regional', true);
    });

    test('le directeur voit tous les chantiers et leur rentabilité, sans rien administrer ni saisir (hors clôture)', async () => {
      await voitLaPerte('directeur', true);
      const autreBranche = await vue('directeur', chantierAutreBranche);
      assert.ok(autreBranche.liste, 'tous les chantiers, hors de toute hiérarchie');
      assert.equal(autreBranche.fiche.status, 200);
      const moi = await request(app).get('/api/me').set(entete('directeur'));
      assert.deepEqual(moi.body.permissions, ['chantiers:read']);
      const refus = [
        ['saisie d’un achat', () => request(app).post('/api/achats').set(entete('directeur')).send({ chantierId: chantier.id, montantHT: 1 })],
        ['modification du chantier', () => request(app).patch(`/api/chantiers/${chantier.id}`).set(entete('directeur')).send({ nom: 'TEST piraté' })],
        ['réglages', () => request(app).put('/api/parametres').set(entete('directeur')).send({ rentabiliteDirecteurs: true })],
        ['comptes', () => request(app).get('/api/users').set(entete('directeur'))],
        ['référentiel', () => request(app).post('/api/categories').set(entete('directeur')).send({ nom: 'TEST directeur' })],
        ['planning', () => request(app).get('/api/planning/events').set(entete('directeur'))],
        ['SAV', () => request(app).get('/api/interventions').set(entete('directeur'))],
        ['statistiques Travaux', () => request(app).get('/api/stats/conducteurs').set(entete('directeur'))],
        ['commercial d’un chantier resté à son nom', () => request(app).patch(`/api/chantiers/${chantierDuDirecteur.id}/commercial`).set(entete('directeur')).send({ commercialId: null })],
      ];
      // Appels différés : supertest ouvre un serveur dès la création de la requête, et un
      // appel jamais attendu après un premier échec empêcherait la suite de se terminer.
      for (const [cas, appel] of refus) {
        const reponse = await appel();
        assert.equal(reponse.status, 403, `${cas} → ${reponse.status} ${JSON.stringify(reponse.body)}`);
      }
      assert.equal((await prisma.chantier.findUnique({ where: { id: chantier.id } })).nom, 'TEST Chaîne chantier');
    });

    test('l’affaire rattachée à une intervention ne montre jamais son montant vendu', async () => {
      const client = await request(app).post('/api/clients').set(auth).send({ raisonSociale: 'TEST Client chaîne' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      // Le rattachement passe par la fiche client du chantier : on la lie d'abord.
      await prisma.chantier.update({ where: { id: chantier.id }, data: { clientId: client.body.id } });
      const dossier = await request(app).post('/api/interventions').set(auth).send({ clientId: client.body.id, chantierId: chantier.id, titre: 'TEST Intervention sur chantier de la chaîne' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      assert.equal(dossier.body.chantier.nom, 'TEST Chaîne chantier');
      assert.equal('budgetGlobalVendu' in dossier.body.chantier, false);
      for (const qui of ['conducteur', 'regional']) {
        const liste = await request(app).get('/api/interventions').set(entete(qui));
        assert.equal(liste.status, 200, JSON.stringify(liste.body));
        const vu = liste.body.find((item) => item.id === dossier.body.id);
        assert.ok(vu, `${qui} voit l’intervention de son périmètre`);
        assert.deepEqual(Object.keys(vu.chantier).sort(), ['adresse', 'client', 'id', 'nom', 'numeroDevis', 'statut'], qui);
      }
    });

    test('chaque catégorie de destinataires se retire seule, sans réduire le périmètre de lecture', async () => {
      for (const corps of [{ rentabiliteHierarchie: 'false' }, { rentabiliteDirecteurs: 1 }, { rentabiliteConducteur: null }]) {
        const refus = await reglages(corps);
        assert.equal(refus.status, 400, `${JSON.stringify(corps)} → ${refus.status}`);
      }
      const inchange = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      assert.deepEqual([inchange.rentabiliteConducteur, inchange.rentabiliteHierarchie, inchange.rentabiliteDirecteurs], [true, true, true]);
      try {
        const sansChaine = await reglages({ rentabiliteHierarchie: false });
        assert.equal(sansChaine.status, 200, JSON.stringify(sansChaine.body));
        assert.equal(sansChaine.body.rentabiliteHierarchie, false);
        await voitLaPerte('secteur', false);
        await voitLaPerte('regional', false);
        await voitLaPerte('conducteur', true);
        await voitLaPerte('directeur', true);
        // Les statistiques Travaux de la branche ne rendent pas ce que la liste masque.
        const statistiques = await request(app).get('/api/stats/conducteurs').set(entete('regional'));
        assert.equal(statistiques.status, 200, JSON.stringify(statistiques.body));
        const ligne = statistiques.body.find((l) => l.id === comptes.conducteur.id);
        assert.deepEqual([ligne.caTotal, ligne.margeTotal, ligne.margePct], [null, null, null]);
        assert.equal(ligne.nbChantiers, 1, 'le suivi opérationnel reste');
        const statsAdmin = await request(app).get('/api/stats/conducteurs').set(auth);
        assert.equal(statsAdmin.body.find((l) => l.id === comptes.conducteur.id).caTotal, 1000);
        assert.equal((await reglages({ rentabiliteHierarchie: true, rentabiliteDirecteurs: false })).status, 200);
        await voitLaPerte('directeur', false);
        await voitLaPerte('regional', true);
        // Marge commerciale désactivée : comme sur la liste, la branche garde le vendu (CA) mais
        // plus la marge ; l'administration, elle, garde l'un et l'autre.
        assert.equal((await request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: false })).status, 200);
        const sansMarge = (await request(app).get('/api/stats/conducteurs').set(entete('regional'))).body.find((l) => l.id === comptes.conducteur.id);
        assert.deepEqual([sansMarge.caTotal, sansMarge.margeTotal, sansMarge.margePct], [1000, null, null]);
        const listeSansMarge = (await request(app).get('/api/chantiers').set(entete('regional'))).body.find((c) => c.id === chantier.id);
        assert.deepEqual([listeSansMarge.budgetGlobalVendu, listeSansMarge.metrics.margeCommerciale], [1000, null], 'même règle que la liste');
        const adminSansMarge = (await request(app).get('/api/stats/conducteurs').set(auth)).body.find((l) => l.id === comptes.conducteur.id);
        assert.deepEqual([adminSansMarge.caTotal, adminSansMarge.margeTotal], [1000, -200]);
        assert.equal((await request(app).put('/api/parametres').set(auth).send({ margeCommercialeActive: 'false' })).status, 400, 'un vrai booléen est exigé');
        // Tout retiré : seuls les administrateurs la voient encore.
        assert.equal((await reglages({ rentabiliteConducteur: false, rentabiliteHierarchie: false, rentabiliteDirecteurs: false })).status, 200);
        for (const qui of ['conducteur', 'secteur', 'regional', 'directeur']) await voitLaPerte(qui, false);
        await voitLaPerte('admin', true);
        // Un appel qui ne règle que les destinataires laisse la marge commerciale active.
        const partiel = await request(app).put('/api/parametres').set(auth).send({ rentabiliteDirecteurs: true });
        assert.equal(partiel.status, 200, JSON.stringify(partiel.body));
        assert.equal(partiel.body.margeCommercialeActive, true);
      } finally {
        assert.equal((await reglages({ rentabiliteConducteur: true, rentabiliteHierarchie: true, rentabiliteDirecteurs: true })).status, 200);
      }
    });

    test('un commercial ou un technicien désigné responsable d’un chantier n’en reçoit jamais la rentabilité', async () => {
      for (const [qui, role] of [['commercial', 'COMMERCIAL'], ['technicien', 'TECHNICIEN']]) {
        const compte = await prisma.user.create({ data: { email: `chaine.${qui}@iris.test`, name: `TEST Chaîne ${qui}`, role } });
        const sien = await prisma.chantier.create({ data: { nom: `TEST Chaîne chantier du ${qui}`, client: 'TEST Client chaîne', dateDebut: new Date(), budgetGlobalVendu: 1000, budgetMaterielVendu: 300, responsableId: compte.id } });
        const fiche = await request(app).get(`/api/chantiers/${sien.id}`).set({ Authorization: `Bearer ${jwt.sign({ id: compte.id }, process.env.JWT_SECRET)}` });
        assert.equal(fiche.status, 200, `${qui} : ${JSON.stringify(fiche.body)}`);
        assert.equal(fiche.body.budgetGlobalVendu, null, qui);
        assert.equal(fiche.body.metrics.margeCommerciale, null, qui);
        assert.equal(fiche.body.metrics.estimation, null, qui);
      }
    });

    test('le journal d’une intervention ne restitue pas le montant vendu d’un ancien instantané', async () => {
      const dossier = await prisma.intervention.findFirst({ where: { chantierId: chantier.id }, select: { id: true } });
      assert.ok(dossier, 'intervention créée par le test précédent');
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' }, select: { id: true, name: true } });
      // Instantané au format antérieur : l'affaire entière, montant vendu compris.
      await prisma.journalSaisieChantier.create({ data: {
        chantierId: null, interventionId: dossier.id, cible: 'INTERVENTION', cibleId: dossier.id, action: 'CREATION',
        auteurId: auteur.id, auteurNom: auteur.name,
        avant: { id: dossier.id, chantier: { id: chantier.id, nom: 'TEST Chaîne chantier', budgetGlobalVendu: 1000, budgetMainOeuvreVendu: 700, responsableId: comptes.conducteur.id } },
        apres: { id: dossier.id, chantier: { id: chantier.id, nom: 'TEST Chaîne chantier', budgetGlobalVendu: 1000, budgetMaterielVendu: 300 } },
      } });
      const journal = await request(app).get(`/api/interventions/${dossier.id}/journal-saisies`).set(entete('regional'));
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.ok(journal.body.length > 0);
      // Liste blanche : l'affaire d'un instantané ne garde que son identification, ni vendu,
      // ni budgets par poste, ni responsable.
      const autorisees = ['adresse', 'client', 'id', 'nom', 'numeroDevis', 'statut'];
      for (const entree of journal.body) {
        for (const instantane of [entree.avant, entree.apres]) {
          if (!instantane?.chantier) continue;
          assert.deepEqual(Object.keys(instantane.chantier).filter((cle) => !autorisees.includes(cle)), [], JSON.stringify(instantane.chantier));
        }
      }
      assert.ok(journal.body.some((entree) => entree.avant?.chantier?.nom === 'TEST Chaîne chantier'), 'l’ancien « avant » est aussi projeté');
      assert.ok(journal.body.some((entree) => entree.apres?.chantier?.nom === 'TEST Chaîne chantier'), 'l’affaire reste identifiée');
    });

    test('deux rattachements croisés simultanés ne forment jamais de boucle', async () => {
      const [a, b] = [comptes['autre.responsable'], comptes.inactif];
      await prisma.user.update({ where: { id: b.id }, data: { actif: true } });
      try {
        for (let essai = 0; essai < 15; essai++) {
          await prisma.user.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { responsableHierarchiqueId: null } });
          const reponses = await Promise.all([rattacher('autre.responsable', b.id), rattacher('inactif', a.id)]);
          assert.deepEqual(reponses.map((r) => r.status).sort(), [200, 400], `essai ${essai} : ${reponses.map((r) => r.status)}`);
          const lus = await prisma.user.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, responsableHierarchiqueId: true } });
          assert.ok(!lus.every((u) => u.responsableHierarchiqueId), `essai ${essai} : boucle formée`);
        }
      } finally {
        await prisma.user.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { responsableHierarchiqueId: null } });
        await prisma.user.update({ where: { id: b.id }, data: { actif: false } });
      }
    });

    test('une boucle écrite directement en base ne bloque pas la lecture de la branche', async () => {
      const [a, b] = [comptes['autre.responsable'], comptes.inactif];
      await prisma.user.update({ where: { id: a.id }, data: { responsableHierarchiqueId: b.id } });
      await prisma.user.update({ where: { id: b.id }, data: { responsableHierarchiqueId: a.id } });
      try {
        const liste = await request(app).get('/api/chantiers').set(entete('autre.responsable'));
        assert.equal(liste.status, 200, JSON.stringify(liste.body));
        assert.equal(liste.body.some((c) => c.id === chantier.id), false);
      } finally {
        await prisma.user.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { responsableHierarchiqueId: null } });
      }
    });

    test('un responsable saisit sur toute sa branche, pas sur une autre', async () => {
      const regional = await request(app).post('/api/achats').set(entete('regional')).send({ ...saisie, chantierId: chantier.id, montantHT: 10 });
      assert.equal(regional.status, 200, JSON.stringify(regional.body));
      const autre = await request(app).post('/api/achats').set(entete('autre.responsable')).send({ ...saisie, chantierId: chantier.id, montantHT: 10 });
      assert.equal(autre.status, 404, JSON.stringify(autre.body));
    });
  });

  // Décisions de Nelson (13-10-2026) : le technicien ne voit ni budgets matériel et main-d'œuvre,
  // ni coûts (achats, main-d'œuvre, taux horaires), ni alertes de dépassement ; il garde le budget
  // d'heures. Il ne modifie pas l'affaire dont il est chargé, n'en réattribue pas le commercial et
  // ne la clôture pas : la clôture revient à son N+1 et au-dessus. Les autres profils voient les
  // montants dans leur périmètre.
  describe('Technicien : ni montants ni modification, clôture par son N+1', () => {
    let auth = {};
    let authTechnicien = {};
    let authComptable = {};
    let authDe = {};
    let technicien;
    let commercial;
    let chantierTechnicien;
    let chantierComptable;
    let chantierConducteur;
    let cle = '';

    before(async () => {
      const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(login.status, 200);
      auth = { Authorization: `Bearer ${login.body.token}` };
      const jeton = (compte) => ({ Authorization: `Bearer ${jwt.sign({ id: compte.id }, process.env.JWT_SECRET)}` });
      // Le technicien et le conducteur relèvent du même responsable ; un second responsable
      // reste hors de cette branche.
      const responsable = await prisma.user.create({ data: { email: 'budgets.responsable@iris.test', name: 'TEST Budgets responsable', role: 'RESPONSABLE' } });
      const autreResponsable = await prisma.user.create({ data: { email: 'budgets.autre.responsable@iris.test', name: 'TEST Budgets autre responsable', role: 'RESPONSABLE' } });
      technicien = await prisma.user.create({ data: { email: 'budgets.technicien@iris.test', name: 'TEST Budgets technicien', role: 'TECHNICIEN', responsableHierarchiqueId: responsable.id } });
      const comptable = await prisma.user.create({ data: { email: 'budgets.comptable@iris.test', name: 'TEST Budgets comptable', role: 'COMPTABLE' } });
      const conducteur = await prisma.user.create({ data: { email: 'budgets.conducteur@iris.test', name: 'TEST Budgets conducteur', role: 'CONDUCTEUR_TRAVAUX', responsableHierarchiqueId: responsable.id } });
      const directeur = await prisma.user.create({ data: { email: 'budgets.directeur@iris.test', name: 'TEST Budgets directeur', role: 'DIRECTEUR' } });
      commercial = await prisma.user.create({ data: { email: 'budgets.commercial@iris.test', name: 'TEST Budgets commercial', role: 'COMMERCIAL' } });
      authTechnicien = jeton(technicien);
      authComptable = jeton(comptable);
      authDe = { responsable: jeton(responsable), autreResponsable: jeton(autreResponsable), conducteur: jeton(conducteur), directeur: jeton(directeur), commercial: jeton(commercial) };
      // Vendu 1 000 € dont 300 € de matériel et 700 € de main-d'œuvre, 10 h vendues ; 450 €
      // d'achats (matériel dépassé). Sur le chantier du technicien, 500 € de main-d'œuvre vendue
      // et 12 h à 42 €/h pointées : heures et main-d'œuvre (504 €) dépassées aussi.
      const vente = { client: 'TEST Client budgets', dateDebut: new Date(), budgetGlobalVendu: 1000, budgetMaterielVendu: 300, budgetMainOeuvreVendu: 700, heuresVendues: 10 };
      chantierTechnicien = await prisma.chantier.create({ data: { ...vente, budgetMainOeuvreVendu: 500, nom: 'TEST Budgets chantier du technicien', responsableId: technicien.id } });
      chantierComptable = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Budgets chantier du comptable', responsableId: comptable.id, commercialId: commercial.id } });
      chantierConducteur = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Budgets chantier du conducteur', responsableId: conducteur.id } });
      const categorie = await prisma.categorie.create({ data: { nom: 'TEST Budgets catégorie' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: 'TEST Budgets fournisseur' } });
      const achats = [];
      for (const chantier of [chantierTechnicien, chantierComptable, chantierConducteur]) {
        const achat = await request(app).post('/api/achats').set(auth).send({ chantierId: chantier.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: jourCivilEntreprise(new Date()), description: 'TEST achat budgets', montantHT: 450 });
        assert.equal(achat.status, 200, JSON.stringify(achat.body));
        achats.push(achat.body);
      }
      // Une correction journalise l'achat entier avant et après : montant compris, même
      // quand seule la description change.
      const correction = await request(app).patch(`/api/achats/${achats[0].id}`).set(auth).send({ description: 'TEST achat budgets corrigé', motifCorrection: 'TEST correction du libellé' });
      assert.equal(correction.status, 200, JSON.stringify(correction.body));
      const intervenant = await prisma.intervenant.create({ data: { nom: 'TEST Budgets intervenant', role: 'TECHNICIEN', tauxHoraireCharge: 42 } });
      const heures = await request(app).post('/api/heures').set(auth).send({ chantierId: chantierTechnicien.id, intervenantId: intervenant.id, date: jourCivilEntreprise(new Date()), nbrHeures: 12 });
      assert.equal(heures.status, 200, JSON.stringify(heures.body));
      const creation = await request(app).post('/api/admin/api-keys').set(auth).send({ nom: 'TEST agent budgets', scopes: ['chantiers:read'] });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      cle = creation.body.apiKey;
    });

    // Aucune valeur monétaire du jeu de données (budgets, achats, taux, main-d'œuvre) ni les
    // pourcentages qui en découlent, où qu'elle se trouve dans la réponse.
    const MONTANTS = /":\s*(300|500|700|1000|450|42|504|150|100\.8)(\.0+)?[,}\]]/;
    const sansMontants = (corps, qui) => assert.doesNotMatch(JSON.stringify(corps), MONTANTS, `${qui} : un montant est exposé`);
    // Le responsable d'un chantier n'expose que son identité, jamais son type de compte.
    const responsableSansRole = (vue, qui) => assert.deepEqual(Object.keys(vue.responsable).sort(), ['email', 'id', 'name'], qui);
    const sansDepassement = (vue, qui) => {
      for (const alerte of ['MATERIEL_DEPASSE', 'MAIN_OEUVRE_DEPASSEE', 'HEURES_DEPASSEES']) assert.ok(!vue.metrics.alertes.includes(alerte), `${qui} : ${alerte}`);
    };

    test('le technicien ne voit ni budgets, ni coûts, ni taux, ni alertes de dépassement ; il garde ses heures', async () => {
      const liste = await request(app).get('/api/chantiers').set(authTechnicien);
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      const ligne = liste.body.find((c) => c.id === chantierTechnicien.id);
      sansMontants(ligne, 'liste du technicien');
      sansDepassement(ligne, 'liste du technicien');
      responsableSansRole(ligne, 'liste du technicien');
      const fiche = await request(app).get(`/api/chantiers/${chantierTechnicien.id}`).set(authTechnicien);
      assert.equal(fiche.status, 200, JSON.stringify(fiche.body));
      sansMontants(fiche.body, 'fiche du technicien');
      sansDepassement(fiche.body, 'fiche du technicien');
      responsableSansRole(fiche.body, 'fiche du technicien');
      for (const champ of ['budgetGlobalVendu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu']) assert.equal(fiche.body[champ], null, champ);
      for (const champ of ['materielReel', 'moReel', 'totalDepenses', 'pctMateriel', 'pctMainOeuvre']) assert.equal(fiche.body.metrics[champ], null, champ);
      assert.equal(fiche.body.achats[0].montantHT, undefined);
      assert.equal(fiche.body.pointages[0].tauxHoraireApplique, undefined);
      assert.equal(fiche.body.pointages[0].intervenant.tauxHoraireCharge, undefined);
      // Le budget d'heures et les heures réalisées restent visibles, sans montant.
      assert.deepEqual([fiche.body.heuresVendues, fiche.body.metrics.heuresRealisees], [10, 12]);
      assert.equal(fiche.body.peutCloturer, false);
    });

    test('ni ses journaux, ni son tableau de bord, ni la liste des intervenants ne portent de montant', async () => {
      const achats = await request(app).get('/api/achats').set(authTechnicien);
      assert.equal(achats.status, 200, JSON.stringify(achats.body));
      assert.ok(achats.body.some((a) => a.chantierId === chantierTechnicien.id));
      sansMontants(achats.body, 'journal des achats');
      const heures = await request(app).get('/api/heures').set(authTechnicien);
      assert.equal(heures.status, 200, JSON.stringify(heures.body));
      assert.ok(heures.body.some((h) => h.chantierId === chantierTechnicien.id));
      sansMontants(heures.body, 'journal des heures');
      const journal = await request(app).get(`/api/chantiers/${chantierTechnicien.id}/journal-saisies`).set(authTechnicien);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.ok(journal.body.length >= 3, 'création de l’achat et du pointage, correction de l’achat');
      assert.ok(journal.body.some((entree) => entree.action === 'CORRECTION' && entree.avant && entree.apres), 'instantanés avant et après d’une correction');
      sansMontants(journal.body, 'journal des saisies');
      const tableau = await request(app).get('/api/stats/global').set(authTechnicien);
      assert.equal(tableau.status, 200, JSON.stringify(tableau.body));
      assert.equal(tableau.body.achatsTotal, undefined);
      const intervenants = await request(app).get('/api/intervenants').set(authTechnicien);
      assert.equal(intervenants.status, 200, JSON.stringify(intervenants.body));
      assert.ok(intervenants.body.length > 0 && intervenants.body.every((i) => !('tauxHoraireCharge' in i)));
      // Témoin : le journal relu par l'administration garde ses montants.
      const journalAdmin = await request(app).get(`/api/chantiers/${chantierTechnicien.id}/journal-saisies`).set(auth);
      assert.match(JSON.stringify(journalAdmin.body), MONTANTS);
    });

    test('il ne modifie pas l’affaire, n’en réattribue pas le commercial, ne la clôture pas, et le refus le lui dit', async () => {
      const essais = [
        ['modification', () => request(app).patch(`/api/chantiers/${chantierTechnicien.id}`).set(authTechnicien).send({ nom: 'TEST renommé par le technicien' }), /technicien n’est pas autorisé à modifier/],
        ['commercial', () => request(app).patch(`/api/chantiers/${chantierTechnicien.id}/commercial`).set(authTechnicien).send({ commercialId: commercial.id }), /technicien n’est pas autorisé à réattribuer/],
        ['clôture', () => request(app).patch(`/api/chantiers/${chantierTechnicien.id}/statut`).set(authTechnicien).send({ statut: 'TERMINE' }), /compte Responsable de sa branche, à la direction ou à l’administration/],
      ];
      for (const champ of ['budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues']) {
        for (const valeur of [1, 0, null, '']) {
          essais.push([`${champ} = ${JSON.stringify(valeur)}`, () => request(app).patch(`/api/chantiers/${chantierTechnicien.id}`).set(authTechnicien).send({ [champ]: valeur }), /technicien n’est pas autorisé à modifier/]);
        }
      }
      for (const [quoi, essai, message] of essais) {
        const refus = await essai();
        assert.equal(refus.status, 403, `${quoi} : ${JSON.stringify(refus.body)}`);
        assert.match(refus.body.error, message, quoi);
      }
      const enBase = await prisma.chantier.findUnique({ where: { id: chantierTechnicien.id } });
      assert.deepEqual(
        [enBase.nom, enBase.statut, enBase.commercialId, Number(enBase.budgetMaterielVendu), Number(enBase.budgetMainOeuvreVendu), Number(enBase.heuresVendues)],
        ['TEST Budgets chantier du technicien', 'EN_COURS', null, 300, 500, 10],
      );
    });

    test('son N+1 clôture son affaire ; un responsable hors de sa branche ne le peut pas, ni le N+1 l’affaire d’un conducteur', async () => {
      const ligne = async (entetes, chantier) => (await request(app).get('/api/chantiers').set(entetes)).body.find((c) => c.id === chantier.id);
      assert.equal((await ligne(authDe.responsable, chantierTechnicien)).peutCloturer, true);
      // La règle du conducteur reste celle d'avant : lui seul clôture son affaire, avec l'administration
      // et les directeurs (#128) ; pas le compte Responsable de sa branche.
      assert.equal((await ligne(authDe.responsable, chantierConducteur)).peutCloturer, false);
      assert.equal((await ligne(authDe.conducteur, chantierConducteur)).peutCloturer, true);
      assert.equal((await request(app).patch(`/api/chantiers/${chantierConducteur.id}/statut`).set(authDe.responsable).send({ statut: 'TERMINE' })).status, 404);
      const horsBranche = await request(app).patch(`/api/chantiers/${chantierTechnicien.id}/statut`).set(authDe.autreResponsable).send({ statut: 'TERMINE' });
      assert.equal(horsBranche.status, 404, JSON.stringify(horsBranche.body));
      const cloture = await request(app).patch(`/api/chantiers/${chantierTechnicien.id}/statut`).set(authDe.responsable).send({ statut: 'TERMINE' });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      assert.equal(cloture.body.statut, 'TERMINE');
      const reouverture = await request(app).patch(`/api/chantiers/${chantierTechnicien.id}/statut`).set(authDe.responsable).send({ statut: 'EN_COURS' });
      assert.equal(reouverture.status, 403, 'seul un administrateur rouvre');
    });

    test('un directeur clôture n’importe quel chantier, sans le rouvrir ni le modifier', async () => {
      const chantier = await prisma.chantier.create({ data: { client: 'TEST Client budgets', dateDebut: new Date(), budgetGlobalVendu: 1000, nom: 'TEST Budgets chantier clôturé par la direction', responsableId: chantierConducteur.responsableId } });
      const ligne = (await request(app).get('/api/chantiers').set(authDe.directeur)).body.find((c) => c.id === chantier.id);
      assert.equal(ligne.peutCloturer, true);
      const cloture = await request(app).patch(`/api/chantiers/${chantier.id}/statut`).set(authDe.directeur).send({ statut: 'TERMINE' });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      assert.equal(cloture.body.statut, 'TERMINE');
      assert.notEqual(cloture.body.dateFin, null, 'date de fin posée à la clôture');
      const reouverture = await request(app).patch(`/api/chantiers/${chantier.id}/statut`).set(authDe.directeur).send({ statut: 'EN_COURS' });
      assert.equal(reouverture.status, 403, 'seul un administrateur rouvre');
      // La clôture reste son seul geste d'écriture sur l'affaire.
      assert.equal((await request(app).patch(`/api/chantiers/${chantier.id}`).set(authDe.directeur).send({ nom: 'TEST piraté' })).status, 403);
      assert.equal((await prisma.chantier.findUnique({ where: { id: chantier.id } })).statut, 'TERMINE');
      // Un conducteur ne clôture que l'affaire dont il est chargé.
      assert.equal((await request(app).patch(`/api/chantiers/${chantierTechnicien.id}/statut`).set(authDe.conducteur).send({ statut: 'TERMINE' })).status, 404);
      // N'importe quel chantier : celui d'un technicien comme celui qui n'a pas encore de titulaire.
      for (const [qui, responsableId] of [['technicien', technicien.id], ['sans titulaire', null]]) {
        const autre = await prisma.chantier.create({ data: { client: 'TEST Client budgets', dateDebut: new Date(), budgetGlobalVendu: 1000, nom: `TEST Budgets chantier ${qui} clôturé par la direction`, responsableId } });
        assert.equal((await request(app).get('/api/chantiers').set(authDe.directeur)).body.find((c) => c.id === autre.id)?.peutCloturer, true, qui);
        const clotureAutre = await request(app).patch(`/api/chantiers/${autre.id}/statut`).set(authDe.directeur).send({ statut: 'TERMINE' });
        assert.equal(clotureAutre.status, 200, `${qui} : ${JSON.stringify(clotureAutre.body)}`);
      }
    });

    // La route de statut ne ferme plus que le commercial (blockCommercialSeulement). Un compte
    // commercial peut être titulaire d'un chantier (tout compte actif peut l'être, et un compte
    // change de type) : il ne le clôture pas pour autant.
    test('un commercial titulaire d’un chantier ne le clôture pas (403)', async () => {
      // Titulaire et commercial du chantier, il le voit dans sa liste : sans bouton « Clôturer ».
      const chantier = await prisma.chantier.create({ data: { client: 'TEST Client budgets', dateDebut: new Date(), budgetGlobalVendu: 1000, nom: 'TEST Budgets chantier au nom du commercial', responsableId: commercial.id, commercialId: commercial.id } });
      const ligne = (await request(app).get('/api/chantiers').set(authDe.commercial)).body.find((c) => c.id === chantier.id);
      assert.ok(ligne, 'le commercial voit le chantier qu’il a vendu');
      assert.equal(ligne.peutCloturer, false);
      const refus = await request(app).patch(`/api/chantiers/${chantier.id}/statut`).set(authDe.commercial).send({ statut: 'TERMINE' });
      assert.equal(refus.status, 403, JSON.stringify(refus.body));
      const enBase = await prisma.chantier.findUnique({ where: { id: chantier.id } });
      assert.equal(enBase.statut, 'EN_COURS');
      assert.equal(enBase.dateFin, null);
    });

    // La route de statut s'ouvre au directeur, qui atteint tous les chantiers : une affaire
    // annulée lui reste fermée comme à l'administration.
    test('une affaire annulée ne se clôture ni ne se rouvre, même par un directeur ou l’administration (409)', async () => {
      const chantier = await prisma.chantier.create({ data: { client: 'TEST Client budgets', dateDebut: new Date(), budgetGlobalVendu: 1000, nom: 'TEST Budgets affaire annulée', statut: 'ANNULE', annuleLe: new Date(), responsableId: chantierConducteur.responsableId } });
      for (const [qui, entetes, statut] of [['directeur', authDe.directeur, 'TERMINE'], ['administration', auth, 'TERMINE'], ['administration', auth, 'EN_COURS']]) {
        const reponse = await request(app).patch(`/api/chantiers/${chantier.id}/statut`).set(entetes).send({ statut });
        assert.equal(reponse.status, 409, `${qui} vers ${statut} : ${JSON.stringify(reponse.body)}`);
        assert.match(reponse.body.error, /affaire est annulée/);
      }
      const enBase = await prisma.chantier.findUnique({ where: { id: chantier.id } });
      assert.equal(enBase.statut, 'ANNULE');
      assert.equal(enBase.dateFin, null);
    });

    test('la réattribution du commercial hors de son périmètre répond 404, sans révéler le chantier', async () => {
      for (const [qui, entetes, chantier] of [['conducteur', authDe.conducteur, chantierTechnicien], ['responsable', authDe.responsable, chantierConducteur]]) {
        const reponse = await request(app).patch(`/api/chantiers/${chantier.id}/commercial`).set(entetes).send({ commercialId: commercial.id });
        assert.equal(reponse.status, 404, `${qui} : ${JSON.stringify(reponse.body)}`);
        assert.equal(reponse.body.error, 'Chantier introuvable');
      }
      // Témoin : le chantier n'existe pas du tout.
      assert.equal((await request(app).patch('/api/chantiers/00000000-0000-0000-0000-000000000000/commercial').set(authDe.conducteur).send({ commercialId: null })).status, 404);
    });

    const avecMontants = (vue, qui, budgetMainOeuvre = 700) => {
      assert.equal(vue.budgetMaterielVendu, 300, qui);
      assert.equal(vue.budgetMainOeuvreVendu, budgetMainOeuvre, qui);
      assert.equal(vue.metrics.pctMateriel, 150, qui);
      assert.equal(vue.metrics.materielReel, 450, qui);
      assert.ok(vue.metrics.alertes.includes('MATERIEL_DEPASSE'), qui);
    };

    test('les autres profils et les clés d’intégration voient toujours budgets, achats et alertes', async () => {
      const comptable = await request(app).get(`/api/chantiers/${chantierComptable.id}`).set(authComptable);
      assert.equal(comptable.status, 200, JSON.stringify(comptable.body));
      avecMontants(comptable.body, 'comptable responsable du chantier');
      // Taux et coût de main-d'œuvre : réservés à l'administration, comptable compris (lot (d)).
      assert.equal(comptable.body.metrics.moReel, null);
      const vues = [
        ['responsable du technicien', authDe.responsable, chantierTechnicien, 500],
        ['conducteur du chantier', authDe.conducteur, chantierConducteur, 700],
        ['directeur', authDe.directeur, chantierTechnicien, 500],
        ['commercial vendeur', authDe.commercial, chantierComptable, 700],
      ];
      for (const [qui, entetes, chantier, budgetMainOeuvre] of vues) {
        const fiche = await request(app).get(`/api/chantiers/${chantier.id}`).set(entetes);
        assert.equal(fiche.status, 200, `${qui} : ${JSON.stringify(fiche.body)}`);
        avecMontants(fiche.body, `fiche, ${qui}`, budgetMainOeuvre);
        responsableSansRole(fiche.body, `fiche, ${qui}`);
        const liste = await request(app).get('/api/chantiers').set(entetes);
        const ligne = liste.body.find((c) => c.id === chantier.id);
        avecMontants(ligne, `liste, ${qui}`, budgetMainOeuvre);
        responsableSansRole(ligne, `liste, ${qui}`);
      }
      // Le N+1 voit les dépassements d'heures et de main-d'œuvre du chantier de son technicien ;
      // le coût de main-d'œuvre lui-même est réservé à l'administration (lot (d)).
      const vueResponsable = (await request(app).get(`/api/chantiers/${chantierTechnicien.id}`).set(authDe.responsable)).body;
      assert.equal(vueResponsable.metrics.moReel, null);
      assert.equal((await request(app).get(`/api/chantiers/${chantierTechnicien.id}`).set(auth)).body.metrics.moReel, 504);
      for (const alerte of ['HEURES_DEPASSEES', 'MAIN_OEUVRE_DEPASSEE']) assert.ok(vueResponsable.metrics.alertes.includes(alerte), alerte);
      const admin = (await request(app).get('/api/chantiers').set(auth)).body.find((c) => c.id === chantierTechnicien.id);
      avecMontants(admin, 'administrateur', 500);
      responsableSansRole(admin, 'administrateur');
      const parCle = (await request(app).get('/api/v1/chantiers').set({ Authorization: `Bearer ${cle}` })).body.find((c) => c.id === chantierTechnicien.id);
      avecMontants(parCle, 'clé d’intégration', 500);
      responsableSansRole(parCle, 'clé d’intégration');
      // Sans objet pour une clé, qui ne clôture rien.
      assert.equal('peutCloturer' in parCle, false);
      // L'administrateur corrige toujours ces budgets.
      const correction = await request(app).patch(`/api/chantiers/${chantierComptable.id}`).set(auth).send({ budgetMaterielVendu: 320 });
      assert.equal(correction.status, 200, JSON.stringify(correction.body));
      assert.equal(Number(correction.body.budgetMaterielVendu), 320);
    });

    test('ni devis, ni saisie ou archivage Travaux, ni accès financier ne s’accordent à un technicien', async () => {
      try {
        for (const permission of ['devis:read', 'devis:write', 'chantiers:write', 'chantiers:archive']) {
          const refus = await request(app).put(`/api/users/${technicien.id}/permissions`).set(auth).send({ permissions: [permission] });
          assert.equal(refus.status, 400, `${permission} : ${JSON.stringify(refus.body)}`);
          assert.match(refus.body.error, /technicien/);
        }
        assert.equal((await request(app).put(`/api/users/${technicien.id}/permissions`).set(auth).send({ permissions: ['clients:read'] })).status, 200);
        const finance = await request(app).patch(`/api/users/${technicien.id}/acces-finance`).set(auth).send({ accesFinance: true });
        assert.equal(finance.status, 400, JSON.stringify(finance.body));
        assert.equal((await request(app).patch(`/api/users/${technicien.id}/acces-finance`).set(auth).send({ accesFinance: false })).status, 200);
        // Droits enregistrés avant la règle, ou avant un changement de type : sans effet.
        await prisma.user.update({ where: { id: technicien.id }, data: { permissions: ['devis:read', 'chantiers:write'], accesFinance: true } });
        assert.equal((await request(app).get('/api/devis').set(authTechnicien)).status, 403);
        const compte = (await request(app).get('/api/users').set(auth)).body.find((u) => u.id === technicien.id);
        assert.deepEqual(compte.permissions, ['chantiers:read', 'clients:read']);
        // Ces droits enregistrés se conservent ou se retirent, sans qu'aucun ne s'y ajoute.
        const ajout = await request(app).put(`/api/users/${technicien.id}/permissions`).set(auth).send({ permissions: ['devis:read', 'chantiers:write', 'chantiers:archive'] });
        assert.equal(ajout.status, 400, JSON.stringify(ajout.body));
        assert.match(ajout.body.error, /chantiers:archive/);
        assert.doesNotMatch(ajout.body.error, /devis:read|chantiers:write/);
        const retrait = await request(app).put(`/api/users/${technicien.id}/permissions`).set(auth).send({ permissions: ['devis:read', 'clients:read'] });
        assert.equal(retrait.status, 200, JSON.stringify(retrait.body));
        assert.deepEqual((await prisma.user.findUnique({ where: { id: technicien.id } })).permissions, ['devis:read', 'clients:read']);
        assert.equal((await request(app).get('/api/devis').set(authTechnicien)).status, 403, 'toujours sans effet');
        // Ni à la création d'un technicien…
        const creation = await request(app).post('/api/users').set(auth).send({ email: 'budgets.finance.technicien@iris.test', name: 'TEST Budgets finance technicien', role: 'TECHNICIEN', accesFinance: true });
        assert.equal(creation.status, 400, JSON.stringify(creation.body));
        assert.match(creation.body.error, /technicien/);
        assert.equal(await prisma.user.count({ where: { email: 'budgets.finance.technicien@iris.test' } }), 0);
        // … et un accès financier enregistré reste sans effet pour un compte devenu technicien,
        // sans être effacé : il retrouve son effet si le compte reprend un autre type.
        const reconverti = await prisma.user.create({ data: { email: 'budgets.reconversion@iris.test', name: 'TEST Budgets reconversion', role: 'CONDUCTEUR_TRAVAUX', accesFinance: true } });
        const droitsDe = async (id) => (await request(app).get('/api/users').set(auth)).body.find((u) => u.id === id).permissions;
        assert.ok((await droitsDe(reconverti.id)).includes('finances:read'), 'témoin : conducteur avec accès financier');
        for (const [role, finance] of [['TECHNICIEN', false], ['CONDUCTEUR_TRAVAUX', true]]) {
          const passage = await request(app).patch(`/api/users/${reconverti.id}/role`).set(auth).send({ role });
          assert.equal(passage.status, 200, JSON.stringify(passage.body));
          assert.equal((await prisma.user.findUnique({ where: { id: reconverti.id } })).accesFinance, true, `${role} : donnée conservée`);
          assert.equal((await droitsDe(reconverti.id)).includes('finances:read'), finance, `${role} : effet`);
        }
      } finally {
        await prisma.user.update({ where: { id: technicien.id }, data: { permissions: [], accesFinance: false } });
      }
    });
  });

  // Annuaire des clients pour le technicien (décision de Nelson du 13-10-2026) : il consulte les
  // clients, leurs contacts et leurs sites, par exemple pour retrouver une adresse, et l'historique
  // des chantiers du client, sans montant ; il ne modifie rien et ne voit ni devis ni prix.
  describe('Taux horaire et coût de main-d’œuvre réservés à l’administration', () => {
    let auth = {};
    let authDe = {};
    let conducteur;
    let chantier;
    let intervenant;
    let pointage;
    let cle = '';
    let ancienParametres;

    // Aucun taux, où qu'il soit dans la réponse : pointage, intervenant joint, instantané du journal.
    const sansTaux = (corps, qui) => {
      const texte = JSON.stringify(corps);
      for (const champ of ['tauxHoraireApplique', 'tauxHoraireCharge']) assert.equal(texte.includes(`"${champ}"`), false, `${qui} : ${champ} exposé`);
    };

    before(async () => {
      const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(login.status, 200);
      auth = { Authorization: `Bearer ${login.body.token}` };
      ancienParametres = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      // Destinataires de la rentabilité par défaut : le conducteur, sa chaîne et les directeurs.
      const reglage = await request(app).put('/api/parametres').set(auth)
        .send({ margeCommercialeActive: true, rentabiliteConducteur: true, rentabiliteHierarchie: true, rentabiliteDirecteurs: true });
      assert.equal(reglage.status, 200, JSON.stringify(reglage.body));
      const jeton = (compte) => ({ Authorization: `Bearer ${jwt.sign({ id: compte.id }, process.env.JWT_SECRET)}` });
      const responsable = await prisma.user.create({ data: { email: 'taux.responsable@iris.test', name: 'TEST Taux responsable', role: 'RESPONSABLE' } });
      // L'archivage d'une heure est un droit individuel (chantiers:archive), accordé ici pour en tester la réponse.
      conducteur = await prisma.user.create({ data: { email: 'taux.conducteur@iris.test', name: 'TEST Taux conducteur', role: 'CONDUCTEUR_TRAVAUX', responsableHierarchiqueId: responsable.id, permissions: ['chantiers:archive'] } });
      const directeur = await prisma.user.create({ data: { email: 'taux.directeur@iris.test', name: 'TEST Taux directeur', role: 'DIRECTEUR' } });
      const commercial = await prisma.user.create({ data: { email: 'taux.commercial@iris.test', name: 'TEST Taux commercial', role: 'COMMERCIAL' } });
      authDe = { responsable: jeton(responsable), conducteur: jeton(conducteur), directeur: jeton(directeur), commercial: jeton(commercial) };
      // Vendu 1 000 € dont 300 € de matériel et 500 € de main-d'œuvre, 10 h vendues ; 100 € d'achats
      // et 12 h à 42 €/h (504 €) : heures et main-d'œuvre dépassées, marge du jour 396 €.
      chantier = await prisma.chantier.create({ data: {
        nom: 'TEST Taux chantier', client: 'TEST Client taux', dateDebut: new Date(), budgetGlobalVendu: 1000, budgetMaterielVendu: 300,
        budgetMainOeuvreVendu: 500, heuresVendues: 10, responsableId: conducteur.id, commercialId: commercial.id,
      } });
      const categorie = await prisma.categorie.create({ data: { nom: 'TEST Taux catégorie' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: 'TEST Taux fournisseur' } });
      const achat = await request(app).post('/api/achats').set(auth).send({ chantierId: chantier.id, categorieId: categorie.id, fournisseurId: fournisseur.id, date: jourCivilEntreprise(new Date()), description: 'TEST achat taux', montantHT: 100 });
      assert.equal(achat.status, 200, JSON.stringify(achat.body));
      intervenant = await prisma.intervenant.create({ data: { nom: 'TEST Taux intervenant', role: 'TECHNICIEN', tauxHoraireCharge: 42 } });
      const heures = await request(app).post('/api/heures').set(auth).send({ chantierId: chantier.id, intervenantId: intervenant.id, date: jourCivilEntreprise(new Date()), nbrHeures: 12 });
      assert.equal(heures.status, 200, JSON.stringify(heures.body));
      pointage = heures.body;
      const creation = await request(app).post('/api/admin/api-keys').set(auth).send({ nom: 'TEST agent taux', scopes: ['chantiers:read'] });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      cle = creation.body.apiKey;
    });

    after(async () => {
      if (ancienParametres) await prisma.parametres.update({ where: { id: 'singleton' }, data: {
        margeCommercialeActive: ancienParametres.margeCommercialeActive,
        rentabiliteConducteur: ancienParametres.rentabiliteConducteur,
        rentabiliteHierarchie: ancienParametres.rentabiliteHierarchie,
        rentabiliteDirecteurs: ancienParametres.rentabiliteDirecteurs,
      } });
    });

    test('chantiers : heures, marges et alertes gardées, sans taux ni coût de main-d’œuvre hors administration', async () => {
      const vues = [
        ['conducteur du chantier', authDe.conducteur, true],
        ['responsable de sa branche', authDe.responsable, true],
        ['directeur', authDe.directeur, true],
        ['commercial vendeur', authDe.commercial, false],
      ];
      for (const [qui, entetes, rentabilite] of vues) {
        const fiche = await request(app).get(`/api/chantiers/${chantier.id}`).set(entetes);
        assert.equal(fiche.status, 200, `${qui} : ${JSON.stringify(fiche.body)}`);
        const ligne = (await request(app).get('/api/chantiers').set(entetes)).body.find((c) => c.id === chantier.id);
        for (const [ou, vue] of [['fiche', fiche.body], ['liste', ligne]]) {
          const contexte = `${ou}, ${qui}`;
          sansTaux(vue, contexte);
          assert.equal(vue.metrics.moReel, null, contexte);
          assert.equal(vue.metrics.totalDepenses, null, contexte);
          assert.equal(vue.metrics.pctMainOeuvre, null, contexte);
          // Gardés : heures, budget main-d'œuvre vendu, matériel et alertes de dépassement.
          assert.equal(vue.metrics.heuresRealisees, 12, contexte);
          assert.equal(vue.budgetMainOeuvreVendu, 500, contexte);
          assert.equal(vue.metrics.materielReel, 100, contexte);
          for (const alerte of ['HEURES_DEPASSEES', 'MAIN_OEUVRE_DEPASSEE']) assert.ok(vue.metrics.alertes.includes(alerte), `${contexte} : ${alerte}`);
          if (rentabilite) {
            // Décision du 16-10-2026 : les destinataires de la rentabilité gardent les marges.
            assert.equal(vue.metrics.margeCommerciale, 396, contexte);
            assert.equal(typeof vue.metrics.margeEstimee, 'number', contexte);
            assert.equal(vue.metrics.estimation.coutEstime, null, contexte);
            assert.equal(vue.metrics.estimation.coutMainOeuvreAttendu, null, contexte);
            assert.equal(vue.metrics.estimation.coutHoraireReference, null, contexte);
            assert.equal(vue.metrics.estimation.sourceCoutHoraire, 'CHANTIER', contexte);
            assert.equal(typeof vue.metrics.estimation.coutMaterielAttendu, 'number', contexte);
          }
        }
        assert.deepEqual(fiche.body.pointages.map((p) => p.nbrHeures), [12], qui);
        assert.equal(fiche.body.pointages[0].intervenant.nom, 'TEST Taux intervenant', qui);
      }
      // Témoins : l'administration et une clé d'intégration voient taux et coût de main-d'œuvre.
      const admin = (await request(app).get(`/api/chantiers/${chantier.id}`).set(auth)).body;
      assert.equal(admin.metrics.moReel, 504);
      assert.equal(admin.metrics.totalDepenses, 604);
      assert.equal(admin.metrics.estimation.coutHoraireReference, 42);
      assert.equal(admin.pointages[0].tauxHoraireApplique, 42);
      assert.equal(admin.pointages[0].intervenant.tauxHoraireCharge, 42);
      const parCle = (await request(app).get('/api/v1/chantiers').set({ Authorization: `Bearer ${cle}` })).body.find((c) => c.id === chantier.id);
      assert.equal(parCle.metrics.moReel, 504);
      assert.equal(parCle.pointages[0].tauxHoraireApplique, 42);
    });

    test('heures, intervenants et journal des saisies : ni taux appliqué ni taux de l’intervenant hors administration', async () => {
      for (const [qui, entetes] of [['conducteur', authDe.conducteur], ['responsable', authDe.responsable], ['directeur', authDe.directeur]]) {
        const heures = await request(app).get('/api/heures').set(entetes);
        assert.equal(heures.status, 200, `${qui} : ${JSON.stringify(heures.body)}`);
        const ligne = heures.body.find((h) => h.id === pointage.id);
        assert.equal(ligne.nbrHeures, 12, qui);
        sansTaux(heures.body, `heures, ${qui}`);
      }
      for (const [qui, entetes] of [['conducteur', authDe.conducteur], ['responsable', authDe.responsable], ['directeur', authDe.directeur], ['commercial', authDe.commercial]]) {
        const intervenants = await request(app).get('/api/intervenants').set(entetes);
        assert.equal(intervenants.status, 200, `${qui} : ${JSON.stringify(intervenants.body)}`);
        assert.ok(intervenants.body.some((i) => i.id === intervenant.id), qui);
        sansTaux(intervenants.body, `intervenants, ${qui}`);
      }
      const journal = await request(app).get(`/api/chantiers/${chantier.id}/journal-saisies`).set(authDe.conducteur);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      const creationHeure = journal.body.find((e) => e.cible === 'HEURE' && e.action === 'CREATION');
      assert.equal(creationHeure.apres.nbrHeures, 12);
      sansTaux(journal.body, 'journal des saisies, conducteur');
      // Le montant d'un achat reste visible : il n'est pas un coût de main-d'œuvre.
      assert.equal(journal.body.find((e) => e.cible === 'ACHAT').apres.montantHT, 100);
      // Témoins.
      assert.equal((await request(app).get('/api/heures').set(auth)).body.find((h) => h.id === pointage.id).tauxHoraireApplique, 42);
      assert.equal((await request(app).get('/api/intervenants').set(auth)).body.find((i) => i.id === intervenant.id).tauxHoraireCharge, 42);
      const journalAdmin = (await request(app).get(`/api/chantiers/${chantier.id}/journal-saisies`).set(auth)).body;
      assert.equal(journalAdmin.find((e) => e.cible === 'HEURE' && e.action === 'CREATION').apres.tauxHoraireApplique, 42);
    });

    test('saisie, correction, archivage et restauration d’heures par le conducteur : réponses sans taux, taux figé en base', async () => {
      const saisie = await request(app).post('/api/heures').set(authDe.conducteur)
        .send({ chantierId: chantier.id, intervenantId: intervenant.id, date: jourCivilEntreprise(new Date()), nbrHeures: 2 });
      assert.equal(saisie.status, 200, JSON.stringify(saisie.body));
      assert.equal(Number(saisie.body.nbrHeures), 2);
      sansTaux(saisie.body, 'saisie');
      try {
        assert.equal(Number((await prisma.pointageHeure.findUniqueOrThrow({ where: { id: saisie.body.id } })).tauxHoraireApplique), 42);
        const correction = await request(app).patch(`/api/heures/${saisie.body.id}`).set(authDe.conducteur).send({ nbrHeures: 3, motifCorrection: 'TEST correction taux' });
        assert.equal(correction.status, 200, JSON.stringify(correction.body));
        assert.equal(Number(correction.body.nbrHeures), 3);
        sansTaux(correction.body, 'correction');
        const archivage = await request(app).delete(`/api/heures/${saisie.body.id}`).set(authDe.conducteur).send({ motifArchivage: 'TEST archivage taux' });
        assert.equal(archivage.status, 200, JSON.stringify(archivage.body));
        const restauration = await request(app).post(`/api/heures/${saisie.body.id}/restaurer`).set(authDe.conducteur).send({ motifRestauration: 'TEST restauration taux' });
        assert.equal(restauration.status, 200, JSON.stringify(restauration.body));
        sansTaux(restauration.body, 'restauration');
      } finally {
        // Remet le chantier dans son état initial pour les autres tests du bloc, même en cas
        // d'échec ci-dessus (409 si la saisie est déjà archivée).
        await request(app).delete(`/api/heures/${saisie.body.id}`).set(auth).send({ motifArchivage: 'TEST fin du test' });
      }
      assert.equal((await prisma.pointageHeure.findUniqueOrThrow({ where: { id: saisie.body.id } })).archivedAt instanceof Date, true);
      // Témoin : l'administration reçoit le taux en réponse.
      const saisieAdmin = await request(app).patch(`/api/heures/${pointage.id}`).set(auth).send({ commentaire: 'TEST témoin', motifCorrection: 'TEST témoin taux' });
      assert.equal(saisieAdmin.status, 200, JSON.stringify(saisieAdmin.body));
      assert.equal(Number(saisieAdmin.body.tauxHoraireApplique), 42);
    });

    test('statistiques : coût par intervenant, dépenses et manque à gagner réservés à l’administration', async () => {
      const ref = jourCivilEntreprise(new Date());
      const parConducteur = await request(app).get(`/api/stats/intervenants?period=week&ref=${ref}`).set(authDe.conducteur);
      assert.equal(parConducteur.status, 200, JSON.stringify(parConducteur.body));
      const ligne = parConducteur.body.intervenants.find((i) => i.id === intervenant.id);
      assert.equal(ligne.heures, 12);
      assert.equal(ligne.cout, null);
      const parAdmin = (await request(app).get(`/api/stats/intervenants?period=week&ref=${ref}`).set(auth)).body.intervenants.find((i) => i.id === intervenant.id);
      assert.equal(parAdmin.cout, 504);
      const conducteurs = await request(app).get('/api/stats/conducteurs').set(authDe.responsable);
      assert.equal(conducteurs.status, 200, JSON.stringify(conducteurs.body));
      const agregat = conducteurs.body.find((c) => c.id === conducteur.id);
      assert.equal(agregat.nbChantiers, 1);
      assert.equal(agregat.depensesTotal, null);
      assert.equal(agregat.manqueAGagnerMainOeuvre, null);
      // La marge reste au responsable destinataire de la rentabilité de sa branche.
      assert.equal(agregat.margeTotal, 396);
      const agregatAdmin = (await request(app).get('/api/stats/conducteurs').set(auth)).body.find((c) => c.id === conducteur.id);
      assert.equal(agregatAdmin.depensesTotal, 604);
      assert.equal(agregatAdmin.manqueAGagnerMainOeuvre, 0);
    });

    test('coûts SAV : le conducteur garde heures et matériel, sans taux ni coût de main-d’œuvre', async () => {
      const client = await prisma.client.create({ data: { raisonSociale: 'TEST Client taux SAV' } });
      const contrat = await prisma.contratMaintenance.create({ data: {
        clientId: client.id, titre: 'TEST Contrat taux', statut: 'ACTIF', periodiciteMois: 12, dureePrevisionnelleMinutes: 60,
        dateDebut: new Date('2026-01-01T00:00:00.000Z'), prochaineEcheance: new Date('2026-12-01T00:00:00.000Z'),
      } });
      // Le conducteur suit le dossier SAV qu'il a ouvert.
      const intervention = await prisma.intervention.create({ data: {
        reference: `I26-TAUX-${Date.now()}`, clientId: client.id, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance,
        titre: 'TEST Intervention taux', createdById: conducteur.id,
      } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Taux fournisseur SAV ${Date.now()}` } });
      const heure = await prisma.coutInterventionHeure.create({ data: { interventionId: intervention.id, intervenantId: intervenant.id, date: new Date('2026-09-06'), nbrHeures: 2, tauxHoraireApplique: 42, createdById: conducteur.id } });
      await prisma.coutInterventionAchat.create({ data: { interventionId: intervention.id, fournisseurId: fournisseur.id, date: new Date('2026-09-06'), description: 'TEST achat SAV taux', montantHT: 10, createdById: conducteur.id } });

      const couts = await request(app).get(`/api/interventions/${intervention.id}/couts`).set(authDe.conducteur);
      assert.equal(couts.status, 200, JSON.stringify(couts.body));
      assert.deepEqual(couts.body.heures.map((h) => h.nbrHeures), [2]);
      assert.equal(couts.body.totalMaterielHT, 10);
      assert.equal(couts.body.totalMainOeuvreHT, null);
      assert.equal(couts.body.totalCoutsHT, null);
      sansTaux(couts.body, 'coûts SAV, conducteur');
      const archivage = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heure.id}/archiver`).set(authDe.conducteur).send({ motif: 'TEST archivage SAV taux' });
      assert.equal(archivage.status, 200, JSON.stringify(archivage.body));
      sansTaux(archivage.body, 'archivage SAV, conducteur');
      const journal = await request(app).get(`/api/interventions/${intervention.id}/journal-saisies`).set(authDe.conducteur);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.ok(journal.body.some((e) => e.cible === 'COUT_INTERVENTION_HEURE' && e.action === 'ARCHIVAGE'));
      sansTaux(journal.body, 'journal SAV, conducteur');
      // Témoins : l'administration voit le taux et le coût de main-d'œuvre.
      const coutsAdmin = (await request(app).get(`/api/interventions/${intervention.id}/couts`).set(auth)).body;
      assert.equal(coutsAdmin.heures[0].tauxHoraireApplique, 42);
      const restauration = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heure.id}/restaurer`).set(auth).send({ motif: 'TEST restauration SAV taux' });
      assert.equal(restauration.status, 200, JSON.stringify(restauration.body));
      assert.equal(restauration.body.tauxHoraireApplique, 42);
      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/couts`).set(auth)).body.totalMainOeuvreHT, 84);
      const journalAdmin = (await request(app).get(`/api/interventions/${intervention.id}/journal-saisies`).set(auth)).body;
      assert.equal(journalAdmin.find((e) => e.action === 'ARCHIVAGE').avant.tauxHoraireApplique, 42);
    });
  });

  describe('Annuaire des clients pour le technicien', () => {
    let auth = {};
    const jetons = {};
    let client;
    let contact;
    let site;
    const chantiers = {};

    before(async () => {
      const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(login.status, 200);
      auth = { Authorization: `Bearer ${login.body.token}` };
      const compte = async (cle, email, role, extra = {}) => {
        const user = await prisma.user.create({ data: { email, name: `TEST Annuaire ${cle}`, role, ...extra } });
        jetons[cle] = { Authorization: `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}` };
        return user;
      };
      const technicien = await compte('technicien', 'annuaire.technicien@iris.test', 'TECHNICIEN');
      // Un responsable porteur d'un clients:read individuel, dont la branche contient le collègue.
      const responsable = await compte('responsable', 'annuaire.responsable@iris.test', 'RESPONSABLE', { permissions: ['clients:read'] });
      const autreTechnicien = await compte('autreTechnicien', 'annuaire.autre.technicien@iris.test', 'TECHNICIEN', { responsableHierarchiqueId: responsable.id });
      const conducteur = await compte('conducteur', 'annuaire.conducteur@iris.test', 'CONDUCTEUR_TRAVAUX');
      await compte('directeur', 'annuaire.directeur@iris.test', 'DIRECTEUR');
      const commercial = await compte('commercial', 'annuaire.commercial@iris.test', 'COMMERCIAL');
      client = await prisma.client.create({ data: { raisonSociale: 'TEST Annuaire Résidence des Tilleuls', telephone: '01 23 45 67 89' } });
      contact = await prisma.clientContact.create({ data: { clientId: client.id, nom: 'Gardien', prenom: 'Paul', telephone: '06 11 22 33 44', principal: true } });
      site = await prisma.clientSite.create({ data: { clientId: client.id, nom: 'Bâtiment B', adresse: '12 rue des Tilleuls', complementAdresse: 'Accès par la cour', codePostal: '75011', ville: 'Paris' } });
      // Montants reconnaissables : aucun ne doit sortir de l'historique.
      const vente = { client: client.raisonSociale, clientId: client.id, budgetGlobalVendu: 987654, budgetMaterielVendu: 123456, budgetMainOeuvreVendu: 234567, heuresVendues: 345 };
      const jour = (iso) => new Date(`${iso}T00:00:00.000Z`);
      chantiers.enCours = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Annuaire chantier en cours', adresse: '12 rue des Tilleuls, 75011 Paris', dateDebut: jour('2026-09-01'), responsableId: technicien.id } });
      chantiers.termine = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Annuaire chantier terminé', dateDebut: jour('2026-03-02'), dateFin: jour('2026-04-30'), statut: 'TERMINE', responsableId: technicien.id } });
      chantiers.annule = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Annuaire chantier annulé', dateDebut: jour('2026-08-01'), statut: 'ANNULE', responsableId: technicien.id } });
      chantiers.collegue = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Annuaire chantier du collègue', dateDebut: jour('2026-07-01'), responsableId: autreTechnicien.id } });
      chantiers.vendu = await prisma.chantier.create({ data: { ...vente, nom: 'TEST Annuaire chantier vendu', dateDebut: jour('2026-05-01'), responsableId: conducteur.id, commercialId: commercial.id } });
      // Chantier qui ne porte que le libellé du client, sans lien vers sa fiche.
      chantiers.sansFiche = await prisma.chantier.create({ data: { ...vente, clientId: null, nom: 'TEST Annuaire chantier sans fiche', dateDebut: jour('2026-06-01'), responsableId: technicien.id } });
    });

    test('le technicien consulte l’annuaire par défaut, sans rien pouvoir y écrire', async () => {
      const technicien = jetons.technicien;
      const moi = await request(app).get('/api/me').set(technicien);
      assert.equal(moi.status, 200);
      assert.ok(moi.body.permissions.includes('clients:read'), JSON.stringify(moi.body.permissions));
      assert.equal(moi.body.permissions.includes('devis:read'), false);
      // Droit accordé par le type de compte, sans permission enregistrée sur le compte.
      const ligne = (await request(app).get('/api/users').set(auth)).body.find((u) => u.email === 'annuaire.technicien@iris.test');
      assert.deepEqual(ligne.permissionsIndividuelles, []);
      assert.ok(ligne.permissions.includes('clients:read'));

      const liste = await request(app).get('/api/clients?q=Annuaire%20R%C3%A9sidence').set(technicien);
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      const trouve = liste.body.clients.find((c) => c.id === client.id);
      assert.ok(trouve, 'client trouvé par la recherche');
      assert.equal(trouve.sites[0].ville, 'Paris');
      const fiche = await request(app).get(`/api/clients/${client.id}`).set(technicien);
      assert.equal(fiche.status, 200, JSON.stringify(fiche.body));
      assert.equal(fiche.body.contacts[0].telephone, '06 11 22 33 44');
      assert.equal(fiche.body.sites[0].adresse, '12 rue des Tilleuls');
      assert.equal(fiche.body.sites[0].complementAdresse, 'Accès par la cour');

      // Aucune écriture dans l'annuaire, et ni parc, ni catalogue (prix), ni devis.
      const refus = [
        request(app).post('/api/clients').set(technicien).send({ raisonSociale: 'TEST Annuaire création refusée' }),
        request(app).put(`/api/clients/${client.id}`).set(technicien).send({ raisonSociale: 'TEST Annuaire renommé' }),
        request(app).delete(`/api/clients/${client.id}`).set(technicien),
        request(app).post(`/api/clients/${client.id}/contacts`).set(technicien).send({ nom: 'TEST contact refusé' }),
        request(app).put(`/api/clients/${client.id}/contacts/${contact.id}`).set(technicien).send({ nom: 'Renommé' }),
        request(app).post(`/api/clients/${client.id}/sites`).set(technicien).send({ nom: 'Refusé', adresse: '1 rue', codePostal: '75001', ville: 'Paris' }),
        request(app).put(`/api/clients/${client.id}/sites/${site.id}`).set(technicien).send({ nom: 'Renommé' }),
        request(app).get(`/api/clients/${client.id}/equipements`).set(technicien),
        request(app).get('/api/catalogue/equipements').set(technicien),
        request(app).get('/api/devis').set(technicien),
      ];
      for (const reponse of await Promise.all(refus)) {
        assert.equal(reponse.status, 403, `${reponse.req.method} ${reponse.req.path} : ${JSON.stringify(reponse.body)}`);
      }
      const apres = await prisma.client.findUnique({ where: { id: client.id }, include: { contacts: true, sites: true } });
      assert.equal(apres.raisonSociale, 'TEST Annuaire Résidence des Tilleuls');
      assert.equal(apres.actif, true);
      assert.deepEqual(apres.contacts.map((c) => c.nom), ['Gardien']);
      assert.deepEqual(apres.sites.map((s) => s.nom), ['Bâtiment B']);
      assert.equal(await prisma.client.count({ where: { raisonSociale: 'TEST Annuaire création refusée' } }), 0);
    });

    // Valeurs monétaires du jeu de données, où qu'elles se trouvent dans la réponse.
    // Prisma sérialise un Decimal en chaîne : les guillemets sont admis autour de la valeur.
    const MONTANTS_ANNUAIRE = /":\s*"?(987654|123456|234567|345)(\.0+)?"?[,}\]]/;
    const CLES_HISTORIQUE = ['adresse', 'dateDebut', 'dateFin', 'id', 'nom', 'statut'];
    const sansMontant = (corps, qui) => {
      for (const chantier of corps) assert.deepEqual(Object.keys(chantier).sort(), CLES_HISTORIQUE, qui);
      assert.doesNotMatch(JSON.stringify(corps), MONTANTS_ANNUAIRE, `${qui} : un montant est exposé`);
    };

    test('l’historique des chantiers du client, sans montant, suit le périmètre de lecture', async () => {
      const historique = async (qui) => request(app).get(`/api/clients/${client.id}/chantiers`).set(qui);
      // Le technicien : ses chantiers de ce client, en cours et terminés, du plus récent au plus
      // ancien ; ni celui d'un collègue, ni un chantier annulé, ni un chantier sans lien vers la fiche.
      const technicien = await historique(jetons.technicien);
      assert.equal(technicien.status, 200, JSON.stringify(technicien.body));
      assert.deepEqual(technicien.body.map((c) => c.id), [chantiers.enCours.id, chantiers.termine.id]);
      sansMontant(technicien.body, 'technicien');
      assert.equal(technicien.body[1].statut, 'TERMINE');
      assert.equal(technicien.body[1].dateFin, '2026-04-30T00:00:00.000Z');
      assert.deepEqual((await historique(jetons.autreTechnicien)).body.map((c) => c.id), [chantiers.collegue.id]);
      // Les autres porteurs de l'annuaire suivent leur propre périmètre : le commercial, ses
      // ventes ; un responsable (clients:read individuel), sa branche.
      const commercial = await historique(jetons.commercial);
      assert.equal(commercial.status, 200, JSON.stringify(commercial.body));
      assert.deepEqual(commercial.body.map((c) => c.id), [chantiers.vendu.id]);
      sansMontant(commercial.body, 'commercial');
      assert.deepEqual((await historique(jetons.responsable)).body.map((c) => c.id), [chantiers.collegue.id]);
      // L'administration voit tous les chantiers reliés à la fiche, sauf l'annulé, sans montant non plus.
      const admin = await historique(auth);
      assert.equal(admin.status, 200);
      assert.deepEqual(admin.body.map((c) => c.id), [chantiers.enCours.id, chantiers.collegue.id, chantiers.vendu.id, chantiers.termine.id]);
      sansMontant(admin.body, 'administration');
      // Le conducteur lit les clients depuis le 16-10-2026 : il ne voit que le chantier dont il est chargé.
      const conducteur = await historique(jetons.conducteur);
      assert.equal(conducteur.status, 200, JSON.stringify(conducteur.body));
      assert.deepEqual(conducteur.body.map((c) => c.id), [chantiers.vendu.id]);
      sansMontant(conducteur.body, 'conducteur');
      // Sans l'annuaire (clients:read), pas d'historique ; un client inconnu répond 404.
      assert.equal((await historique(jetons.directeur)).status, 403);
      assert.equal((await request(app).get('/api/clients/00000000-0000-0000-0000-000000000000/chantiers').set(auth)).status, 404);
    });

    test('les clients désactivés sont fermés au technicien, en liste comme à l’unité', async () => {
      const desactive = await prisma.client.create({ data: { raisonSociale: 'TEST Annuaire client désactivé', actif: false } });
      // Liste : le filtre « désactivés » est ignoré pour lui, qui ne reçoit que des clients actifs.
      const liste = await request(app).get('/api/clients?actif=false&q=Annuaire').set(jetons.technicien);
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      assert.equal(liste.body.clients.some((c) => c.id === desactive.id), false);
      assert.ok(liste.body.clients.every((c) => c.actif === true));
      assert.ok(liste.body.clients.some((c) => c.id === client.id), 'les clients actifs restent listés');
      assert.equal((await request(app).get(`/api/clients/${desactive.id}`).set(jetons.technicien)).status, 404);
      assert.equal((await request(app).get(`/api/clients/${desactive.id}/chantiers`).set(jetons.technicien)).status, 404);
      // Témoins : l'administration les voit, et un autre porteur de clients:read aussi.
      assert.ok((await request(app).get('/api/clients?actif=false&q=Annuaire').set(auth)).body.clients.some((c) => c.id === desactive.id));
      assert.equal((await request(app).get(`/api/clients/${desactive.id}`).set(auth)).status, 200);
      assert.equal((await request(app).get(`/api/clients/${desactive.id}/chantiers`).set(auth)).status, 200);
      assert.equal((await request(app).get(`/api/clients/${desactive.id}`).set(jetons.commercial)).status, 200);
    });

    test('l’historique des chantiers d’un client n’est pas ouvert aux clés d’intégration', async () => {
      const creation = await request(app).post('/api/admin/api-keys').set(auth).send({ nom: 'TEST agent annuaire', scopes: ['clients:read', 'chantiers:read'] });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const cle = { Authorization: `Bearer ${creation.body.apiKey}` };
      // Témoin : la clé lit bien la fiche client par sa porte.
      assert.equal((await request(app).get(`/api/v1/clients/${client.id}`).set(cle)).status, 200);
      assert.equal((await request(app).get(`/api/clients/${client.id}/chantiers`).set(cle)).status, 401);
      assert.equal((await request(app).get(`/api/v1/clients/${client.id}/chantiers`).set(cle)).status, 404);
    });
  });

  // Base vierge : les réglages uniques (paramètres, société) se créent à leur première lecture.
  // Des premières requêtes simultanées, ou une requête arrivée pendant le démarrage, ne doivent
  // pas échouer sur leur création concurrente (l'administration plantait au premier chargement).
  describe('Réglages uniques créés à la première lecture', () => {
    let session = '';
    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
    });

    test('des premières requêtes simultanées et le démarrage réussissent sans réglages enregistrés', async () => {
      const societe = await prisma.companySettings.findUnique({ where: { id: 'singleton' } });
      const parametres = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      try {
        for (let essai = 1; essai <= 5; essai++) {
          await prisma.companySettings.deleteMany({ where: { id: 'singleton' } });
          await prisma.parametres.deleteMany({ where: { id: 'singleton' } });
          // Plusieurs initDb simultanés : sans eux, le premier gagnerait toujours la création
          // (il part avant l'authentification des requêtes) et sa relance ne serait pas éprouvée.
          const resultats = await Promise.all([
            ...Array.from({ length: 3 }, () => initDb().then(() => 'ok', (error) => error)),
            ...Array.from({ length: 8 }, () => request(app).get('/api/chantiers').set('Authorization', `Bearer ${session}`)),
          ]);
          const demarrages = resultats.slice(0, 3);
          const reponses = resultats.slice(3);
          assert.deepEqual(demarrages, ['ok', 'ok', 'ok'], `essai ${essai} : démarrage`);
          assert.deepEqual(reponses.map((r) => r.status), Array(8).fill(200), `essai ${essai} : ${JSON.stringify(reponses.find((r) => r.status !== 200)?.body)}`);
        }
        assert.equal(await prisma.companySettings.count(), 1);
        assert.equal(await prisma.parametres.count(), 1);
      } finally {
        if (parametres) await prisma.parametres.upsert({ where: { id: 'singleton' }, create: parametres, update: parametres });
        if (societe) await prisma.companySettings.upsert({ where: { id: 'singleton' }, create: societe, update: societe });
      }
    });
  });

  describe('Catalogue', () => {
    let session = '';
    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
    });

    test('une famille inconnue renvoie 404', async () => {
      const res = await request(app).get('/api/catalogue/voitures').set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 404);
    });

    test('une référence en double est refusée par un 409', async () => {
      const envoi = () => request(app).post('/api/catalogue/articles')
        .set('Authorization', `Bearer ${session}`)
        .send({ reference: 'TEST-DOUBLON', nom: 'Article', prixVenteHt: '10' });
      assert.equal((await envoi()).status, 201);
      assert.equal((await envoi()).status, 409);
    });

    test('la désactivation conserve la fiche', async () => {
      const creation = await request(app).post('/api/catalogue/equipements')
        .set('Authorization', `Bearer ${session}`)
        .send({ reference: 'TEST-CAM-01', nom: 'Caméra dôme', fabricant: 'Hikvision', prixVenteHt: '199' });
      assert.equal(creation.status, 201);
      const res = await request(app).delete(`/api/catalogue/equipements/${creation.body.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.actif, false);
    });
  });

  // Lot pilote 2 (décision A8 du 16-10-2026) : les lignes d'un devis se reprennent du catalogue
  // et y sont COPIÉES, figées ; le prix d'achat prévu est facultatif et réservé aux
  // administrateurs (choix par défaut, à confirmer).
  describe('Catalogue dans les devis (lot pilote 2)', () => {
    const suffixe = `${Date.now()}`;
    let admin = {};
    let commercial = {};
    let clientId = '';
    let devisId = '';
    const fiches = {};
    const lignesEnBase = (id) => prisma.devisLigne.findMany({ where: { devisId: id }, orderBy: { ordre: 'asc' } });
    // Le corps est calculé AVANT la requête : `request(app)` ouvre un serveur éphémère, qu'une
    // exception levée en construisant le corps laisserait ouvert, bloquant la fin des tests.
    const envoyer = (methode, chemin, enTete, corps) => request(app)[methode](chemin).set(enTete).send(corps);

    before(async () => {
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      admin = { Authorization: `Bearer ${secours.body.token}` };
      const compte = await prisma.user.create({ data: { email: 'catalogue.devis.commercial@iris.test', name: 'TEST Commercial catalogue', role: 'COMMERCIAL' } });
      commercial = { Authorization: `Bearer ${jwt.sign({ id: compte.id }, process.env.JWT_SECRET)}` };
      const client = await request(app).post('/api/clients').set(admin).send({ raisonSociale: 'TEST Client catalogue devis' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      clientId = client.body.id;
      const creer = async (famille, corps) => {
        const fiche = await request(app).post(`/api/catalogue/${famille}`).set(admin).send(corps);
        assert.equal(fiche.status, 201, JSON.stringify(fiche.body));
        return fiche.body;
      };
      fiches.pose = await creer('prestations', { reference: `TEST-CAT-POSE-${suffixe}`, nom: `Pose catalogue ${suffixe}`, unite: 'forfait', prixVenteHt: '250', tauxTva: '20', prixAchatHt: '90' });
      fiches.cable = await creer('articles', { reference: `TEST-CAT-CABLE-${suffixe}`, nom: `Câble catalogue ${suffixe}`, unite: 'm', prixVenteHt: '2.50', tauxTva: '20', prixAchatHt: '0.80' });
      fiches.camera = await creer('equipements', { reference: `TEST-CAT-CAM-${suffixe}`, nom: `Caméra catalogue ${suffixe}`, prixVenteHt: '199', tauxTva: '20', prixAchatHt: '120' });
      fiches.retiree = await creer('articles', { reference: `TEST-CAT-OLD-${suffixe}`, nom: `Article retiré catalogue ${suffixe}`, prixVenteHt: '5' });
      assert.equal((await request(app).delete(`/api/catalogue/articles/${fiches.retiree.id}`).set(admin)).status, 200);
    });

    test('recherche : fiches actives seulement, prix d’achat aux seuls administrateurs, refusée sans droit devis', async () => {
      const recherche = (enTete, query) => request(app).get('/api/devis/catalogue').query(query).set(enTete);
      const pourCommercial = await recherche(commercial, { q: suffixe });
      assert.equal(pourCommercial.status, 200, JSON.stringify(pourCommercial.body));
      assert.deepEqual(pourCommercial.body.map((f) => f.reference).sort(), [fiches.cable.reference, fiches.camera.reference, fiches.pose.reference].sort(), 'la fiche désactivée n’est pas proposée');
      assert.ok(pourCommercial.body.every((f) => !('prixAchatHt' in f)), 'aucun prix d’achat pour un commercial');
      const pose = pourCommercial.body.find((f) => f.id === fiches.pose.id);
      assert.deepEqual([pose.famille, pose.nature, pose.unite, pose.prixVenteHt, pose.tauxTva], ['prestations', 'MAIN_OEUVRE', 'forfait', 250, 20]);
      const camera = pourCommercial.body.find((f) => f.id === fiches.camera.id);
      assert.deepEqual([camera.famille, camera.nature, camera.unite], ['equipements', 'FOURNITURE', null]);
      const pourAdmin = await recherche(admin, { q: suffixe });
      assert.deepEqual(Object.fromEntries(pourAdmin.body.map((f) => [f.reference, f.prixAchatHt])), {
        [fiches.pose.reference]: 90, [fiches.cable.reference]: 0.8, [fiches.camera.reference]: 120,
      });
      assert.deepEqual((await recherche(commercial, { q: suffixe, famille: 'articles' })).body.map((f) => f.id), [fiches.cable.id]);
      assert.equal((await recherche(commercial, { famille: 'voitures' })).status, 400);
      assert.equal((await request(app).get('/api/devis/catalogue')).status, 401);
      for (const [qui, role] of [['technicien', 'TECHNICIEN'], ['conducteur', 'CONDUCTEUR_TRAVAUX']]) {
        const compte = await prisma.user.create({ data: { email: `catalogue.devis.${qui}@iris.test`, name: `TEST ${qui} catalogue`, role } });
        const refus = await recherche({ Authorization: `Bearer ${jwt.sign({ id: compte.id }, process.env.JWT_SECRET)}` }, { q: suffixe });
        assert.equal(refus.status, 403, qui);
      }
    });

    test('catalogue par clé d’intégration : prix d’achat des fiches seulement avec finances:read', async () => {
      const cle = async (scopes) => (await request(app).post('/api/admin/api-keys').set(admin).send({ nom: `TEST catalogue prix ${scopes.join(' ')}`, scopes })).body.apiKey;
      const lecteur = await cle(['catalogue:read', 'devis:read']);
      const financier = await cle(['catalogue:read', 'finances:read']);
      const redacteur = await cle(['catalogue:write']);
      const liste = async (secret, famille) => request(app).get(`/api/v1/catalogue/${famille}`).set('Authorization', `Bearer ${secret}`);
      for (const famille of ['prestations', 'articles', 'equipements']) {
        const sansFinance = await liste(lecteur, famille);
        assert.equal(sansFinance.status, 200, JSON.stringify(sansFinance.body));
        assert.ok(sansFinance.body.length > 0 && sansFinance.body.every((f) => !('prixAchatHt' in f)), `${famille} : prix d’achat masqué sans finances:read`);
        const avecFinance = await liste(financier, famille);
        assert.ok(avecFinance.body.some((f) => f.prixAchatHt != null), `${famille} : prix d’achat lu avec finances:read`);
      }
      const creation = await request(app).post('/api/v1/catalogue/articles').set('Authorization', `Bearer ${redacteur}`)
        .send({ reference: `TEST-CAT-CLE-${suffixe}`, nom: `Article par clé ${suffixe}`, prixVenteHt: '3', prixAchatHt: '1' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.ok(!('prixAchatHt' in creation.body), 'réponse de création masquée sans finances:read');
      assert.equal((await prisma.catalogueArticle.findUnique({ where: { id: creation.body.id } })).prixAchatHt.toString(), '1');
      const pourAdmin = await request(app).get('/api/catalogue/articles').set(admin);
      assert.equal(pourAdmin.body.find((f) => f.id === creation.body.id).prixAchatHt, 1, 'l’administration le voit');
    });

    // Le parc joint le modèle du catalogue à chaque équipement : son prix d'achat suit la même règle.
    test('parc d’équipements par clé d’intégration : prix d’achat du modèle seulement avec finances:read', async () => {
      const cle = async (scopes) => (await request(app).post('/api/admin/api-keys').set(admin).send({ nom: `TEST parc prix ${scopes.join(' ')}`, scopes })).body.apiKey;
      const parc = { Authorization: `Bearer ${await cle(['equipements:read', 'equipements:write', 'devis:read'])}` };
      const financier = { Authorization: `Bearer ${await cle(['equipements:read', 'finances:read'])}` };
      const site = await envoyer('post', `/api/clients/${clientId}/sites`, admin, { nom: 'TEST Site catalogue', adresse: '1 rue du Parc', codePostal: '14000', ville: 'Caen', estSiteIntervention: true });
      assert.equal(site.status, 201, JSON.stringify(site.body));
      const chemin = `/api/v1/clients/${clientId}/equipements`;
      const creation = await envoyer('post', chemin, parc, { catalogueEquipementId: fiches.camera.id, clientSiteId: site.body.id, numeroSerie: `TEST-SN-CAT-${suffixe}` });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.catalogueEquipement.reference, fiches.camera.reference);
      assert.ok(!('prixAchatHt' in creation.body.catalogueEquipement), 'création : prix d’achat du modèle masqué sans finances:read');
      const liste = await request(app).get(chemin).set(parc);
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      assert.ok(liste.body.length > 0 && liste.body.every((e) => e.catalogueEquipement && !('prixAchatHt' in e.catalogueEquipement)), 'liste : masqué sans finances:read');
      const archive = await request(app).post(`${chemin}/${creation.body.id}/archiver`).set(parc);
      assert.equal(archive.status, 200, JSON.stringify(archive.body));
      assert.equal(archive.body.statut, 'ARCHIVE');
      assert.ok(!('prixAchatHt' in archive.body.catalogueEquipement), 'archivage : masqué sans finances:read');
      const pourFinancier = await request(app).get(chemin).query({ inclureArchives: 'true' }).set(financier);
      assert.equal(pourFinancier.body.find((e) => e.id === creation.body.id).catalogueEquipement.prixAchatHt, '120', 'lu avec finances:read');
      const pourAdmin = await request(app).get(`/api/clients/${clientId}/equipements`).query({ inclureArchives: 'true' }).set(admin);
      assert.equal(pourAdmin.body.find((e) => e.id === creation.body.id).catalogueEquipement.prixAchatHt, '120', 'l’administration le voit');
    });

    test('une ligne reprise est copiée : référence recopiée par le serveur, prix d’achat repris de la fiche et masqué au commercial', async () => {
      const creation = await request(app).post('/api/devis').set(commercial).send({ clientId, objet: `TEST Devis catalogue ${suffixe}`, lignes: [
        { designation: fiches.camera.nom, nature: 'FOURNITURE', quantite: '2', prixUnitaireHt: '180', tauxTva: '20', unite: 'pièce', catalogueFamille: 'equipements', catalogueId: fiches.camera.id },
        { designation: 'Déplacement', quantite: '1', prixUnitaireHt: '50', tauxTva: '20' },
      ] });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      devisId = creation.body.id;
      assert.deepEqual([creation.body.totalHt, creation.body.totalTtc], [410, 492]);
      const [camera, deplacement] = creation.body.lignes;
      assert.deepEqual([camera.reference, camera.unite, camera.catalogueFamille, camera.catalogueId, camera.prixUnitaireHt], [fiches.camera.reference, 'pièce', 'equipements', fiches.camera.id, 180]);
      assert.deepEqual([deplacement.reference, deplacement.catalogueFamille, deplacement.unite], [null, null, null]);
      assert.ok(creation.body.lignes.every((l) => !('prixAchatUnitaireHt' in l)), 'prix d’achat masqué dans la réponse du commercial');
      assert.deepEqual((await lignesEnBase(devisId)).map((l) => l.prixAchatUnitaireHt?.toString() ?? null), ['120', null], 'prix d’achat de la fiche copié en base');
      const vueAdmin = (await request(app).get('/api/devis').set(admin)).body.find((d) => d.id === devisId);
      assert.deepEqual(vueAdmin.lignes.map((l) => l.prixAchatUnitaireHt), [120, null]);
      const vueCommercial = (await request(app).get('/api/devis').set(commercial)).body.find((d) => d.id === devisId);
      assert.ok(vueCommercial.lignes.every((l) => !('prixAchatUnitaireHt' in l)));
      // La référence vient de la fiche, jamais de la saisie.
      const autre = await request(app).post('/api/devis').set(commercial).send({ clientId, objet: `TEST Devis référence ${suffixe}`, lignes: [
        { designation: 'Câble', nature: 'FOURNITURE', quantite: '10', prixUnitaireHt: '2.50', reference: 'FAUSSE-REF', catalogueFamille: 'articles', catalogueId: fiches.cable.id },
        { designation: 'Ligne libre', quantite: '1', prixUnitaireHt: '1', reference: 'FAUSSE-REF' },
      ] });
      assert.equal(autre.status, 201, JSON.stringify(autre.body));
      assert.deepEqual(autre.body.lignes.map((l) => l.reference), [fiches.cable.reference, null]);
      for (const ligne of [
        { designation: 'Fiche inconnue', quantite: '1', prixUnitaireHt: '1', catalogueFamille: 'articles', catalogueId: 'inconnue' },
        { designation: 'Mauvaise famille', quantite: '1', prixUnitaireHt: '1', catalogueFamille: 'prestations', catalogueId: fiches.cable.id },
        { designation: 'Fiche retirée', quantite: '1', prixUnitaireHt: '1', catalogueFamille: 'articles', catalogueId: fiches.retiree.id },
      ]) {
        const refus = await request(app).post('/api/devis').set(commercial).send({ clientId, objet: 'TEST Devis refusé', lignes: [ligne] });
        assert.equal(refus.status, 400, ligne.designation);
        assert.match(refus.body.error, /Fiche catalogue introuvable ou désactivée/);
      }
    });

    test('la copie est figée : la fiche modifiée puis désactivée ne change rien au devis, la ligne existante garde sa fiche et son prix d’achat', async () => {
      const majFiche = await request(app).put(`/api/catalogue/equipements/${fiches.camera.id}`).set(admin)
        .send({ reference: `TEST-CAT-CAM2-${suffixe}`, nom: 'Caméra renommée', prixVenteHt: '260', tauxTva: '20', prixAchatHt: '150' });
      assert.equal(majFiche.status, 200, JSON.stringify(majFiche.body));
      assert.equal((await request(app).delete(`/api/catalogue/equipements/${fiches.camera.id}`).set(admin)).status, 200);
      const avant = (await request(app).get('/api/devis').set(commercial)).body.find((d) => d.id === devisId);
      assert.deepEqual([avant.lignes[0].designation, avant.lignes[0].reference, avant.lignes[0].prixUnitaireHt], [fiches.camera.nom, fiches.camera.reference, 180]);
      const maj = await envoyer('patch', `/api/devis/${devisId}`, commercial, { clientId, objet: `TEST Devis catalogue ${suffixe}`, lignes: [
        { ligneId: avant.lignes[0].id, designation: fiches.camera.nom, nature: 'FOURNITURE', quantite: '3', prixUnitaireHt: '180', tauxTva: '20', unite: 'pièce', catalogueFamille: 'equipements', catalogueId: fiches.camera.id },
        { designation: 'Déplacement', quantite: '1', prixUnitaireHt: '50', tauxTva: '20' },
      ] });
      assert.equal(maj.status, 200, JSON.stringify(maj.body));
      const [ligne] = await lignesEnBase(devisId);
      assert.deepEqual([ligne.reference, ligne.catalogueId, ligne.prixAchatUnitaireHt?.toString(), ligne.quantite.toString()], [fiches.camera.reference, fiches.camera.id, '120', '3']);
      const lignesActuelles = (await request(app).get('/api/devis').set(commercial)).body.find((d) => d.id === devisId).lignes;
      const autreDevis = (await request(app).get('/api/devis').set(commercial)).body.find((d) => d.id !== devisId && d.lignes.length);
      for (const [cas, lignes, attendu] of [
        ['fiche désactivée en nouvelle ligne', [{ designation: 'Caméra', nature: 'FOURNITURE', quantite: '1', prixUnitaireHt: '1', catalogueFamille: 'equipements', catalogueId: fiches.camera.id }], /désactivée/],
        ['ligne inconnue', [{ ligneId: 'inconnue', designation: 'X', quantite: '1', prixUnitaireHt: '1' }], /Ligne de devis inconnue/],
        ['ligne en double', [{ ligneId: lignesActuelles[0].id, designation: 'X', quantite: '1', prixUnitaireHt: '1' }, { ligneId: lignesActuelles[0].id, designation: 'Y', quantite: '1', prixUnitaireHt: '1' }], /Ligne de devis inconnue/],
        ['ligne d’un autre devis', [{ ligneId: autreDevis.lignes[0].id, designation: 'X', quantite: '1', prixUnitaireHt: '1' }], /Ligne de devis inconnue/],
      ]) {
        const refus = await envoyer('patch', `/api/devis/${devisId}`, commercial, { clientId, objet: 'TEST Devis refusé', lignes });
        assert.equal(refus.status, 400, cas);
        assert.match(refus.body.error, attendu, cas);
      }
      assert.equal((await lignesEnBase(devisId)).length, 2, 'un refus ne touche pas aux lignes');
    });

    test('prix d’achat prévu : écrit par un administrateur seulement, conservé par les autres, masqué partout ailleurs', async () => {
      const lignes = async (enTete) => (await request(app).get('/api/devis').set(enTete)).body.find((d) => d.id === devisId).lignes;
      const corps = (lignesSaisies) => ({ clientId, objet: `TEST Devis catalogue ${suffixe}`, lignes: lignesSaisies });
      // Chaque enregistrement recrée les lignes : leurs identifiants sont relus avant chaque envoi.
      let actuelles = await lignes(admin);
      const relire = async () => { actuelles = await lignes(admin); };
      const ligneCamera = (extra) => ({ ligneId: actuelles[0].id, designation: actuelles[0].designation, nature: 'FOURNITURE', quantite: '3', prixUnitaireHt: '180', unite: 'pièce', ...extra });
      const ligneDeplacement = (extra) => ({ ligneId: actuelles[1].id, designation: 'Déplacement', quantite: '1', prixUnitaireHt: '50', ...extra });
      for (const valeur of ['10', null]) {
        const refus = await envoyer('patch', `/api/devis/${devisId}`, commercial, corps([ligneCamera({ prixAchatUnitaireHt: valeur }), ligneDeplacement()]));
        assert.equal(refus.status, 403, String(valeur));
        assert.match(refus.body.error, /réservé aux administrateurs/);
      }
      assert.equal((await request(app).post('/api/devis').set(commercial).send(corps([{ designation: 'Libre', quantite: '1', prixUnitaireHt: '1', prixAchatUnitaireHt: '0.5' }]))).status, 403);
      const parAdmin = await envoyer('patch', `/api/devis/${devisId}`, admin, corps([ligneCamera({ prixAchatUnitaireHt: '75,40' }), ligneDeplacement({ prixAchatUnitaireHt: '12' })]));
      assert.equal(parAdmin.status, 200, JSON.stringify(parAdmin.body));
      assert.deepEqual(parAdmin.body.lignes.map((l) => l.prixAchatUnitaireHt), [75.4, 12]);
      await relire();
      const parCommercial = await envoyer('patch', `/api/devis/${devisId}`, commercial, corps([ligneCamera(), ligneDeplacement()]));
      assert.equal(parCommercial.status, 200, JSON.stringify(parCommercial.body));
      assert.ok(parCommercial.body.lignes.every((l) => !('prixAchatUnitaireHt' in l)), 'réponse du PATCH masquée au commercial');
      assert.deepEqual((await lignes(admin)).map((l) => l.prixAchatUnitaireHt), [75.4, 12], 'le commercial ne l’efface pas en modifiant le devis');
      await relire();
      const efface = await envoyer('patch', `/api/devis/${devisId}`, admin, corps([ligneCamera(), ligneDeplacement({ prixAchatUnitaireHt: null })]));
      assert.deepEqual(efface.body.lignes.map((l) => l.prixAchatUnitaireHt), [75.4, null], 'non transmis : conservé ; null : effacé');
      await relire();
      // Clés d'intégration : lecture avec finances:read seulement, jamais d'écriture.
      const cle = async (scopes) => (await request(app).post('/api/admin/api-keys').set(admin).send({ nom: `TEST catalogue devis ${scopes.join(' ')}`, scopes })).body.apiKey;
      const lecteur = await cle(['devis:read']);
      const financier = await cle(['devis:read', 'finances:read']);
      const ecrivain = await cle(['devis:write', 'finances:read']);
      const vue = async (secret) => (await request(app).get('/api/v1/devis').set('Authorization', `Bearer ${secret}`)).body.find((d) => d.id === devisId).lignes;
      assert.ok((await vue(lecteur)).every((l) => !('prixAchatUnitaireHt' in l)));
      assert.deepEqual((await vue(financier)).map((l) => l.prixAchatUnitaireHt), [75.4, null]);
      const ecriture = await envoyer('patch', `/api/v1/devis/${devisId}`, { Authorization: `Bearer ${ecrivain}` }, corps([ligneCamera({ prixAchatUnitaireHt: '1' }), ligneDeplacement()]));
      assert.equal(ecriture.status, 403);
      const redacteur = await cle(['devis:write']);
      const parCle = await envoyer('patch', `/api/v1/devis/${devisId}`, { Authorization: `Bearer ${redacteur}` }, corps([ligneCamera(), ligneDeplacement()]));
      assert.equal(parCle.status, 200, JSON.stringify(parCle.body));
      assert.ok(parCle.body.lignes.every((l) => !('prixAchatUnitaireHt' in l)), 'réponse du PATCH v1 masquée sans finances:read');
      assert.deepEqual((await lignes(admin)).map((l) => l.prixAchatUnitaireHt), [75.4, null], 'la clé ne l’efface pas');
      await relire();
      // Toute réponse de devis au commercial est masquée : changement de statut, duplication.
      const statut = await request(app).put(`/api/devis/${devisId}/statut`).set(commercial).send({ statut: 'ENVOYE' });
      assert.equal(statut.status, 200, JSON.stringify(statut.body));
      assert.ok(statut.body.lignes.every((l) => !('prixAchatUnitaireHt' in l)));
      const duplicata = await request(app).post(`/api/devis/${devisId}/duplication`).set(commercial);
      assert.equal(duplicata.status, 201, JSON.stringify(duplicata.body));
      assert.ok(duplicata.body.lignes.every((l) => !('prixAchatUnitaireHt' in l)));
      assert.deepEqual((await lignesEnBase(duplicata.body.id)).map((l) => [l.reference, l.unite, l.catalogueId, l.prixAchatUnitaireHt?.toString() ?? null]),
        [[fiches.camera.reference, 'pièce', fiches.camera.id, '75.4'], [null, null, null, null]], 'le duplicata reprend la copie et le prix d’achat');
    });

    test('révision et signature : la copie suit la révision, et la base fige les lignes et le contenu du devis signé', async () => {
      const signature = await request(app).post(`/api/devis/${devisId}/signature`).set(admin).send({ signataire: 'TEST Client signataire', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      const revision = await request(app).post(`/api/devis/${devisId}/revisions`).set(commercial);
      assert.equal(revision.status, 201, JSON.stringify(revision.body));
      assert.ok(revision.body.lignes.every((l) => !('prixAchatUnitaireHt' in l)), 'réponse de révision masquée au commercial');
      const revisionVueAdmin = (await request(app).get('/api/devis').set(admin)).body.find((d) => d.id === revision.body.id);
      assert.deepEqual(revisionVueAdmin.lignes.map((l) => [l.reference, l.unite, l.catalogueFamille, l.prixAchatUnitaireHt]),
        [[fiches.camera.reference, 'pièce', 'equipements', 75.4], [null, null, null, null]]);
      const [ligne] = await lignesEnBase(devisId);
      await assert.rejects(prisma.devisLigne.update({ where: { id: ligne.id }, data: { prixUnitaireHt: 1 } }), /lignes sont figées/);
      await assert.rejects(prisma.devisLigne.update({ where: { id: ligne.id }, data: { prixAchatUnitaireHt: 1 } }), /lignes sont figées/);
      await assert.rejects(prisma.devisLigne.delete({ where: { id: ligne.id } }), /lignes sont figées/);
      await assert.rejects(prisma.devisLigne.create({ data: { devisId, ordre: 9, designation: 'Ajout', quantite: 1, prixUnitaireHt: 1, tauxTva: 20, totalHt: 1, totalTtc: 1.2 } }), /lignes sont figées/);
      await assert.rejects(prisma.devis.update({ where: { id: devisId }, data: { totalHt: 1 } }), /sont figés/);
      await assert.rejects(prisma.devis.update({ where: { id: devisId }, data: { objet: 'Objet changé' } }), /sont figés/);
      await assert.rejects(prisma.devis.delete({ where: { id: devisId } }), /ne se supprime pas/);
      // La signature, sur laquelle repose le figement, est figée elle aussi : ni réécrite, ni supprimée
      // (on ne peut donc pas la retirer, modifier le devis, puis la recréer avec la même empreinte).
      await assert.rejects(prisma.devisSignature.update({ where: { devisId }, data: { empreinte: '0'.repeat(64) } }), /Signature de devis figée/);
      await assert.rejects(prisma.devisSignature.delete({ where: { devisId } }), /Signature de devis figée/);
      // Chaque vidage est tenté dans une transaction annulée : si le garde régressait, la base de
      // test ne serait pas réellement vidée sous les tests suivants.
      const vidageAnnule = (table) => prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`TRUNCATE "${table}"`);
        throw new Error(`vidage de ${table} accepté`);
      });
      for (const table of ['DevisLigne', 'DevisSignature']) await assert.rejects(vidageAnnule(table), /vidage interdit/, table);
      assert.ok(await prisma.devisSignature.findUnique({ where: { devisId } }), 'signature intacte');
      // Une ligne libre ne porte pas de référence (contrainte de cohérence).
      const revisionId = revision.body.id;
      await assert.rejects(prisma.devisLigne.create({ data: { devisId: revisionId, ordre: 9, designation: 'Libre', quantite: 1, prixUnitaireHt: 1, tauxTva: 20, totalHt: 1, totalTtc: 1.2, reference: 'REF-LIBRE' } }), /devis_ligne_catalogue_coherent/);
      // Le cycle de vie reste possible : seul le contenu est figé.
      await prisma.devis.update({ where: { id: devisId }, data: { acompteReference: 'TEST cycle de vie' } });
      assert.equal((await lignesEnBase(devisId)).length, 2);
    });
  });

  describe('Parc d’équipements installés', () => {
    let session = '';
    let clientId = '';
    let siteId = '';
    let modeleId = '';
    let equipementId = '';

    before(async () => {
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = secours.body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Parc client' });
      clientId = client.body.id;
      const site = await request(app).post(`/api/clients/${clientId}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site parc', adresse: '1 rue du Parc', codePostal: '14000', ville: 'Caen', estSiteIntervention: true });
      siteId = site.body.id;
      const modele = await request(app).post('/api/catalogue/equipements').set('Authorization', `Bearer ${session}`)
        .send({ reference: 'TEST-PARC-CAM', nom: 'Caméra parc', fabricant: 'Iris', prixVenteHt: 250 });
      modeleId = modele.body.id;
    });

    test('installe un équipement sérialisé chez un client et le relit avec sa garantie', async () => {
      const creation = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
        .send({ catalogueEquipementId: modeleId, clientSiteId: siteId, numeroSerie: 'TEST-SN-001', garantieJusquAu: '2028-09-01', notes: 'Baie principale' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.numeroSerie, 'TEST-SN-001');
      assert.equal(creation.body.statut, 'INSTALLE');
      assert.equal(creation.body.catalogueEquipement.reference, 'TEST-PARC-CAM');
      equipementId = creation.body.id;

      const parc = await request(app).get(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`);
      assert.equal(parc.status, 200);
      assert.equal(parc.body.length, 1);
      assert.equal(parc.body[0].clientSite.id, siteId);
      assert.equal(parc.body[0].garantieJusquAu.slice(0, 10), '2028-09-01');
    });

    // Date métier au format français : « 01-10-2026 » est le 1er octobre, en date-seule. `new Date`
    // la lisait comme le 10 janvier, à minuit du fuseau du serveur.
    test('lit une date d’installation JJ-MM-AAAA comme un jour civil', async () => {
      const creation = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
        .send({ catalogueEquipementId: modeleId, clientSiteId: siteId, numeroSerie: 'TEST-SN-DATE', installeLe: '01-10-2026', garantieJusquAu: '31-12-2028' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.installeLe, '2026-10-01T00:00:00.000Z');
      assert.equal(creation.body.garantieJusquAu, '2028-12-31T00:00:00.000Z');
      const invalide = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
        .send({ catalogueEquipementId: modeleId, clientSiteId: siteId, numeroSerie: 'TEST-SN-DATE-2', installeLe: '31-02-2026' });
      assert.equal(invalide.status, 400, JSON.stringify(invalide.body));
      // Une date-heure reçue par l'API retient la date telle qu'elle est écrite, avec ou sans
      // décalage (décisions de Nelson du 14-10-2026 et, pour le décalage, du 15-10-2026).
      // La forme renvoyée par l'API elle-même (…T00:00:00.000Z) et une heure sans secondes
      // sont acceptées.
      const horodatee = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
        .send({ catalogueEquipementId: modeleId, clientSiteId: siteId, numeroSerie: 'TEST-SN-DATE-3', installeLe: '2026-10-01T23:30:00-10:00', garantieJusquAu: '2028-12-31T22:30:00Z' });
      assert.equal(horodatee.status, 201, JSON.stringify(horodatee.body));
      assert.equal(horodatee.body.installeLe, '2026-10-01T00:00:00.000Z');
      assert.equal(horodatee.body.garantieJusquAu, '2028-12-31T00:00:00.000Z');
      // Sans décalage, ou avec un décalage écrit ±HHMM, la date est retenue de même. Une heure
      // invalide est refusée.
      const sansDecalage = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
        .send({ catalogueEquipementId: modeleId, clientSiteId: siteId, numeroSerie: 'TEST-SN-DATE-4', installeLe: '2026-10-01T23:30:00', garantieJusquAu: '2028-12-31T23:30:00+1400' });
      assert.equal(sansDecalage.status, 201, JSON.stringify(sansDecalage.body));
      assert.equal(sansDecalage.body.installeLe, '2026-10-01T00:00:00.000Z');
      assert.equal(sansDecalage.body.garantieJusquAu, '2028-12-31T00:00:00.000Z');
      const formes = [];
      for (const [installeLe, numeroSerie] of [['2026-10-01T00:00:00.000Z', 'TEST-SN-DATE-6'], ['2026-10-01T10:00Z', 'TEST-SN-DATE-7'], ['2026-10-01T10:00+02:00', 'TEST-SN-DATE-8']]) {
        const forme = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
          .send({ catalogueEquipementId: modeleId, clientSiteId: siteId, numeroSerie, installeLe });
        assert.equal(forme.status, 201, `${installeLe} : ${JSON.stringify(forme.body)}`);
        assert.equal(forme.body.installeLe, '2026-10-01T00:00:00.000Z', installeLe);
        formes.push(forme.body.id);
      }
      for (const installeLe of ['2026-10-01T99:99Z', '2026-10-01T10:60Z', '2026-10-01T24:00Z', '2026-10-01T23:59:60Z', '2026-10-01T10:00+24:00', '2026-10-01T10:00+14:60']) {
        const heureInvalide = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
          .send({ catalogueEquipementId: modeleId, clientSiteId: siteId, numeroSerie: 'TEST-SN-DATE-5', installeLe });
        assert.equal(heureInvalide.status, 400, `${installeLe} : ${JSON.stringify(heureInvalide.body)}`);
      }
      await prisma.equipementInstalle.deleteMany({ where: { id: { in: [creation.body.id, horodatee.body.id, sansDecalage.body.id, ...formes] } } });
    });

    test('refuse un équipement rattaché au site d’un autre client', async () => {
      const autre = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Autre client parc' });
      const autreSite = await request(app).post(`/api/clients/${autre.body.id}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site autre client', adresse: '2 rue des Tests', codePostal: '14000', ville: 'Caen' });
      const res = await request(app).post(`/api/clients/${clientId}/equipements`).set('Authorization', `Bearer ${session}`)
        .send({ catalogueEquipementId: modeleId, clientSiteId: autreSite.body.id, numeroSerie: 'TEST-SN-002' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /site/i);
    });

    test('archive sans supprimer l’équipement ni son numéro de série', async () => {
      const archive = await request(app).post(`/api/clients/${clientId}/equipements/${equipementId}/archiver`).set('Authorization', `Bearer ${session}`);
      assert.equal(archive.status, 200);
      assert.equal(archive.body.statut, 'ARCHIVE');
      assert.equal(archive.body.numeroSerie, 'TEST-SN-001');

      const parc = await request(app).get(`/api/clients/${clientId}/equipements?inclureArchives=true`).set('Authorization', `Bearer ${session}`);
      assert.equal(parc.status, 200);
      assert.equal(parc.body.some((e) => e.id === equipementId && e.statut === 'ARCHIVE'), true);
    });
  });

  describe('Devis versionnés', () => {
    let session = '';
    let clientId = '';
    let devisId = '';
    let dossierId = '';
    let numero = '';

    before(async () => {
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = secours.body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Client devis' });
      clientId = client.body.id;
    });

    test('crée un brouillon de devis avec ses lignes et ses totaux calculés', async () => {
      const res = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Installation contrôle d’accès',
        lignes: [{ designation: 'Pose lecteur', quantite: 2, prixUnitaireHt: 120, tauxTva: 20 }],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.version, 1);
      assert.equal(res.body.statut, 'BROUILLON');
      assert.equal(res.body.totalHt, 240);
      assert.equal(res.body.totalTtc, 288);
      assert.match(res.body.numero, /^A\d{2}-\d{4,}$/);
      devisId = res.body.id;
      dossierId = res.body.dossierId;
      numero = res.body.numero;
    });

    test('modifie un devis non signé et recalcule ses totaux côté serveur', async () => {
      const res = await request(app).patch(`/api/devis/${devisId}`).set('Authorization', `Bearer ${session}`).send({
        clientId,
        objet: 'Installation contrôle d’accès révisée',
        acompteExige: true,
        tauxAcompte: 30,
        lignes: [{ designation: 'Pose lecteur révisée', nature: 'MAIN_OEUVRE', quantite: 3, prixUnitaireHt: 100, tauxTva: 20 }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.objet, 'Installation contrôle d’accès révisée');
      assert.equal(res.body.acompteExige, true);
      assert.equal(res.body.tauxAcompte, 30);
      assert.equal(res.body.lignes[0].designation, 'Pose lecteur révisée');
      assert.equal(res.body.totalHt, 300);
      assert.equal(res.body.totalTva, 60);
      assert.equal(res.body.totalTtc, 360);
    });

    // Témoin d'audit : ces refus ne sont pas des variantes du parcours nominal. Ils
    // séparent explicitement la révision (qui exige une signature), la conversion (qui
    // la rend ensuite irréversible), l'identité du client externe et l'auteur interne.
    test('préserve les invariants de signature, révision, conversion et acompte', async () => {
      const lignes = [{ designation: 'Pose témoin', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }];
      const clientInvalide = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId: 'client-inexistant', objet: 'Client invalide', lignes,
      });
      assert.equal(clientInvalide.status, 400, JSON.stringify(clientInvalide.body));
      assert.match(clientInvalide.body.error, /client introuvable/i);

      const brouillon = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Témoin invariants', acompteExige: true, tauxAcompte: 35, lignes,
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const revisionNonSignee = await request(app).post(`/api/devis/${brouillon.body.id}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(revisionNonSignee.status, 409, JSON.stringify(revisionNonSignee.body));
      assert.match(revisionNonSignee.body.error, /signé/i);

      const patchOmis = await request(app).patch(`/api/devis/${brouillon.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Témoin invariants modifié', lignes: [{ ...lignes[0], designation: 'Pose témoin modifiée' }],
      });
      assert.equal(patchOmis.status, 200, JSON.stringify(patchOmis.body));
      assert.equal(patchOmis.body.acompteExige, true, 'un PATCH sans acompteExige conserve la condition négociée');
      assert.equal(patchOmis.body.tauxAcompte, 35, 'un PATCH sans tauxAcompte conserve le taux négocié');

      const signataireInvalide = await request(app).post(`/api/devis/${brouillon.body.id}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'A', confirme: true });
      assert.equal(signataireInvalide.status, 400, JSON.stringify(signataireInvalide.body));
      assert.match(signataireInvalide.body.error, /signataire/i);

      const signature = await request(app).post(`/api/devis/${brouillon.body.id}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'Claire Cliente', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      assert.ok(signature.body.enregistreParId, 'l’employé de la session est le seul auteur interne enregistré');
      const acompte = await request(app).post(`/api/devis/${brouillon.body.id}/acompte`).set('Authorization', `Bearer ${session}`)
        .send({ recuLe: '01-09-2026', montant: 42, reference: 'VIR TÉMOIN' });
      assert.equal(acompte.status, 200, JSON.stringify(acompte.body));
      const conversion = await request(app).post(`/api/devis/${brouillon.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
      const revisionConvertie = await request(app).post(`/api/devis/${brouillon.body.id}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(revisionConvertie.status, 409, JSON.stringify(revisionConvertie.body));
      assert.match(revisionConvertie.body.error, /converti/i);

      for (const statut of ['REFUSE', 'ANNULE']) {
        const devisTerminal = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({ clientId, objet: `Signature ${statut}`, lignes });
        assert.equal(devisTerminal.status, 201, JSON.stringify(devisTerminal.body));
        if (statut === 'REFUSE') {
          const envoi = await request(app).put(`/api/devis/${devisTerminal.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
          assert.equal(envoi.status, 200, JSON.stringify(envoi.body));
          const refus = await request(app).put(`/api/devis/${devisTerminal.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut });
          assert.equal(refus.status, 200, JSON.stringify(refus.body));
        } else {
          const annulation = await request(app).post(`/api/devis/${devisTerminal.body.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'Témoin audit' });
          assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
        }
        const signatureTerminale = await request(app).post(`/api/devis/${devisTerminal.body.id}/signature`).set('Authorization', `Bearer ${session}`)
          .send({ signataire: 'Claire Cliente', confirme: true });
        assert.equal(signatureTerminale.status, 409, JSON.stringify(signatureTerminale.body));
        assert.match(signatureTerminale.body.error, /ne peut plus être signé/i);
      }
    });

    test('garantit HT + TVA = TTC avec un taux réduit', async () => {
      const res = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({ clientId, objet: 'Rénovation', lignes: [{ designation: 'Fourniture posée', quantite: 1, prixUnitaireHt: 5, tauxTva: 5.5 }] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.totalHt + res.body.totalTva, res.body.totalTtc);
      assert.equal(res.body.totalTtc, 5.28);
    });

    test('refuse les précisions incompatibles avec les unités monétaires sans erreur interne', async () => {
      const res = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Précision invalide',
        lignes: [{ designation: 'Quantité à quatre décimales', quantite: '0.3333', prixUnitaireHt: '4.27', tauxTva: '5.5' }],
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error, 'Ligne de devis invalide.');
    });

    test('fige un devis signé avec confirmation, signataire et empreinte déterministe', async () => {
      const sansConfirmation = await request(app).post(`/api/devis/${devisId}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'Alice Martin', confirme: false });
      assert.equal(sansConfirmation.status, 400, JSON.stringify(sansConfirmation.body));

      const signature = await request(app).post(`/api/devis/${devisId}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'Alice Martin', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      assert.equal(signature.body.signataire, 'Alice Martin');
      assert.ok(signature.body.enregistreParId, 'la session humaine qui enregistre la signature est conservée');
      assert.ok(signature.body.signeLe);
      const devisSigne = await request(app).get('/api/devis').set('Authorization', `Bearer ${session}`);
      assert.equal(devisSigne.status, 200, JSON.stringify(devisSigne.body));
      assert.equal(devisSigne.body.find((devis) => devis.id === devisId).statut, 'ACCEPTE');
      const contenu = {
        devisId,
        dossierId,
        numero,
        version: 1,
        clientId,
        objet: 'Installation contrôle d’accès révisée',
        acompteExige: true,
        tauxAcompte: '30.00',
        totalHt: '300.00',
        totalTva: '60.00',
        totalTtc: '360.00',
        lignes: [{ ordre: 0, designation: 'Pose lecteur révisée', nature: 'MAIN_OEUVRE', reference: null, unite: null, quantite: '3.000', prixUnitaireHt: '100.00', tauxTva: '20.00', totalHt: '300.00', totalTtc: '360.00' }],
      };
      assert.equal(signature.body.empreinte, createHash('sha256').update(JSON.stringify(contenu), 'utf8').digest('hex'));
    });

    test('refuse de modifier la révision signée et crée une révision brouillon distincte', async () => {
      const interdit = await request(app).patch(`/api/devis/${devisId}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Modification interdite', lignes: [{ designation: 'Interdit', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }],
      });
      assert.equal(interdit.status, 409, JSON.stringify(interdit.body));
      assert.match(interdit.body.error, /signé/i);

      const res = await request(app).post(`/api/devis/${devisId}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.version, 2);
      assert.equal(res.body.statut, 'BROUILLON');
      assert.equal(res.body.dossierId, dossierId);
      assert.equal(res.body.numero, numero);
      const modifie = await request(app).patch(`/api/devis/${res.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Installation contrôle d’accès v2', acompteExige: false,
        lignes: [{ designation: 'Pose v2', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 200, tauxTva: 20 }],
      });
      assert.equal(modifie.status, 200, JSON.stringify(modifie.body));
      assert.equal(modifie.body.totalTtc, 240);
      const original = await request(app).get('/api/devis').set('Authorization', `Bearer ${session}`);
      assert.equal(original.body.find((d) => d.id === devisId).objet, 'Installation contrôle d’accès révisée');
    });

    test('fige l’acompte encaissé, le reporte dans la révision et protège la dernière version', async () => {
      const initial = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Acompte versionné', acompteExige: true, tauxAcompte: 25,
        lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }],
      });
      assert.equal(initial.status, 201, JSON.stringify(initial.body));
      const envoi = await request(app).put(`/api/devis/${initial.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      assert.equal(envoi.status, 200, JSON.stringify(envoi.body));
      const acceptationDirecte = await request(app).put(`/api/devis/${initial.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACCEPTE' });
      assert.equal(acceptationDirecte.status, 400, 'la signature est l’unique transition vers ACCEPTE');
      const signature = await request(app).post(`/api/devis/${initial.body.id}/signature`).set('Authorization', `Bearer ${session}`).send({ signataire: 'Alice Martin', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      assert.equal(signature.body.enregistreParId, (await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } })).id);
      const signatureMachine = await request(app).post(`/api/v1/devis/${initial.body.id}/signature`).set('Authorization', `Bearer ${cleApi}`).send({ signataire: 'Automate', confirme: true });
      assert.equal(signatureMachine.status, 404, 'une clé d’intégration ne peut pas signer un devis');
      const patchSigne = await request(app).patch(`/api/devis/${initial.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Modification signée interdite', lignes: [{ designation: 'Interdit', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }],
      });
      assert.equal(patchSigne.status, 409, 'un devis signé ne reste jamais éditable');
      const acompte = await request(app).post(`/api/devis/${initial.body.id}/acompte`).set('Authorization', `Bearer ${session}`)
        .send({ recuLe: '24-09-2026', montant: 30, reference: 'TEST-ACOMPTE-REVISION' });
      assert.equal(acompte.status, 200, JSON.stringify(acompte.body));
      const revision = await request(app).post(`/api/devis/${initial.body.id}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(revision.status, 201, JSON.stringify(revision.body));
      assert.equal(revision.body.acompteExige, true);
      assert.equal(revision.body.tauxAcompte, 25);
      assert.equal(revision.body.acompteMontant, 30);
      assert.equal(revision.body.acompteReference, 'TEST-ACOMPTE-REVISION');

      const patchSansTaux = await request(app).patch(`/api/devis/${revision.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Acompte versionné corrigé', acompteExige: false,
        lignes: [{ designation: 'Pose corrigée', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 }],
      });
      assert.equal(patchSansTaux.status, 200, JSON.stringify(patchSansTaux.body));
      assert.equal(patchSansTaux.body.acompteExige, true, 'un acompte encaissé ne peut plus être retiré');
      assert.equal(patchSansTaux.body.tauxAcompte, 25, 'un PATCH sans taux conserve le taux négocié');

      const revisionDeAncienne = await request(app).post(`/api/devis/${initial.body.id}/revisions`).set('Authorization', `Bearer ${session}`);
      assert.equal(revisionDeAncienne.status, 409, 'une version antérieure ne peut plus rouvrir une négociation');
      const conversionAncienne = await request(app).post(`/api/devis/${initial.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversionAncienne.status, 409, 'une version remplacée ne peut pas ouvrir une affaire');

      const refuse = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Devis refusé figé', lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      assert.equal(refuse.status, 201, JSON.stringify(refuse.body));
      await request(app).put(`/api/devis/${refuse.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      await request(app).put(`/api/devis/${refuse.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'REFUSE' });
      const patchRefuse = await request(app).patch(`/api/devis/${refuse.body.id}`).set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'Modification refusée interdite', lignes: [{ designation: 'Interdit', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }],
      });
      assert.equal(patchRefuse.status, 409, 'un devis refusé ne reste jamais éditable');
    });

    test('sérialise une seule signature concurrente', async () => {
      const devis = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Signature concurrente', lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      const reponses = await Promise.all(['Bob', 'Carole'].map(signataire => request(app).post(`/api/devis/${devis.body.id}/signature`)
        .set('Authorization', `Bearer ${session}`).send({ signataire, confirme: true })));
      assert.deepEqual(reponses.map(r => r.status).sort(), [201, 409]);
      assert.equal(await prisma.devisSignature.count({ where: { devisId: devis.body.id } }), 1);
    });

    test('sérialise la création concurrente d’une seule révision brouillon', async () => {
      const devis = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Révision concurrente', lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      await request(app).post(`/api/devis/${devis.body.id}/signature`).set('Authorization', `Bearer ${session}`).send({ signataire: 'Alice', confirme: true });
      const reponses = await Promise.all([1, 2].map(() => request(app).post(`/api/devis/${devis.body.id}/revisions`).set('Authorization', `Bearer ${session}`)));
      assert.deepEqual(reponses.map(r => r.status).sort(), [201, 409]);
      assert.equal(await prisma.devis.count({ where: { dossierId: devis.body.dossierId } }), 2);
    });

    test('ne crée un chantier qu’après signature humaine, avec la même référence affaire', async () => {
      const nonSigne = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST devis non signé', lignes: [{ designation: 'Ligne', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      assert.equal(nonSigne.status, 201, JSON.stringify(nonSigne.body));
      const avant = await request(app).post(`/api/devis/${nonSigne.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(avant.status, 400);
      const signature = await request(app).post(`/api/devis/${nonSigne.body.id}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'Alice Martin', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      const conversion = await request(app).post(`/api/devis/${nonSigne.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
      assert.equal(conversion.body.numeroDevis, nonSigne.body.numero);
      assert.ok((await prisma.chantier.findUnique({ where: { id: conversion.body.id } })).clientId, 'la conversion doit rattacher l’affaire à son client');
      const doublon = await request(app).post(`/api/devis/${nonSigne.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(doublon.status, 409, 'chaque affaire n’ouvre qu’un chantier');
    });

    test('refuse la création directe historique d’un chantier', async () => {
      const res = await request(app).post('/api/chantiers').set('Authorization', `Bearer ${session}`).send({ nom: 'TEST interdit' });
      assert.equal(res.status, 410);
    });

    // La référence d'affaire d'un chantier issu d'une conversion est celle qu'Iris émet
    // (A26-0001). Tant que la validation exigeait le format de l'ERP tiers (SXXXXX), ce
    // champ n'acceptait plus aucune valeur qu'Iris sache produire : le corriger était
    // impossible sur les chantiers créés par conversion.
    test('la référence d’affaire se corrige au format qu’Iris émet', async () => {
      // Affaire dédiée : le test modifie la référence, il ne peut donc pas emprunter
      // celle d'un autre test sans le rendre dépendant de l'ordre d'exécution.
      const devis = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`)
        .send({ clientId, objet: 'TEST Référence', lignes: [{ designation: 'L', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
      await request(app).put(`/api/devis/${devis.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      await request(app).post(`/api/devis/${devis.body.id}/signature`).set('Authorization', `Bearer ${session}`).send({ signataire: 'TEST Signataire interne', confirme: true });
      const conversion = await request(app).post(`/api/devis/${devis.body.id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });
      assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
      const chantier = conversion.body;
      assert.match(chantier.numeroDevis, /^A\d{2}-\d{4,}$/);

      const ancienFormat = await request(app).patch(`/api/chantiers/${chantier.id}`)
        .set('Authorization', `Bearer ${session}`).send({ numeroDevis: 'S00700' });
      assert.equal(ancienFormat.status, 400);

      const nouveau = `A${String(new Date().getFullYear()).slice(-2)}-9999`;
      const accepte = await request(app).patch(`/api/chantiers/${chantier.id}`)
        .set('Authorization', `Bearer ${session}`).send({ numeroDevis: nouveau });
      assert.equal(accepte.status, 200, JSON.stringify(accepte.body));
      assert.equal(accepte.body.numeroDevis, nouveau);
    });
  });

  // Iris n'interroge plus aucun ERP tiers : ces routes ont été retirées avec le module de
  // lecture externe et l'écran de rapprochement qu'elles alimentaient. Le test échoue si
  // l'une d'elles réapparaît par mégarde.
  describe('Retrait de l’intégration ERP tierce', () => {
    let session = '';
    before(async () => {
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = secours.body.token;
    });

    for (const route of [
      '/api/odoo/clients',
      '/api/odoo/devis',
      '/api/odoo/devis/1/materiel',
      '/api/odoo/devis/1/adresse',
      '/api/suivi-financier',
      '/api/suivi-financier/anciens',
    ]) {
      test(`${route} n’existe plus`, async () => {
        const res = await request(app).get(route).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 404, `${route} répond encore ${res.status}`);
      });
    }
  });

  describe('Permissions individuelles', () => {
    let superSession = '', conducteurSession = '', conducteurId = '', clientId = '';
    before(async () => {
      const jwt = (await import('jsonwebtoken')).default;
      await prisma.user.deleteMany({ where: { email: 'permissions@iris.test' } });
      const conducteur = await prisma.user.create({ data: { email: 'permissions@iris.test', name: 'TEST Permissions', role: 'CONDUCTEUR_TRAVAUX' } });
      conducteurId = conducteur.id;
      conducteurSession = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      superSession = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      clientId = (await request(app).post('/api/clients').set('Authorization', `Bearer ${superSession}`).send({ raisonSociale: 'TEST Client permissions' })).body.id;
    });

    test('refuse un devis sans permission, puis l’autorise après attribution individuelle', async () => {
      const corps = { clientId, objet: 'TEST Devis permission', lignes: [{ designation: 'Test', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] };
      assert.equal((await request(app).post('/api/devis').set('Authorization', `Bearer ${conducteurSession}`).send(corps)).status, 403);
      assert.equal((await request(app).get('/api/devis').set('Authorization', `Bearer ${conducteurSession}`)).status, 403);
      const avant = await request(app).get('/api/me').set('Authorization', `Bearer ${conducteurSession}`);
      assert.equal(avant.status, 200);
      assert.equal(avant.body.permissions.includes('devis:read'), false);
      const attribution = await request(app).put(`/api/users/${conducteurId}/permissions`).set('Authorization', `Bearer ${superSession}`).send({ permissions: ['devis:read', 'devis:write', 'clients:read'] });
      assert.equal(attribution.status, 200);
      const apres = await request(app).get('/api/me').set('Authorization', `Bearer ${conducteurSession}`);
      assert.equal(apres.body.permissions.includes('devis:read'), true);
      assert.equal((await request(app).get(`/api/clients/${clientId}`).set('Authorization', `Bearer ${conducteurSession}`)).status, 200);
      assert.equal((await request(app).post('/api/devis').set('Authorization', `Bearer ${conducteurSession}`).send(corps)).status, 201);
    });

    test('le conducteur lit les clients par son type de compte, sans les modifier (décision du 16-10-2026)', async () => {
      const auth = { Authorization: `Bearer ${conducteurSession}` };
      const conducteur = await prisma.user.findUniqueOrThrow({ where: { id: conducteurId } });
      // Sans permission individuelle, le droit vient du type de compte.
      if (conducteur.permissions.length) await prisma.user.update({ where: { id: conducteurId }, data: { permissions: [] } });
      const me = await request(app).get('/api/me').set(auth);
      assert.equal(me.status, 200);
      assert.deepEqual(me.body.permissions, ['chantiers:read', 'chantiers:write', 'clients:read']);
      // Recherche et fiche, comme dans le sélecteur de « Nouvelle intervention ».
      const recherche = await request(app).get(`/api/clients?q=${encodeURIComponent('TEST Client permissions')}`).set(auth);
      assert.equal(recherche.status, 200, JSON.stringify(recherche.body));
      assert.ok(recherche.body.clients.some((c) => c.id === clientId));
      assert.equal((await request(app).get(`/api/clients/${clientId}`).set(auth)).status, 200);
      // Aucune écriture dans l'annuaire, ni parc d'équipements, ni devis.
      const contact = await prisma.clientContact.create({ data: { clientId, nom: 'TEST Contact existant' } });
      const site = await prisma.clientSite.create({ data: { clientId, nom: 'TEST Site existant', adresse: '1 rue du Test', codePostal: '75001', ville: 'Paris' } });
      const refus = [
        ['création de client', () => request(app).post('/api/clients').set(auth).send({ raisonSociale: 'TEST Client par un conducteur' })],
        ['modification de client', () => request(app).put(`/api/clients/${clientId}`).set(auth).send({ raisonSociale: 'TEST Renommé par un conducteur' })],
        ['suppression de client', () => request(app).delete(`/api/clients/${clientId}`).set(auth)],
        ['création de contact', () => request(app).post(`/api/clients/${clientId}/contacts`).set(auth).send({ nom: 'TEST Contact conducteur' })],
        ['modification de contact', () => request(app).put(`/api/clients/${clientId}/contacts/${contact.id}`).set(auth).send({ nom: 'TEST Contact modifié par un conducteur' })],
        ['création de site', () => request(app).post(`/api/clients/${clientId}/sites`).set(auth).send({ nom: 'TEST Site conducteur', adresse: '2 rue du Test', codePostal: '75002', ville: 'Paris' })],
        ['modification de site', () => request(app).put(`/api/clients/${clientId}/sites/${site.id}`).set(auth).send({ nom: 'TEST Site modifié par un conducteur' })],
        ['parc d’équipements', () => request(app).get(`/api/clients/${clientId}/equipements`).set(auth)],
        ['devis', () => request(app).get('/api/devis').set(auth)],
      ];
      for (const [quoi, appel] of refus) assert.equal((await appel()).status, 403, quoi);
      assert.equal(await prisma.client.count({ where: { raisonSociale: { in: ['TEST Client par un conducteur', 'TEST Renommé par un conducteur'] } } }), 0);
      assert.equal(await prisma.client.count({ where: { id: clientId } }), 1);
      assert.equal(await prisma.clientContact.count({ where: { clientId, nom: { in: ['TEST Contact conducteur', 'TEST Contact modifié par un conducteur'] } } }), 0);
      assert.equal(await prisma.clientSite.count({ where: { clientId, nom: { in: ['TEST Site conducteur', 'TEST Site modifié par un conducteur'] } } }), 0);
      // L'historique du client ne montre que ses chantiers à lui, sans montant.
      const autre = await prisma.user.create({ data: { email: 'permissions.autre@iris.test', name: 'TEST Permissions autre conducteur', role: 'CONDUCTEUR_TRAVAUX' } });
      const sien = await prisma.chantier.create({ data: { nom: 'TEST Chantier client du conducteur', client: 'TEST Client permissions', clientId, responsableId: conducteurId, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const pasLeSien = await prisma.chantier.create({ data: { nom: 'TEST Chantier client d’un autre', client: 'TEST Client permissions', clientId, responsableId: autre.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const historique = await request(app).get(`/api/clients/${clientId}/chantiers`).set(auth);
      assert.equal(historique.status, 200, JSON.stringify(historique.body));
      assert.deepEqual(historique.body.map((c) => c.id), [sien.id]);
      assert.equal(historique.body.some((c) => c.id === pasLeSien.id), false);
      // Exactement les champs de l'historique, sans aucun montant ni référence d'affaire.
      assert.deepEqual(Object.keys(historique.body[0]).sort(), ['adresse', 'dateDebut', 'dateFin', 'id', 'nom', 'statut']);
      // Il crée l'intervention SAV de ce client.
      const intervention = await request(app).post('/api/interventions').set(auth).send({ clientId, titre: 'TEST Intervention créée par le conducteur' });
      assert.equal(intervention.status, 201, JSON.stringify(intervention.body));
    });

    test('/api/me expose les droits hérités du type de compte, pas seulement les individuels', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const commercial = await prisma.user.create({ data: { email: 'commercial.permissions@iris.test', name: 'TEST Commercial permissions', role: 'COMMERCIAL' } });
      const session = jwt.sign({ id: commercial.id }, process.env.JWT_SECRET);
      const me = await request(app).get('/api/me').set('Authorization', `Bearer ${session}`);
      assert.equal(me.status, 200);
      // La colonne individuelle est vide : ces droits viennent obligatoirement du type.
      assert.deepEqual(me.body.permissions, ['chantiers:read', 'clients:read', 'devis:read', 'devis:write']);
    });

    test('refuse une permission hors du vocabulaire', async () => {
      const res = await request(app).put(`/api/users/${conducteurId}/permissions`).set('Authorization', `Bearer ${superSession}`).send({ permissions: ['invente:write'] });
      assert.equal(res.status, 400);
    });
  });

  // Garde-fou du dernier super administrateur (#178) : seuls les comptes actifs comptent, et les
  // retraits (suppression, autre type, désactivation) se sérialisent par un verrou consultatif.
  describe('Dernier super administrateur actif', () => {
    const comptes = {};
    const EMAILS = ['dernier.super.a@iris.test', 'dernier.super.b@iris.test', 'dernier.super.admin@iris.test', 'dernier.super.responsable@iris.test', 'dernier.super.collaborateur@iris.test'];
    const jeton = (compte) => ({ Authorization: `Bearer ${jwt.sign({ id: compte.id }, process.env.JWT_SECRET)}` });
    const envoyer = (methode, chemin, enTete, corps) => {
      const requete = request(app)[methode](chemin).set(enTete);
      return corps === undefined ? requete : requete.send(corps);
    };
    const superAdminsActifs = async () => (await prisma.user.findMany({ where: { role: 'SUPERADMIN', actif: true }, select: { id: true } })).map((compte) => compte.id).sort();
    const entreesJournal = (cibleId) => prisma.journalAdministration.count({ where: { cibleId } });
    const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Sessions en attente d'un verrou de ligne, ou du verrou consultatif des retraits.
    const attentes = async (consultatif) => (await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND wait_event_type = 'Lock' AND (wait_event = 'advisory') = ${consultatif}`)[0].n;
    const attendreAttente = async (consultatif, nombre = 1) => {
      for (let tour = 0; tour < 150; tour += 1) {
        if (await attentes(consultatif) >= nombre) return true;
        await attendre(20);
      }
      return false;
    };
    const ROUTES = [
      ['suppression', 'delete', (id) => `/api/users/${id}`, undefined, 409, 'Impossible de révoquer le dernier compte super administrateur.'],
      ['rétrogradation', 'patch', (id) => `/api/users/${id}/role`, { role: 'ADMIN' }, 409, 'Impossible de retirer le rôle du dernier compte super administrateur.'],
      ['désactivation', 'patch', (id) => `/api/users/${id}/actif`, { actif: false }, 400, 'Ce compte est le dernier super administrateur : il ne peut pas être désactivé.'],
    ];
    const preparer = async () => {
      for (const cle of ['a', 'b']) {
        const email = `dernier.super.${cle}@iris.test`;
        comptes[cle] = await prisma.user.upsert({ where: { email }, update: { role: 'SUPERADMIN', actif: true }, create: { email, name: `TEST Dernier super ${cle.toUpperCase()}`, role: 'SUPERADMIN' } });
      }
    };
    // A et B sont les seuls super administrateurs actifs le temps du test : les autres, dont le compte
    // de secours, sont désactivés puis réactivés (le before() général réactive aussi le secours).
    const isoler = async (corps) => {
      await preparer();
      const suspendus = (await prisma.user.findMany({ where: { role: 'SUPERADMIN', actif: true, id: { notIn: [comptes.a.id, comptes.b.id] } }, select: { id: true } })).map((compte) => compte.id);
      await prisma.user.updateMany({ where: { id: { in: suspendus } }, data: { actif: false } });
      try {
        await corps();
      } finally {
        await prisma.user.updateMany({ where: { id: { in: suspendus } }, data: { actif: true } });
      }
    };
    // Une transaction de test tient un chantier : la suppression de son titulaire s'y arrête, après
    // son contrôle et en tenant le verrou des retraits. La seconde requête part alors ; le chantier
    // n'est libéré que lorsqu'elle attend un verrou ou a répondu.
    const pendantSuppressionArretee = async (titulaire, auteur, seconde) => {
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Dernier super chantier', client: 'TEST Dernier super', dateDebut: new Date('2026-09-01T00:00:00.000Z'), budgetGlobalVendu: 0, responsableId: titulaire.id } });
      let liberer, pret;
      const attente = new Promise((resolve) => { liberer = resolve; });
      const tenu = new Promise((resolve) => { pret = resolve; });
      const verrou = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "Chantier" WHERE "id" = ${chantier.id} FOR UPDATE`;
        pret();
        await attente;
      }, { timeout: 20000 });
      await tenu;
      try {
        const suppression = envoyer('delete', `/api/users/${titulaire.id}`, jeton(auteur)).then((reponse) => reponse);
        assert.equal(await attendreAttente(false), true, 'la suppression attend le chantier, après son contrôle');
        let repondu = false;
        const autre = seconde().then((reponse) => { repondu = true; return reponse; });
        for (let tour = 0; tour < 150 && !repondu && await attentes(false) + await attentes(true) < 2; tour += 1) await attendre(20);
        const attendaitLesRetraits = await attentes(true) > 0;
        liberer();
        await verrou;
        return { suppression: await suppression, autre: await autre, attendaitLesRetraits };
      } finally {
        liberer();
        await prisma.chantier.deleteMany({ where: { id: chantier.id } });
      }
    };

    after(async () => {
      await prisma.user.updateMany({ where: { email: { in: EMAILS } }, data: { responsableHierarchiqueId: null } });
      await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
    });

    test('la rétrogradation de soi est refusée quand l’autre super administrateur est désactivé', () => isoler(async () => {
      await prisma.user.update({ where: { id: comptes.b.id }, data: { actif: false } });
      const entrees = await entreesJournal(comptes.a.id);
      const refus = await envoyer('patch', `/api/users/${comptes.a.id}/role`, jeton(comptes.a), { role: 'ADMIN' });
      assert.deepEqual([refus.status, refus.body.error], [409, 'Impossible de retirer le rôle du dernier compte super administrateur.']);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: comptes.a.id } })).role, 'SUPERADMIN');
      assert.equal(await entreesJournal(comptes.a.id), entrees, 'aucune entrée de journal');
      // B réactivé, A peut se rétrograder : un super administrateur actif demeure.
      assert.equal((await envoyer('patch', `/api/users/${comptes.b.id}/actif`, jeton(comptes.a), { actif: true })).status, 200);
      const retrait = await envoyer('patch', `/api/users/${comptes.a.id}/role`, jeton(comptes.a), { role: 'ADMIN' });
      assert.equal(retrait.status, 200, JSON.stringify(retrait.body));
      assert.deepEqual(await superAdminsActifs(), [comptes.b.id]);
    }));

    test('un super administrateur désactivé se rétrograde ou se supprime sans compter comme le dernier', () => isoler(async () => {
      await prisma.user.update({ where: { id: comptes.b.id }, data: { actif: false } });
      const retrait = await envoyer('patch', `/api/users/${comptes.b.id}/role`, jeton(comptes.a), { role: 'ADMIN' });
      assert.equal(retrait.status, 200, JSON.stringify(retrait.body));
      await prisma.user.update({ where: { id: comptes.b.id }, data: { role: 'SUPERADMIN' } });
      const suppression = await envoyer('delete', `/api/users/${comptes.b.id}`, jeton(comptes.a));
      assert.equal(suppression.status, 200, JSON.stringify(suppression.body));
      assert.deepEqual(await superAdminsActifs(), [comptes.a.id]);
    }));

    // B agit sur A pendant qu'un autre retrait, simulé par une transaction de test qui tient le verrou
    // des retraits, désactive B. La requête de B a passé l'authentification et attend ce verrou ; à
    // sa reprise, elle voit le retrait validé : A est le dernier actif, et l'opération est refusée.
    for (const [nom, methode, chemin, corps, statut, message] of ROUTES) test(`${nom} : contrôle fait après l’attente des autres retraits, sur l’état validé`, () => isoler(async () => {
      let liberer, pret;
      const attente = new Promise((resolve) => { liberer = resolve; });
      const verrouPris = new Promise((resolve) => { pret = resolve; });
      const verrou = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814091)::text AS verrou`;
        pret();
        await attente;
        await tx.user.update({ where: { id: comptes.b.id }, data: { actif: false } });
      }, { timeout: 15000 });
      await verrouPris;
      const entrees = await entreesJournal(comptes.a.id);
      let reponse;
      try {
        reponse = envoyer(methode, chemin(comptes.a.id), jeton(comptes.b), corps).then((resultat) => resultat);
        assert.equal(await attendreAttente(true), true, 'la requête attend le verrou des retraits');
      } finally {
        liberer();
        await verrou;
      }
      const refus = await reponse;
      assert.deepEqual([refus.status, refus.body.error], [statut, message]);
      const a = await prisma.user.findUniqueOrThrow({ where: { id: comptes.a.id } });
      assert.deepEqual([a.role, a.actif], ['SUPERADMIN', true]);
      assert.deepEqual(await superAdminsActifs(), [comptes.a.id]);
      assert.equal(await entreesJournal(comptes.a.id), entrees, 'aucune entrée de journal');
    }));

    // Le verrou est tenu jusqu'à l'écriture : A supprime B, et sa suppression est arrêtée après son
    // contrôle (B n'était pas le dernier). B agit alors sur A : il attend, puis voit B supprimé.
    for (const [nom, methode, chemin, corps, statut, message] of ROUTES) test(`${nom} croisée avec une suppression en cours : le verrou est tenu jusqu’à l’écriture`, () => isoler(async () => {
      const entrees = await entreesJournal(comptes.a.id);
      const { suppression, autre, attendaitLesRetraits } = await pendantSuppressionArretee(comptes.b, comptes.a, () => envoyer(methode, chemin(comptes.a.id), jeton(comptes.b), corps));
      assert.equal(attendaitLesRetraits, true, 'la seconde requête attend le verrou des retraits');
      assert.equal(suppression.status, 200, JSON.stringify(suppression.body));
      assert.deepEqual([autre.status, autre.body.error], [statut, message]);
      assert.deepEqual(await superAdminsActifs(), [comptes.a.id]);
      assert.equal(await entreesJournal(comptes.a.id), entrees, 'aucune entrée de journal pour A');
    }));

    // Un compte supprimé pendant sa désactivation ou sa réactivation : 404, comme pour les autres
    // routes de comptes, et non une erreur 500.
    for (const actif of [false, true]) test(`${actif ? 'réactivation' : 'désactivation'} d’un compte supprimé au même moment : 404`, () => isoler(async () => {
      await prisma.user.deleteMany({ where: { email: EMAILS[3] } });
      const compte = await prisma.user.create({ data: { email: EMAILS[3], name: 'TEST Dernier super responsable', role: 'CONDUCTEUR_TRAVAUX', actif: !actif } });
      const { suppression, autre } = await pendantSuppressionArretee(compte, comptes.a, () => envoyer('patch', `/api/users/${compte.id}/actif`, jeton(comptes.a), { actif }));
      assert.equal(suppression.status, 200, JSON.stringify(suppression.body));
      assert.deepEqual([autre.status, autre.body.error], [404, 'Utilisateur introuvable.']);
    }));

    // Non-régression : le verrou des retraits n'introduit aucun interblocage avec les autres routes
    // de comptes. La suppression d'un responsable, arrêtée en cours, croise une désactivation, un
    // changement de type ou un rattachement de son collaborateur (vers un super administrateur) :
    // les deux aboutissent. Le collaborateur a un identifiant trié avant tous les autres.
    for (const [nom, seconde] of [
      ['la désactivation', (f) => envoyer('patch', `/api/users/${f.collaborateur.id}/actif`, jeton(f.admin), { actif: false })],
      ['le changement de type', (f) => envoyer('patch', `/api/users/${f.collaborateur.id}/role`, jeton(f.admin), { role: 'COMMERCIAL' })],
      ['le rattachement à un super administrateur', (f) => envoyer('patch', `/api/users/${f.collaborateur.id}/responsable-hierarchique`, jeton(comptes.b), { responsableHierarchiqueId: comptes.a.id })],
    ]) test(`suppression d’un responsable pendant ${nom} de son collaborateur : aucun interblocage`, () => isoler(async () => {
      await prisma.user.updateMany({ where: { email: { in: EMAILS.slice(2) } }, data: { responsableHierarchiqueId: null } });
      await prisma.user.deleteMany({ where: { email: { in: EMAILS.slice(2) } } });
      const admin = await prisma.user.create({ data: { email: EMAILS[2], name: 'TEST Dernier super admin', role: 'ADMIN' } });
      const responsable = await prisma.user.create({ data: { email: EMAILS[3], name: 'TEST Dernier super responsable', role: 'CONDUCTEUR_TRAVAUX' } });
      const collaborateur = await prisma.user.create({ data: { id: '00000000-0000-4000-8000-000000000178', email: EMAILS[4], name: 'TEST Dernier super collaborateur', role: 'CONDUCTEUR_TRAVAUX', responsableHierarchiqueId: responsable.id } });
      const { suppression, autre } = await pendantSuppressionArretee(responsable, comptes.a, () => seconde({ admin, collaborateur }));
      assert.equal(suppression.status, 200, JSON.stringify(suppression.body));
      assert.equal(autre.status, 200, JSON.stringify(autre.body));
      assert.equal(await prisma.user.count({ where: { id: responsable.id } }), 0);
    }));

    test('deux retraits croisés simultanés laissent toujours un super administrateur actif', () => isoler(async () => {
      // Le second refus vient de la transaction (409, 400) ou, s'il arrive après la validation du
      // premier retrait, de l'authentification ou du garde des comptes super administrateurs.
      for (const [nom, methode, chemin, corps, refus] of [
        ['rétrogradations', 'patch', (id) => `/api/users/${id}/role`, { role: 'ADMIN' }, [403, 409]],
        ['désactivations', 'patch', (id) => `/api/users/${id}/actif`, { actif: false }, [400, 401]],
        ['suppressions', 'delete', (id) => `/api/users/${id}`, undefined, [401, 409]],
      ]) {
        for (let essai = 0; essai < 10; essai += 1) {
          await preparer();
          const entrees = [await entreesJournal(comptes.b.id), await entreesJournal(comptes.a.id)];
          const reponses = await Promise.all([
            envoyer(methode, chemin(comptes.b.id), jeton(comptes.a), corps),
            envoyer(methode, chemin(comptes.a.id), jeton(comptes.b), corps),
          ]);
          const statuts = reponses.map((reponse) => reponse.status);
          const detail = `${nom}, essai ${essai} : ${JSON.stringify(reponses.map((reponse) => [reponse.status, reponse.body]))}`;
          assert.equal(statuts.filter((s) => s === 200).length, 1, detail);
          assert.ok(statuts.every((s) => s === 200 || refus.includes(s)), detail);
          assert.equal((await superAdminsActifs()).length, 1, detail);
          // Aucune entrée de journal pour le compte dont le retrait est refusé.
          const refuse = statuts[0] === 200 ? 1 : 0;
          assert.equal(await entreesJournal([comptes.b.id, comptes.a.id][refuse]), entrees[refuse], detail);
        }
      }
    }));

    // #215 : le garde « un simple administrateur ne touche pas un compte super administrateur » est
    // refait sur le compte relu sous son verrou. #218 : le rattachement attend les retraits en cours.
    describe('Garde des comptes super administrateurs relu sous verrou', () => {
      const CIBLES = ['garde.verrou.cible@iris.test', 'garde.verrou.responsable@iris.test', 'garde.verrou.ancien@iris.test'];
      const preparerComptes = async () => {
        await preparer();
        await prisma.user.updateMany({ where: { email: { in: CIBLES } }, data: { responsableHierarchiqueId: null } });
        await prisma.user.deleteMany({ where: { email: { in: CIBLES } } });
        const admin = await prisma.user.upsert({ where: { email: EMAILS[2] }, update: { role: 'ADMIN', actif: true }, create: { email: EMAILS[2], name: 'TEST Dernier super admin', role: 'ADMIN' } });
        const cible = await prisma.user.create({ data: { email: CIBLES[0], name: 'TEST Garde verrou cible', role: 'ADMIN' } });
        const responsable = await prisma.user.create({ data: { email: CIBLES[1], name: 'TEST Garde verrou responsable', role: 'CONDUCTEUR_TRAVAUX' } });
        const ancien = await prisma.user.create({ data: { email: CIBLES[2], name: 'TEST Garde verrou ancien responsable', role: 'CONDUCTEUR_TRAVAUX' } });
        return { admin, cible, responsable, ancien };
      };
      // Une transaction de test tient un compte, puis le modifie (promotion, autre type) : la requête
      // envoyée pendant ce temps a passé ses contrôles préalables et attend le verrou de ce compte.
      const pendantChangement = async (compteId, donnees, envoi) => {
        let liberer, pret;
        const attente = new Promise((resolve) => { liberer = resolve; });
        const tenu = new Promise((resolve) => { pret = resolve; });
        const changement = prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${compteId} FOR UPDATE`;
          pret();
          await attente;
          await tx.user.update({ where: { id: compteId }, data: donnees });
        }, { timeout: 15000 });
        await tenu;
        let reponse;
        try {
          reponse = envoi().then((resultat) => resultat);
          assert.equal(await attendreAttente(false), true, 'la requête attend le verrou du compte');
        } finally {
          liberer();
          await changement;
        }
        return reponse;
      };
      const dernierRattachement = (cibleId) => prisma.journalAdministration.findFirst({ where: { action: 'RATTACHEMENT', cibleId }, orderBy: { createdAt: 'desc' } });
      after(async () => {
        await prisma.user.updateMany({ where: { email: { in: CIBLES } }, data: { responsableHierarchiqueId: null } });
        await prisma.user.deleteMany({ where: { email: { in: CIBLES } } });
      });

      // Un super administrateur promeut la cible pendant qu'un simple administrateur la modifie : la
      // requête passe le contrôle préalable, attend le verrou du compte, puis voit la promotion.
      for (const [nom, methode, chemin, corps, verifier] of [
        ['suppression', 'delete', (f) => `/api/users/${f.cible.id}`, undefined, async (f) => assert.equal(await prisma.user.count({ where: { id: f.cible.id } }), 1)],
        ['changement de type', 'patch', (f) => `/api/users/${f.cible.id}/role`, { role: 'COMPTABLE' }, async (f) => assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: f.cible.id } })).role, 'SUPERADMIN')],
        ['« aussi commercial »', 'patch', (f) => `/api/users/${f.cible.id}/est-commercial`, { estCommercial: true }, async (f) => assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: f.cible.id } })).estCommercial, false)],
        ['désactivation', 'patch', (f) => `/api/users/${f.cible.id}/actif`, { actif: false }, async (f) => assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: f.cible.id } })).actif, true)],
        ['rattachement', 'patch', (f) => `/api/users/${f.cible.id}/responsable-hierarchique`, (f) => ({ responsableHierarchiqueId: f.responsable.id }), async (f) => assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: f.cible.id } })).responsableHierarchiqueId, null)],
      ]) test(`${nom} par un simple administrateur pendant la promotion de la cible : refusé sous verrou`, async () => {
        const f = await preparerComptes();
        const entrees = await entreesJournal(f.cible.id);
        const refus = await pendantChangement(f.cible.id, { role: 'SUPERADMIN' }, () => envoyer(methode, chemin(f), jeton(f.admin), typeof corps === 'function' ? corps(f) : corps));
        assert.deepEqual([refus.status, refus.body.error], [403, 'Seul un super administrateur peut gérer un compte super administrateur.']);
        await verifier(f);
        assert.equal(await entreesJournal(f.cible.id), entrees, 'aucune entrée de journal');
      });

      // Même relecture pour le type : une cible qui quitte l'administration pendant la requête ne
      // reçoit pas un « aussi commercial » orphelin.
      test('« aussi commercial » pendant que la cible quitte l’administration : refusé sous verrou', async () => {
        const f = await preparerComptes();
        const refus = await pendantChangement(f.cible.id, { role: 'COMPTABLE', estCommercial: false }, () => envoyer('patch', `/api/users/${f.cible.id}/est-commercial`, jeton(f.admin), { estCommercial: true }));
        assert.deepEqual([refus.status, refus.body.error], [400, 'Seul un compte Administrateur peut être marqué "aussi commercial".']);
        assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: f.cible.id } })).estCommercial, false);
      });

      test('« aussi commercial » d’un compte supprimé au même moment : 404', async () => {
        const f = await preparerComptes();
        const { suppression, autre } = await pendantSuppressionArretee(f.cible, comptes.a, () => envoyer('patch', `/api/users/${f.cible.id}/est-commercial`, jeton(f.admin), { estCommercial: true }));
        assert.equal(suppression.status, 200, JSON.stringify(suppression.body));
        assert.deepEqual([autre.status, autre.body.error], [404, 'Utilisateur introuvable.']);
      });

      // Le responsable choisi et l'ancien sont relus sous verrou : un responsable promu pendant la
      // requête n'est pas proposé à un simple administrateur, et l'entrée de journal d'un
      // rattachement qui touche un super administrateur lui reste fermée.
      test('rattachement par un simple administrateur à un responsable promu au même moment : refusé', async () => {
        const f = await preparerComptes();
        const entrees = await entreesJournal(f.cible.id);
        const refus = await pendantChangement(f.responsable.id, { role: 'SUPERADMIN' }, () => envoyer('patch', `/api/users/${f.cible.id}/responsable-hierarchique`, jeton(f.admin), { responsableHierarchiqueId: f.responsable.id }));
        assert.deepEqual([refus.status, refus.body.error], [400, 'Responsable hiérarchique introuvable ou désactivé.']);
        assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: f.cible.id } })).responsableHierarchiqueId, null);
        assert.equal(await entreesJournal(f.cible.id), entrees, 'aucune entrée de journal');
      });

      for (const [nom, promu, avant] of [
        ['du responsable choisi', (f) => f.responsable, null],
        ['de l’ancien responsable', (f) => f.ancien, (f) => f.ancien.id],
      ]) test(`rattachement par un super administrateur pendant la promotion ${nom} : entrée fermée au simple administrateur`, async () => {
        const f = await preparerComptes();
        if (avant) await prisma.user.update({ where: { id: f.cible.id }, data: { responsableHierarchiqueId: avant(f) } });
        const reponse = await pendantChangement(promu(f).id, { role: 'SUPERADMIN' }, () => envoyer('patch', `/api/users/${f.cible.id}/responsable-hierarchique`, jeton(comptes.a), { responsableHierarchiqueId: f.responsable.id }));
        assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
        const entree = await dernierRattachement(f.cible.id);
        assert.equal(entree?.concerneSuperAdmin, true, JSON.stringify(entree));
      });

      // #218 : un rattachement croisant la suppression du compte ou de son responsable attend la fin
      // de cette suppression, puis répond comme si elle avait précédé, et jamais 500.
      for (const [nom, supprime, statut, message] of [
        ['du responsable choisi', (f) => f.responsable, 400, 'Responsable hiérarchique introuvable ou désactivé.'],
        ['du compte rattaché', (f) => f.cible, 404, 'Utilisateur introuvable.'],
      ]) test(`rattachement pendant la suppression ${nom} : ${statut}, jamais 500`, async () => {
        const f = await preparerComptes();
        const { suppression, autre, attendaitLesRetraits } = await pendantSuppressionArretee(supprime(f), comptes.a, () => envoyer('patch', `/api/users/${f.cible.id}/responsable-hierarchique`, jeton(f.admin), { responsableHierarchiqueId: f.responsable.id }));
        assert.equal(suppression.status, 200, JSON.stringify(suppression.body));
        assert.deepEqual([autre.status, autre.body.error], [statut, message]);
        assert.equal(attendaitLesRetraits, true, 'le rattachement attend le verrou des retraits');
      });
    });
  });

  // Cycle de vie d'une affaire : c'est la conversion d'un devis accepté qui ouvre le
  // chantier, et l'annulation du devis qui revient dessus. Un chantier ne se supprime plus.
  describe('Cycle de vie du devis : acompte, annulation, duplication', () => {
    let session = '';
    let clientId = '';
    let categorieId = '';
    let fournisseurId = '';
    let intervenantId = '';

    // Amène un devis neuf jusqu'au statut ACCEPTE, avec ou sans acompte exigé.
    const devisAccepte = async (objet, extra = {}) => {
      const cree = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet, lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 }], ...extra,
      });
      assert.equal(cree.status, 201, JSON.stringify(cree.body));
      const envoi = await request(app).put(`/api/devis/${cree.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ENVOYE' });
      assert.equal(envoi.status, 200, JSON.stringify(envoi.body));
      const signature = await request(app).post(`/api/devis/${cree.body.id}/signature`).set('Authorization', `Bearer ${session}`)
        .send({ signataire: 'TEST Signataire interne', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      return cree.body;
    };
    const convertir = (id) => request(app).post(`/api/devis/${id}/convertir`).set('Authorization', `Bearer ${session}`).send({ cible: 'CHANTIER' });

    before(async () => {
      session = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      clientId = (await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client cycle' })).body.id;
      categorieId = (await prisma.categorie.upsert({ where: { nom: 'TEST Catégorie cycle' }, update: {}, create: { nom: 'TEST Catégorie cycle' } })).id;
      fournisseurId = (await prisma.fournisseur.upsert({ where: { nom: 'TEST Fournisseur cycle' }, update: {}, create: { nom: 'TEST Fournisseur cycle' } })).id;
      intervenantId = (await prisma.intervenant.create({ data: { nom: 'TEST Intervenant cycle', role: 'Technicien', tauxHoraireCharge: 40 } })).id;
    });

    test('un chantier ne se crée ni ne se supprime directement', async () => {
      const creation = await request(app).post('/api/chantiers').set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST direct', client: 'TEST', dateDebut: '2026-09-01' });
      assert.equal(creation.status, 410, 'la création directe reste fermée');

      const devis = await devisAccepte('TEST Affaire supprimable');
      const chantier = await convertir(devis.id);
      assert.equal(chantier.status, 201, JSON.stringify(chantier.body));
      const suppression = await request(app).delete(`/api/chantiers/${chantier.body.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 410, 'la suppression d’un chantier n’existe plus');
      assert.ok(await prisma.chantier.findUnique({ where: { id: chantier.body.id } }), 'le chantier est toujours là');
    });

    test('l’acompte exigé retient l’ouverture du chantier jusqu’à sa constatation', async () => {
      const devis = await devisAccepte('TEST Affaire avec acompte', { acompteExige: true });
      assert.equal(devis.acompteExige, true);
      assert.equal(devis.tauxAcompte, 30, 'le taux par défaut du paramétrage est figé sur le devis');

      const trop_tot = await convertir(devis.id);
      assert.equal(trop_tot.status, 400, 'pas de chantier tant que l’acompte n’est pas là');

      const attente = await request(app).put(`/api/devis/${devis.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'EN_ATTENTE_ACOMPTE' });
      assert.equal(attente.status, 200);
      assert.equal(attente.body.statut, 'EN_ATTENTE_ACOMPTE');

      for (const corps of [{}, { recuLe: 'hier', montant: 60, reference: 'VIR-1' }, { recuLe: '01-09-2026', montant: -60, reference: 'VIR-1' }, { recuLe: '01-09-2026', montant: 60, reference: '  ' }]) {
        const refus = await request(app).post(`/api/devis/${devis.id}/acompte`).set('Authorization', `Bearer ${session}`).send(corps);
        assert.equal(refus.status, 400, `constatation acceptée à tort : ${JSON.stringify(corps)}`);
      }

      const acompte = await request(app).post(`/api/devis/${devis.id}/acompte`).set('Authorization', `Bearer ${session}`)
        .send({ recuLe: '01-09-2026', montant: 72, reference: 'VIR-2026-09' });
      assert.equal(acompte.status, 200, JSON.stringify(acompte.body));
      assert.equal(acompte.body.statut, 'ACCEPTE', 'la constatation remet le devis en état d’être converti');
      assert.equal(acompte.body.acompteMontant, 72);

      const ouvert = await convertir(devis.id);
      assert.equal(ouvert.status, 201, JSON.stringify(ouvert.body));

      const rejoue = await request(app).post(`/api/devis/${devis.id}/acompte`).set('Authorization', `Bearer ${session}`)
        .send({ recuLe: '02-09-2026', montant: 10, reference: 'VIR-DOUBLON' });
      assert.equal(rejoue.status, 400, 'un acompte ne se constate pas deux fois');
    });

    test('changer le taux par défaut ne réécrit aucun devis déjà émis', async () => {
      const avant = await devisAccepte('TEST Affaire taux figé', { acompteExige: true });
      assert.equal(avant.tauxAcompte, 30);
      const maj = await request(app).put('/api/parametres').set('Authorization', `Bearer ${session}`)
        .send({ margeCommercialeActive: true, tauxAcompteDefaut: 50 });
      assert.equal(maj.status, 200);
      assert.equal(maj.body.tauxAcompteDefaut, 50);

      const apres = await request(app).post('/api/devis').set('Authorization', `Bearer ${session}`).send({
        clientId, objet: 'TEST Affaire taux neuf', acompteExige: true,
        lignes: [{ designation: 'Pose', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      assert.equal(apres.body.tauxAcompte, 50, 'un devis neuf suit la politique du jour');
      const inchange = await prisma.devis.findUnique({ where: { id: avant.id } });
      assert.equal(Number(inchange.tauxAcompte), 30, 'le devis déjà émis garde son taux');

      const hors_bornes = await request(app).put('/api/parametres').set('Authorization', `Bearer ${session}`)
        .send({ margeCommercialeActive: true, tauxAcompteDefaut: 140 });
      assert.equal(hors_bornes.status, 400);
      await request(app).put('/api/parametres').set('Authorization', `Bearer ${session}`).send({ margeCommercialeActive: true, tauxAcompteDefaut: 30 });
    });

    test('une affaire commencée ne s’annule pas', async () => {
      const devis = await devisAccepte('TEST Affaire commencée');
      const chantier = (await convertir(devis.id)).body;
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await prisma.pointageHeure.create({ data: { date: new Date(), nbrHeures: 3, tauxHoraireApplique: 40, chantierId: chantier.id, intervenantId, createdById: auteur.id, updatedById: auteur.id } });

      const refus = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'erreur de saisie' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /pointage/);
      assert.equal((await prisma.devis.findUnique({ where: { id: devis.id } })).statut, 'ACCEPTE', 'le devis n’a pas bougé');
      assert.equal((await prisma.chantier.findUnique({ where: { id: chantier.id } })).statut, 'EN_COURS');
    });

    test('un achat suffit lui aussi à verrouiller l’annulation', async () => {
      const devis = await devisAccepte('TEST Affaire approvisionnée');
      const chantier = (await convertir(devis.id)).body;
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await prisma.achatReel.create({ data: { date: new Date(), description: 'TEST matériel', montantHT: 500, chantierId: chantier.id, categorieId, fournisseurId, createdById: auteur.id, updatedById: auteur.id } });

      const refus = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'client renonce' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /achat/);
    });

    test('annuler un devis archive son chantier et conserve le motif', async () => {
      const devis = await devisAccepte('TEST Affaire annulable');
      const chantier = (await convertir(devis.id)).body;

      const sansMotif = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({});
      assert.equal(sansMotif.status, 400, 'le motif est obligatoire');

      const annulation = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`)
        .send({ motif: 'affaire ouverte sur le mauvais client' });
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      assert.equal(annulation.body.devis.statut, 'ANNULE');
      assert.equal(annulation.body.chantierArchive, chantier.id);

      const archive = await prisma.chantier.findUnique({ where: { id: chantier.id } });
      assert.equal(archive.statut, 'ANNULE');
      assert.equal(archive.motifAnnulation, 'affaire ouverte sur le mauvais client');
      assert.ok(archive.annuleParId, 'l’auteur de l’annulation est conservé');

      // L'affaire sort des listes et des statistiques, mais reste consultable.
      const liste = await request(app).get('/api/chantiers').set('Authorization', `Bearer ${session}`);
      assert.equal(liste.body.some((c) => c.id === chantier.id), false, 'une affaire annulée quitte la liste');
      const fiche = await request(app).get(`/api/chantiers/${chantier.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(fiche.status, 200, 'la fiche reste lisible pour comprendre l’annulation');
      assert.equal(fiche.body.motifAnnulation, 'affaire ouverte sur le mauvais client');

      // Plus rien ne s'écrit dessus, et le devis est figé.
      const saisie = await request(app).post('/api/achats').set('Authorization', `Bearer ${session}`)
        .send({ chantierId: chantier.id, categorieId, fournisseurId, date: '01-09-2026', description: 'TEST tardif', montantHT: 10 });
      assert.equal(saisie.status, 409, JSON.stringify(saisie.body));
      const reconversion = await convertir(devis.id);
      assert.equal(reconversion.status, 400, 'un devis annulé n’ouvre plus de chantier');
      const doubleAnnulation = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${session}`).send({ motif: 'encore' });
      assert.equal(doubleAnnulation.status, 400, 'on n’annule pas une annulation');

      // La reprise passe par une duplication : même contenu, numéro neuf, brouillon.
      const duplicata = await request(app).post(`/api/devis/${devis.id}/duplication`).set('Authorization', `Bearer ${session}`);
      assert.equal(duplicata.status, 201, JSON.stringify(duplicata.body));
      assert.equal(duplicata.body.statut, 'BROUILLON');
      assert.equal(duplicata.body.version, 1);
      assert.equal(duplicata.body.objet, 'TEST Affaire annulable');
      assert.equal(duplicata.body.totalTtc, 240);
      assert.equal(duplicata.body.lignes.length, 1);
      assert.notEqual(duplicata.body.numero, devis.numero, 'le duplicata a son propre numéro d’affaire');
      assert.notEqual(duplicata.body.dossierId, devis.dossierId);
      assert.equal(duplicata.body.origineDevisId, devis.id, 'le lien vers l’origine est conservé');
    });

    test('le journal de saisie expose les valeurs avant/après sur le chantier autorisé', async () => {
      const devis = await devisAccepte('TEST Affaire journal Travaux');
      const chantier = (await convertir(devis.id)).body;
      const achat = await request(app).post('/api/achats').set('Authorization', `Bearer ${session}`)
        .send({ chantierId: chantier.id, categorieId, fournisseurId, date: '01-09-2026', description: 'TEST achat journal', montantHT: 500 });
      assert.equal(achat.status, 200, JSON.stringify(achat.body));
      const correction = await request(app).patch(`/api/achats/${achat.body.id}`).set('Authorization', `Bearer ${session}`)
        .send({ montantHT: 50, motifCorrection: 'Montant initial incorrect' });
      assert.equal(correction.status, 200, JSON.stringify(correction.body));

      const journal = await request(app).get(`/api/chantiers/${chantier.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.length, 2);
      const correctionJournal = journal.body.find((entree) => entree.action === 'CORRECTION');
      assert.equal(correctionJournal.avant.montantHT, 500);
      assert.equal(correctionJournal.apres.montantHT, 50);
      assert.equal(correctionJournal.motif, 'Montant initial incorrect');
      assert.equal(correctionJournal.auteurNom, 'Secours');
    });

    test('seul un administrateur annule un devis ou constate un acompte', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const conducteur = await prisma.user.upsert({
        where: { email: 'cycle.conducteur@iris.test' },
        update: { role: 'CONDUCTEUR_TRAVAUX', actif: true, permissions: ['devis:read', 'devis:write', 'clients:read'] },
        create: { email: 'cycle.conducteur@iris.test', name: 'TEST Conducteur cycle', role: 'CONDUCTEUR_TRAVAUX', permissions: ['devis:read', 'devis:write', 'clients:read'] },
      });
      const sessionConducteur = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const devis = await devisAccepte('TEST Affaire droits', { acompteExige: true });

      const annulation = await request(app).post(`/api/devis/${devis.id}/annulation`).set('Authorization', `Bearer ${sessionConducteur}`).send({ motif: 'essai' });
      assert.equal(annulation.status, 403);
      const acompte = await request(app).post(`/api/devis/${devis.id}/acompte`).set('Authorization', `Bearer ${sessionConducteur}`)
        .send({ recuLe: '01-09-2026', montant: 10, reference: 'X' });
      assert.equal(acompte.status, 403);
      // La duplication, elle, relève du droit devis et non de l'administration.
      const duplicata = await request(app).post(`/api/devis/${devis.id}/duplication`).set('Authorization', `Bearer ${sessionConducteur}`);
      assert.equal(duplicata.status, 201, JSON.stringify(duplicata.body));
    });

    // Ouverture du chantier d'une affaire depuis l'Administration (décision de Nelson du
    // 14-10-2026) : la conversion du devis signé fixe aussitôt titulaire, commercial, types et
    // date de début, et chaque affaire n'a qu'un chantier.
    describe('Ouverture du chantier d’une affaire depuis l’Administration', () => {
      let jwt;
      const comptes = {};
      const entete = (cle) => ({ Authorization: `Bearer ${jwt.sign({ id: comptes[cle].id }, process.env.JWT_SECRET)}` });
      const admin = () => ({ Authorization: `Bearer ${session}` });
      const ouvrir = (id, corps, auth = admin()) => request(app).post(`/api/devis/${id}/convertir`).set(auth).send({ cible: 'CHANTIER', ...corps });
      const aConvertir = async (auth = admin()) => {
        const liste = await request(app).get('/api/devis/a-convertir').set(auth);
        assert.equal(liste.status, 200, JSON.stringify(liste.body));
        return liste.body;
      };

      before(async () => {
        jwt = (await import('jsonwebtoken')).default;
        const compte = async (cle, role, extra = {}) => {
          const email = `ouverture.${cle}@iris.test`;
          comptes[cle] = await prisma.user.upsert({
            where: { email },
            update: { role, actif: true, estCommercial: false, permissions: [], ...extra },
            create: { email, name: `TEST Ouverture ${cle}`, role, ...extra },
          });
        };
        await compte('conducteur', 'CONDUCTEUR_TRAVAUX');
        await compte('autre.conducteur', 'CONDUCTEUR_TRAVAUX');
        await compte('commercial', 'COMMERCIAL');
        await compte('commercial.inactif', 'COMMERCIAL', { actif: false });
        await compte('ancien.conducteur', 'CONDUCTEUR_TRAVAUX', { actif: false });
      });

      test('ouvre le chantier avec son titulaire, son commercial, ses types et sa date de début', async () => {
        const devis = await devisAccepte('TEST Ouverture complète');
        const proposes = await aConvertir();
        const propose = proposes.find((d) => d.id === devis.id);
        assert.ok(propose, 'un devis accepté et signé est proposé à l’ouverture');
        assert.deepEqual(Object.keys(propose).sort(), ['client', 'dossierId', 'id', 'numero', 'objet', 'totalHt', 'version']);
        assert.equal(propose.client.raisonSociale, 'TEST Client cycle');

        const ouvert = await ouvrir(devis.id, {
          responsableId: comptes.conducteur.id, commercialId: comptes.commercial.id, types: ['Vidéo', 'Inventé', 'Alarme'], dateDebut: '05-10-2026',
        });
        assert.equal(ouvert.status, 201, JSON.stringify(ouvert.body));
        const chantier = await prisma.chantier.findUnique({ where: { id: ouvert.body.id } });
        assert.equal(chantier.responsableId, comptes.conducteur.id);
        assert.equal(chantier.commercialId, comptes.commercial.id);
        assert.deepEqual(chantier.types, ['Vidéo', 'Alarme'], 'seuls les types connus sont gardés');
        assert.equal(chantier.dateDebut.toISOString(), '2026-10-05T00:00:00.000Z', 'la date de début saisie est un jour civil');
        assert.equal(chantier.numeroDevis, devis.numero);
        assert.equal(Number(chantier.budgetGlobalVendu), 200, 'le vendu est celui du devis');
        assert.equal(Number(chantier.heuresVendues), 2);

        // Le conducteur désigné voit aussitôt son chantier.
        const liste = await request(app).get('/api/chantiers').set(entete('conducteur'));
        assert.equal(liste.status, 200, JSON.stringify(liste.body));
        assert.ok(liste.body.some((c) => c.id === chantier.id), 'le titulaire voit le chantier ouvert pour lui');
        assert.ok(!(await aConvertir()).some((d) => d.id === devis.id), 'un devis converti n’est plus proposé');

        // Chaque affaire n'a qu'un chantier : une seconde ouverture est refusée.
        const doublon = await ouvrir(devis.id, { responsableId: comptes['autre.conducteur'].id });
        assert.equal(doublon.status, 409, JSON.stringify(doublon.body));
        assert.match(doublon.body.error, /déjà été converti/);
        assert.equal(await prisma.chantier.count({ where: { numeroDevis: devis.numero } }), 1);
      });

      // Décision de Nelson (14-10-2026) : le début d'un chantier ouvert sans date choisie est le
      // jour civil de la société, en date-seule. L'horloge est figée au dernier 21 h UTC passé, où
      // le jour de Wallis diffère de celui d'UTC.
      test('une conversion sans date de début pose le jour civil de la société', async () => {
        const jourDans = (fuseau) => new Intl.DateTimeFormat('en-CA', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const fuseau = 'Pacific/Wallis';
        const fuseauInitial = (await request(app).get('/api/company').set(admin())).body.fuseauHoraire;
        try {
          figerHorlogeA21hUtc();
          assert.notEqual(jourDans(fuseau), jourDans('UTC'), 'le jour de la société diffère de celui d’UTC');
          assert.equal((await request(app).put('/api/company').set(admin()).send({ fuseauHoraire: fuseau })).status, 200);
          const devis = await devisAccepte('TEST Ouverture jour de la société');
          const ouvert = await convertir(devis.id);
          assert.equal(ouvert.status, 201, JSON.stringify(ouvert.body));
          assert.equal(ouvert.body.dateDebut, `${jourDans(fuseau)}T00:00:00.000Z`);
        } finally {
          mock.timers.reset();
          await request(app).put('/api/company').set(admin()).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        }
      });

      test('deux ouvertures simultanées du même devis n’ouvrent qu’un chantier', async () => {
        const devis = await devisAccepte('TEST Ouverture simultanée');
        const reponses = await Promise.all([comptes.conducteur, comptes['autre.conducteur']].map((c) => ouvrir(devis.id, { responsableId: c.id, commercialId: comptes.commercial.id })));
        assert.deepEqual(reponses.map((r) => r.status).sort(), [201, 409], JSON.stringify(reponses.map((r) => r.body)));
        assert.match(reponses.find((r) => r.status === 409).body.error, /déjà été converti/);
        assert.equal(await prisma.chantier.count({ where: { numeroDevis: devis.numero } }), 1);
        assert.equal(await prisma.devisConversion.count({ where: { devisId: devis.id } }), 1);
      });

      // Les écritures d'un devis concurrentes de sa conversion passent l'une après l'autre (verrou
      // du devis). Sans lui, une révision, une annulation ou un changement de statut lancés en même
      // temps réussissaient aussi, et laissaient un état incohérent. Trois tours par cas.
      test('une révision lancée en même temps que la conversion ne passe pas avec elle', async () => {
        for (let tour = 0; tour < 3; tour += 1) {
          const devis = await devisAccepte(`TEST Ouverture et révision simultanées ${tour}`);
          const [conversion, revision] = await Promise.all([convertir(devis.id), request(app).post(`/api/devis/${devis.id}/revisions`).set(admin())]);
          assert.deepEqual([conversion.status, revision.status].sort(), [201, 409], JSON.stringify([conversion.body, revision.body]));
          const converti = await prisma.devisConversion.count({ where: { devisId: devis.id } });
          const revise = await prisma.devis.count({ where: { dossierId: devis.dossierId, version: { gt: devis.version } } });
          assert.equal(converti + revise, 1, 'jamais à la fois une conversion et une révision du devis');
        }
      });

      test('une annulation lancée en même temps que la conversion archive le chantier ouvert', async () => {
        for (let tour = 0; tour < 3; tour += 1) {
          const devis = await devisAccepte(`TEST Ouverture et annulation simultanées ${tour}`);
          const [conversion, annulation] = await Promise.all([convertir(devis.id), request(app).post(`/api/devis/${devis.id}/annulation`).set(admin()).send({ motif: 'TEST annulation simultanée' })]);
          assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
          assert.ok(conversion.status === 201 || (conversion.status === 400 && /annulé/.test(conversion.body.error)), JSON.stringify(conversion.body));
          const relu = await prisma.devis.findUnique({ where: { id: devis.id }, select: { statut: true } });
          const chantiers = await prisma.chantier.findMany({ where: { numeroDevis: devis.numero }, select: { statut: true } });
          assert.equal(relu.statut, 'ANNULE');
          assert.ok(chantiers.every((c) => c.statut === 'ANNULE'), `devis annulé, chantier ${JSON.stringify(chantiers)}`);
        }
      });

      test('un changement de statut lancé en même temps que la conversion ne modifie pas un devis converti', async () => {
        for (let tour = 0; tour < 3; tour += 1) {
          const devis = await devisAccepte(`TEST Ouverture et statut simultanés ${tour}`, { acompteExige: true });
          const acompte = await request(app).post(`/api/devis/${devis.id}/acompte`).set(admin()).send({ recuLe: '01-10-2026', montant: 60, reference: `TEST-VIR-STATUT-${tour}` });
          assert.equal(acompte.status, 200, JSON.stringify(acompte.body));
          const reponses = await Promise.all([convertir(devis.id), request(app).put(`/api/devis/${devis.id}/statut`).set(admin()).send({ statut: 'EN_ATTENTE_ACOMPTE' })]);
          assert.equal(reponses.filter((r) => r.status < 300).length, 1, JSON.stringify(reponses.map((r) => [r.status, r.body.error])));
          assert.ok(reponses.every((r) => r.status < 500), JSON.stringify(reponses.map((r) => [r.status, r.body.error])));
          const relu = await prisma.devis.findUnique({ where: { id: devis.id }, include: { conversion: true } });
          assert.ok(!(relu.conversion && relu.statut !== 'ACCEPTE'), `devis converti au statut ${relu.statut}`);
        }
      });

      // L'acompte verrouille lui aussi le devis : constaté pendant une annulation, il ne fait pas
      // repasser le devis annulé à « accepté » (il lirait l'ancien statut, puis l'écraserait).
      test('un acompte constaté en même temps qu’une annulation ne fait pas revivre le devis', async () => {
        for (let tour = 0; tour < 3; tour += 1) {
          const devis = await devisAccepte(`TEST Acompte et annulation simultanés ${tour}`, { acompteExige: true });
          const attente = await request(app).put(`/api/devis/${devis.id}/statut`).set(admin()).send({ statut: 'EN_ATTENTE_ACOMPTE' });
          assert.equal(attente.status, 200, JSON.stringify(attente.body));
          const [acompte, annulation] = await Promise.all([
            request(app).post(`/api/devis/${devis.id}/acompte`).set(admin()).send({ recuLe: '01-10-2026', montant: 60, reference: `TEST-VIR-ANNUL-${tour}` }),
            request(app).post(`/api/devis/${devis.id}/annulation`).set(admin()).send({ motif: 'TEST annulation simultanée' }),
          ]);
          assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
          assert.ok(acompte.status === 200 || acompte.status === 400, JSON.stringify(acompte.body));
          assert.equal((await prisma.devis.findUnique({ where: { id: devis.id } })).statut, 'ANNULE');
        }
      });

      // Sous verrou, un devis inexistant répond toujours 404 au statut (par les deux portes) et à
      // l'acompte, avant toute validation du corps.
      test('le statut et l’acompte d’un devis inexistant répondent 404', async () => {
        const cle = await request(app).post('/api/admin/api-keys').set(admin()).send({ nom: 'TEST agent statut devis', scopes: ['devis:write'] });
        assert.equal(cle.status, 201, JSON.stringify(cle.body));
        const reponses = [
          // Statut invalide : le 404 passe avant la vérification de la transition.
          await request(app).put('/api/devis/devis-inexistant/statut').set(admin()).send({ statut: 'INCONNU' }),
          await request(app).put('/api/v1/devis/devis-inexistant/statut').set('Authorization', `Bearer ${cle.body.apiKey}`).send({ statut: 'INCONNU' }),
          await request(app).post('/api/devis/devis-inexistant/acompte').set(admin()).send({}),
        ];
        for (const reponse of reponses) {
          assert.equal(reponse.status, 404, JSON.stringify(reponse.body));
          assert.equal(reponse.body.error, 'Devis introuvable.');
        }
      });

      test('une référence d’affaire déjà portée par un chantier n’en ouvre pas un second', async () => {
        const devis = await devisAccepte('TEST Ouverture référence prise');
        const existant = await prisma.chantier.create({ data: { nom: 'TEST Ouverture chantier saisi à la main', client: 'TEST Client cycle', numeroDevis: devis.numero, dateDebut: new Date('2026-10-01T00:00:00.000Z'), budgetGlobalVendu: 0 } });
        try {
          assert.ok(!(await aConvertir()).some((d) => d.id === devis.id), 'un devis dont la référence est prise n’est pas proposé');
          const refus = await ouvrir(devis.id, { responsableId: comptes.conducteur.id, commercialId: comptes.commercial.id });
          assert.equal(refus.status, 409, JSON.stringify(refus.body));
          assert.match(refus.body.error, new RegExp(`L’affaire ${devis.numero} a déjà un chantier`));
          // Sans les choix de l'Administration, la conversion de l'écran Devis est refusée de même.
          assert.equal((await convertir(devis.id)).status, 409);
          assert.equal(await prisma.chantier.count({ where: { numeroDevis: devis.numero } }), 1);
          assert.equal(await prisma.devisConversion.count({ where: { devisId: devis.id } }), 0);
        } finally {
          await prisma.chantier.delete({ where: { id: existant.id } });
        }
      });

      // Une révision convertie puis annulée avec son chantier : l'affaire a eu son chantier. La
      // version précédente, redevenue la dernière non annulée, n'est plus proposée, et sa
      // conversion oriente vers la duplication (seule voie de reprise), et non vers une
      // correction de la fiche d'une affaire annulée.
      test('une affaire qui a déjà eu son chantier n’est plus proposée, et sa reprise passe par la duplication', async () => {
        const premiere = await devisAccepte('TEST Ouverture affaire reprise');
        const revision = await request(app).post(`/api/devis/${premiere.id}/revisions`).set(admin());
        assert.equal(revision.status, 201, JSON.stringify(revision.body));
        await request(app).put(`/api/devis/${revision.body.id}/statut`).set(admin()).send({ statut: 'ENVOYE' });
        const signature = await request(app).post(`/api/devis/${revision.body.id}/signature`).set(admin()).send({ signataire: 'TEST Signataire révision', confirme: true });
        assert.equal(signature.status, 201, JSON.stringify(signature.body));
        assert.equal((await convertir(revision.body.id)).status, 201);
        const annulation = await request(app).post(`/api/devis/${revision.body.id}/annulation`).set(admin()).send({ motif: 'TEST affaire annulée avant reprise' });
        assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
        assert.ok(!(await aConvertir()).some((d) => d.id === premiere.id), 'la version précédente n’est plus proposée');
        const refus = await ouvrir(premiere.id, { responsableId: comptes.conducteur.id, commercialId: comptes.commercial.id });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /dupliquez le devis/);
        assert.equal(await prisma.chantier.count({ where: { numeroDevis: premiere.numero } }), 1, 'pas de second chantier pour l’affaire');
      });

      // Même affaire, mais la référence du chantier de la révision a été corrigée avant son
      // annulation : seule la conversion d'une autre version du dossier signale que l'affaire a
      // déjà eu son chantier (la référence, elle, est libre).
      test('une autre version déjà convertie bloque l’affaire, même si son chantier a changé de référence', async () => {
        const premiere = await devisAccepte('TEST Ouverture autre version');
        const revision = await request(app).post(`/api/devis/${premiere.id}/revisions`).set(admin());
        assert.equal(revision.status, 201, JSON.stringify(revision.body));
        await request(app).put(`/api/devis/${revision.body.id}/statut`).set(admin()).send({ statut: 'ENVOYE' });
        const signature = await request(app).post(`/api/devis/${revision.body.id}/signature`).set(admin()).send({ signataire: 'TEST Signataire autre version', confirme: true });
        assert.equal(signature.status, 201, JSON.stringify(signature.body));
        const conversion = await convertir(revision.body.id);
        assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
        const referenceLibre = `A99-${String(Date.now()).slice(-7)}`;
        const correction = await request(app).patch(`/api/chantiers/${conversion.body.id}`).set(admin()).send({ numeroDevis: referenceLibre });
        assert.equal(correction.status, 200, JSON.stringify(correction.body));
        const annulation = await request(app).post(`/api/devis/${revision.body.id}/annulation`).set(admin()).send({ motif: 'TEST autre version annulée' });
        assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
        assert.ok(!(await aConvertir()).some((d) => d.id === premiere.id), 'la version précédente n’est plus proposée');
        const refus = await ouvrir(premiere.id, { responsableId: comptes.conducteur.id, commercialId: comptes.commercial.id });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /Une autre version de ce devis a déjà ouvert le chantier de l’affaire.*dupliquez le devis/);
        assert.equal(await prisma.chantier.count({ where: { numeroDevis: premiere.numero } }), 0, 'aucun chantier ouvert sous la référence');
      });

      // La référence d'une affaire portée par le chantier, annulé depuis, d'un autre devis : la
      // fiche annulée ne se corrige plus, le refus oriente donc vers la duplication du devis.
      test('une référence portée par un chantier annulé renvoie vers la duplication', async () => {
        const cible = await devisAccepte('TEST Ouverture référence annulée');
        const autre = await devisAccepte('TEST Ouverture référence annulée autre');
        const conversion = await convertir(autre.id);
        assert.equal(conversion.status, 201, JSON.stringify(conversion.body));
        const correction = await request(app).patch(`/api/chantiers/${conversion.body.id}`).set(admin()).send({ numeroDevis: cible.numero });
        assert.equal(correction.status, 200, JSON.stringify(correction.body));
        const annulation = await request(app).post(`/api/devis/${autre.id}/annulation`).set(admin()).send({ motif: 'TEST chantier de la référence annulé' });
        assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
        assert.ok(!(await aConvertir()).some((d) => d.id === cible.id), 'le devis n’est pas proposé');
        const refus = await ouvrir(cible.id, { responsableId: comptes.conducteur.id, commercialId: comptes.commercial.id });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, new RegExp(`L’affaire ${cible.numero} a déjà eu un chantier, annulé depuis : pour la reprendre, dupliquez le devis`));
        const duplication = await request(app).post(`/api/devis/${cible.id}/duplication`).set(admin());
        assert.equal(duplication.status, 201, JSON.stringify(duplication.body));
        assert.notEqual(duplication.body.numero, cible.numero);
      });

      test('refuse un titulaire, un commercial ou une date invalides, sans rien ouvrir', async () => {
        const devis = await devisAccepte('TEST Ouverture refusée');
        const cas = [
          [{ responsableId: '' }, /toujours avoir un conducteur responsable/],
          [{ responsableId: 'inconnu' }, /Conducteur responsable introuvable/],
          [{ responsableId: comptes['ancien.conducteur'].id }, /Conducteur responsable introuvable/],
          [{ responsableId: comptes.conducteur.id, commercialId: comptes.conducteur.id }, /Commercial introuvable/],
          [{ responsableId: comptes.conducteur.id, commercialId: comptes['commercial.inactif'].id }, /Commercial introuvable/],
          [{ responsableId: comptes.conducteur.id, commercialId: '' }, /toujours avoir un commercial rattaché/],
          [{ responsableId: comptes.conducteur.id, dateDebut: '31-02-2026' }, /date de début doit être valide/],
          [{ responsableId: comptes.conducteur.id, dateDebut: '' }, /date de début doit être valide/],
          [{ responsableId: comptes.conducteur.id, dateDebut: null }, /date de début doit être valide/],
        ];
        for (const [corps, motif] of cas) {
          const refus = await ouvrir(devis.id, corps);
          assert.equal(refus.status, 400, `${JSON.stringify(corps)} : ${JSON.stringify(refus.body)}`);
          assert.match(refus.body.error, motif);
        }
        assert.equal(await prisma.devisConversion.count({ where: { devisId: devis.id } }), 0, 'aucune conversion après un refus');
        assert.ok((await aConvertir()).some((d) => d.id === devis.id), 'le devis reste proposé');
      });

      test('seule une session administrateur fixe le titulaire à l’ouverture ; la conversion de l’écran Devis reste ouverte', async () => {
        const devis = await devisAccepte('TEST Ouverture par un commercial');
        const refus = await ouvrir(devis.id, { responsableId: comptes.conducteur.id }, entete('commercial'));
        assert.equal(refus.status, 403, JSON.stringify(refus.body));
        assert.match(refus.body.error, /Seule l’administration choisit le titulaire/);
        for (const champ of ['commercialId', 'types', 'dateDebut']) {
          assert.equal((await ouvrir(devis.id, { [champ]: champ === 'types' ? [] : '' }, entete('commercial'))).status, 403, champ);
        }
        const cle = await request(app).post('/api/admin/api-keys').set(admin()).send({ nom: 'TEST agent ouverture', scopes: ['devis:write'] });
        assert.equal(cle.status, 201, JSON.stringify(cle.body));
        const parCle = await request(app).post(`/api/v1/devis/${devis.id}/convertir`).set('Authorization', `Bearer ${cle.body.apiKey}`).send({ cible: 'CHANTIER', responsableId: comptes.conducteur.id });
        assert.equal(parCle.status, 403, JSON.stringify(parCle.body));
        assert.equal(await prisma.devisConversion.count({ where: { devisId: devis.id } }), 0);

        // La conversion sans ces choix, celle de l'écran Devis, reste ouverte au droit devis.
        const ouvert = await ouvrir(devis.id, {}, entete('commercial'));
        assert.equal(ouvert.status, 201, JSON.stringify(ouvert.body));
        assert.equal(ouvert.body.responsableId, null);
      });

      test('la liste des devis à convertir suit les conditions de la conversion', async () => {
        const avecAcompte = await devisAccepte('TEST Ouverture acompte attendu', { acompteExige: true });
        const revise = await devisAccepte('TEST Ouverture révisé');
        const revision = await request(app).post(`/api/devis/${revise.id}/revisions`).set(admin());
        assert.equal(revision.status, 201, JSON.stringify(revision.body));
        const nonSigne = await request(app).post('/api/devis').set(admin()).send({ clientId, objet: 'TEST Ouverture non signé', lignes: [{ designation: 'Pose', nature: 'MAIN_OEUVRE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
        assert.equal(nonSigne.status, 201, JSON.stringify(nonSigne.body));
        const proposes = (await aConvertir()).map((d) => d.id);
        for (const [devis, motif] of [[avecAcompte, 'acompte non constaté'], [revise, 'version dépassée par une révision'], [nonSigne.body, 'devis non signé'], [revision.body, 'révision brouillon']]) {
          assert.ok(!proposes.includes(devis.id), `${motif} : proposé à tort`);
        }
        // Une fois l'acompte constaté, le devis est proposé.
        const acompte = await request(app).post(`/api/devis/${avecAcompte.id}/acompte`).set(admin()).send({ recuLe: '01-10-2026', montant: 60, reference: 'TEST-VIR-OUVERTURE' });
        assert.equal(acompte.status, 200, JSON.stringify(acompte.body));
        assert.ok((await aConvertir()).some((d) => d.id === avecAcompte.id));
        // Une révision brouillon abandonnée (annulée sans conversion) rend la version précédente à
        // nouveau la dernière non annulée : elle est proposée, comme la conversion l'accepte.
        const abandon = await request(app).post(`/api/devis/${revision.body.id}/annulation`).set(admin()).send({ motif: 'TEST révision abandonnée' });
        assert.equal(abandon.status, 200, JSON.stringify(abandon.body));
        assert.ok((await aConvertir()).some((d) => d.id === revise.id), 'la version précédente redevient proposée');
        const conversionRevise = await convertir(revise.id);
        assert.equal(conversionRevise.status, 201, JSON.stringify(conversionRevise.body));
        // Liste réservée à qui peut convertir.
        assert.equal((await request(app).get('/api/devis/a-convertir').set(entete('conducteur'))).status, 403);
        assert.equal((await request(app).get('/api/v1/devis/a-convertir').set('Authorization', `Bearer ${cleApi}`)).status, 404);
      });

      // Formulaires voisins de l'Administration : un doublon remontait en erreur 500, sans message.
      test('fournisseurs et catégories refusent un nom vide ou déjà pris, avec un message', async () => {
        for (const [chemin, nom, motif] of [['/api/fournisseurs', 'TEST Ouverture fournisseur', /Un fournisseur porte déjà ce nom/], ['/api/categories', 'TEST Ouverture catégorie', /Une catégorie porte déjà ce nom/]]) {
          const cree = await request(app).post(chemin).set(admin()).send({ nom: `  ${nom}  ` });
          assert.equal(cree.status, 200, JSON.stringify(cree.body));
          assert.equal(cree.body.nom, nom, 'le nom est enregistré sans espaces autour');
          const doublon = await request(app).post(chemin).set(admin()).send({ nom });
          assert.equal(doublon.status, 409, JSON.stringify(doublon.body));
          assert.match(doublon.body.error, motif);
          const vide = await request(app).post(chemin).set(admin()).send({ nom: '   ' });
          assert.equal(vide.status, 400, JSON.stringify(vide.body));
          assert.match(vide.body.error, /est obligatoire/);
        }
      });

      test('un chantier se réattribue à un autre conducteur au départ de son titulaire', async () => {
        const devis = await devisAccepte('TEST Ouverture départ du conducteur');
        const ouvert = await ouvrir(devis.id, { responsableId: comptes.conducteur.id, commercialId: comptes.commercial.id });
        assert.equal(ouvert.status, 201, JSON.stringify(ouvert.body));
        await prisma.user.update({ where: { id: comptes.conducteur.id }, data: { actif: false } });
        try {
          // Corriger la fiche sans toucher au titulaire désactivé reste possible.
          const correction = await request(app).patch(`/api/chantiers/${ouvert.body.id}`).set(admin()).send({ nom: 'TEST Ouverture départ corrigé', responsableId: comptes.conducteur.id });
          assert.equal(correction.status, 200, JSON.stringify(correction.body));
          // Il ne peut pas être réattribué à un compte désactivé, mais à un conducteur actif, oui.
          const versInactif = await request(app).patch(`/api/chantiers/${ouvert.body.id}`).set(admin()).send({ responsableId: comptes['ancien.conducteur'].id });
          assert.equal(versInactif.status, 400, JSON.stringify(versInactif.body));
          const reattribution = await request(app).patch(`/api/chantiers/${ouvert.body.id}`).set(admin()).send({ responsableId: comptes['autre.conducteur'].id });
          assert.equal(reattribution.status, 200, JSON.stringify(reattribution.body));
          assert.equal((await prisma.chantier.findUnique({ where: { id: ouvert.body.id } })).responsableId, comptes['autre.conducteur'].id);
          const fiche = await request(app).get(`/api/chantiers/${ouvert.body.id}`).set(entete('autre.conducteur'));
          assert.equal(fiche.status, 200, 'le nouveau titulaire voit le chantier');
          // Le commercial désactivé reste rattaché ; un commercial inactif ne se choisit pas.
          await prisma.user.update({ where: { id: comptes.commercial.id }, data: { actif: false } });
          const commercialInchange = await request(app).patch(`/api/chantiers/${ouvert.body.id}/commercial`).set(admin()).send({ commercialId: comptes.commercial.id });
          assert.equal(commercialInchange.status, 200, JSON.stringify(commercialInchange.body));
          const commercialInactif = await request(app).patch(`/api/chantiers/${ouvert.body.id}/commercial`).set(admin()).send({ commercialId: comptes['commercial.inactif'].id });
          assert.equal(commercialInactif.status, 400, JSON.stringify(commercialInactif.body));
          const sansCommercial = await request(app).patch(`/api/chantiers/${ouvert.body.id}/commercial`).set(admin()).send({ commercialId: null });
          assert.equal(sansCommercial.status, 400, JSON.stringify(sansCommercial.body));
          assert.match(sansCommercial.body.error, /toujours avoir un commercial rattaché/);
        } finally {
          await prisma.user.updateMany({ where: { id: { in: [comptes.conducteur.id, comptes.commercial.id] } }, data: { actif: true } });
        }
      });
    });
  });

  describe('Technicien : fiche intervenant, planning en consultation, file curative (lot pilote 3a)', () => {
    let admin = {};
    let clientId = '';
    const comptes = {};
    const jeton = (compte) => ({ Authorization: `Bearer ${jwt.sign({ id: compte.id }, process.env.JWT_SECRET)}` });
    // Le corps est calculé AVANT la requête : `request(app)` ouvre un serveur éphémère qu'une
    // exception levée en construisant le corps laisserait ouvert.
    const envoyer = (methode, chemin, enTete, corps) => request(app)[methode](chemin).set(enTete).send(corps);
    const journalFiche = (userId) => prisma.journalAdministration.findMany({ where: { action: 'FICHE_INTERVENANT', cibleId: userId }, orderBy: { createdAt: 'asc' } });
    const voitLeDossier = async (enTete, interventionId) => (await request(app).get('/api/interventions').set(enTete)).body.some((item) => item.id === interventionId);

    before(async () => {
      const secours = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      admin = { Authorization: `Bearer ${secours.body.token}` };
      for (const [cle, email, role, actif] of [
        ['technicien', 'pilote3.technicien@iris.test', 'TECHNICIEN', true],
        ['autre', 'pilote3.autre.technicien@iris.test', 'TECHNICIEN', true],
        ['inactif', 'pilote3.inactif@iris.test', 'TECHNICIEN', false],
        ['conducteur', 'pilote3.conducteur@iris.test', 'CONDUCTEUR_TRAVAUX', true],
        ['tiers', 'pilote3.tiers@iris.test', 'CONDUCTEUR_TRAVAUX', true],
      ]) comptes[cle] = await prisma.user.create({ data: { email, name: `TEST Pilote3 ${cle}`, role, actif } });
      const client = await request(app).post('/api/clients').set(admin).send({ raisonSociale: 'TEST Client pilote 3' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      clientId = client.body.id;
    });

    test('l’administration relie un compte technicien actif à sa fiche, et chaque changement est journalisé', async () => {
      const fiche = await prisma.intervenant.create({ data: { nom: 'TEST Pilote3 fiche', role: 'Technicien', tauxHoraireCharge: 40 } });
      const autreFiche = await prisma.intervenant.create({ data: { nom: 'TEST Pilote3 autre fiche', role: 'Technicien', tauxHoraireCharge: 40 } });
      const relier = (enTete, id, userId) => envoyer('put', `/api/intervenants/${id}/compte`, enTete, { userId });
      // Réservé à l'administration.
      assert.equal((await relier(jeton(comptes.conducteur), fiche.id, comptes.technicien.id)).status, 403);
      assert.equal((await relier(jeton(comptes.technicien), fiche.id, comptes.technicien.id)).status, 403);
      assert.equal((await request(app).put(`/api/intervenants/${fiche.id}/compte`).send({ userId: comptes.technicien.id })).status, 401);
      // Seul un compte technicien actif.
      for (const [qui, userId] of [['conducteur', comptes.conducteur.id], ['inactif', comptes.inactif.id], ['inconnu', '00000000-0000-0000-0000-000000000000']]) {
        const refus = await relier(admin, fiche.id, userId);
        assert.equal(refus.status, 400, `${qui} : ${JSON.stringify(refus.body)}`);
      }
      assert.equal((await relier(admin, fiche.id, '')).status, 400);
      assert.equal((await relier(admin, fiche.id, 42)).status, 400);
      assert.equal((await relier(admin, 'fiche-inconnue', comptes.technicien.id)).status, 404);
      assert.equal((await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId, null);
      assert.equal((await journalFiche(comptes.technicien.id)).length, 0);
      // Lien, puis enregistrement à l'identique : une seule entrée.
      const lien = await relier(admin, fiche.id, comptes.technicien.id);
      assert.equal(lien.status, 200, JSON.stringify(lien.body));
      assert.equal(lien.body.userId, comptes.technicien.id);
      assert.equal(!('tauxHoraireCharge' in lien.body) || typeof lien.body.tauxHoraireCharge === 'number', true);
      assert.equal((await relier(admin, fiche.id, comptes.technicien.id)).status, 200);
      const [entree] = await journalFiche(comptes.technicien.id);
      assert.equal((await journalFiche(comptes.technicien.id)).length, 1);
      assert.deepEqual([entree.domaine, entree.type, entree.avant, entree.apres], ['DROITS', 'COMPTE', { ficheIntervenant: null }, { ficheIntervenant: 'TEST Pilote3 fiche' }]);
      assert.match(entree.cibleLibelle, /pilote3\.technicien@iris\.test/);
      // Un compte déjà relié ne l'est pas à une seconde fiche.
      const doublon = await relier(admin, autreFiche.id, comptes.technicien.id);
      assert.equal(doublon.status, 409, JSON.stringify(doublon.body));
      assert.equal((await prisma.intervenant.findUnique({ where: { id: autreFiche.id } })).userId, null);
      // Passage à un autre compte : une entrée pour chacun.
      assert.equal((await relier(admin, fiche.id, comptes.autre.id)).status, 200);
      assert.deepEqual((await journalFiche(comptes.technicien.id)).map((e) => e.apres), [{ ficheIntervenant: 'TEST Pilote3 fiche' }, { ficheIntervenant: null }]);
      assert.deepEqual((await journalFiche(comptes.autre.id)).map((e) => e.apres), [{ ficheIntervenant: 'TEST Pilote3 fiche' }]);
      // Déliée, puis supprimée reliée : la suppression délie aussi, et le journal le dit.
      assert.equal((await relier(admin, fiche.id, null)).status, 200);
      assert.equal((await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId, null);
      assert.deepEqual((await journalFiche(comptes.autre.id)).map((e) => e.apres), [{ ficheIntervenant: 'TEST Pilote3 fiche' }, { ficheIntervenant: null }]);
      assert.equal((await relier(admin, autreFiche.id, comptes.autre.id)).status, 200);
      assert.equal((await request(app).delete(`/api/intervenants/${autreFiche.id}`).set(admin)).status, 200);
      const derniere = (await journalFiche(comptes.autre.id)).at(-1);
      assert.deepEqual([derniere.avant, derniere.apres, derniere.detail], [{ ficheIntervenant: 'TEST Pilote3 autre fiche' }, { ficheIntervenant: null }, `Fiche intervenant supprimée (${autreFiche.id}).`]);
      await prisma.intervenant.delete({ where: { id: fiche.id } });
    });

    test('un compte qui quitte le type technicien perd sa fiche : journalisé, et ses interventions se ferment', async () => {
      const compte = await prisma.user.create({ data: { email: 'pilote3.reconverti@iris.test', name: 'TEST Pilote3 reconverti', role: 'TECHNICIEN' } });
      const promu = await prisma.user.create({ data: { email: 'pilote3.promu@iris.test', name: 'TEST Pilote3 promu', role: 'TECHNICIEN' } });
      const simpleAdmin = await prisma.user.create({ data: { email: 'pilote3.admin@iris.test', name: 'TEST Pilote3 admin', role: 'ADMIN' } });
      const fiche = await prisma.intervenant.create({ data: { nom: 'TEST Pilote3 reconversion', role: 'Technicien', tauxHoraireCharge: 40 } });
      const fichePromu = await prisma.intervenant.create({ data: { nom: 'TEST Pilote3 promotion', role: 'Technicien', tauxHoraireCharge: 40 } });
      try {
        assert.equal((await envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, { userId: compte.id })).status, 200);
        assert.equal((await envoyer('put', `/api/intervenants/${fichePromu.id}/compte`, admin, { userId: promu.id })).status, 200);
        const dossier = await envoyer('post', '/api/interventions', admin, { clientId, titre: 'TEST Pilote3 dossier du reconverti' });
        assert.equal((await envoyer('put', `/api/interventions/${dossier.body.id}/planning`, admin, { dateDebut: '2099-11-10', creneau: 'JOURNEE', intervenantIds: [fiche.id] })).status, 200);
        assert.equal(await voitLeDossier(jeton(compte), dossier.body.id), true, 'témoin : technicien relié');
        // Devenu comptable : fiche déliée, entrée au journal, dossier fermé (lecture, placement, statut).
        const reconversion = await envoyer('patch', `/api/users/${compte.id}/role`, admin, { role: 'COMPTABLE' });
        assert.equal(reconversion.status, 200, JSON.stringify(reconversion.body));
        assert.equal((await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId, null);
        const entree = (await journalFiche(compte.id)).at(-1);
        assert.deepEqual([entree.avant, entree.apres, entree.detail, entree.concerneSuperAdmin], [{ ficheIntervenant: 'TEST Pilote3 reconversion' }, { ficheIntervenant: null }, `Type de compte modifié ; fiche intervenant ${fiche.id}.`, false]);
        assert.equal(await voitLeDossier(jeton(compte), dossier.body.id), false);
        assert.equal((await envoyer('put', `/api/interventions/${dossier.body.id}/planning`, jeton(compte), { dateDebut: '2099-11-11', creneau: 'JOURNEE', intervenantIds: [fiche.id] })).status, 404);
        assert.equal((await envoyer('patch', `/api/interventions/${dossier.body.id}/statut`, jeton(compte), { statut: 'ANNULEE' })).status, 404);
        assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: dossier.body.id } })).statut, 'PLANIFIEE');
        // Revenu technicien, il ne retrouve pas sa fiche : il faut la relier de nouveau.
        assert.equal((await envoyer('patch', `/api/users/${compte.id}/role`, admin, { role: 'TECHNICIEN' })).status, 200);
        assert.equal((await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId, null);
        // Promu super administrateur : fiche déliée, entrée réservée au super administrateur.
        assert.equal((await envoyer('patch', `/api/users/${promu.id}/role`, admin, { role: 'SUPERADMIN' })).status, 200);
        assert.equal((await prisma.intervenant.findUnique({ where: { id: fichePromu.id } })).userId, null);
        const promotion = (await journalFiche(promu.id)).at(-1);
        assert.deepEqual([promotion.apres, promotion.concerneSuperAdmin], [{ ficheIntervenant: null }, true]);
        // L'entrée du lien, posé quand le compte était technicien, reste visible de tous les
        // administrateurs ; celle de la déliaison, qui concerne un super administrateur, est fermée
        // au simple administrateur.
        const lirePour = async (enTete) => (await request(app).get('/api/journal-administration').query({ cible: promu.id }).set(enTete)).body.entrees
          .filter((e) => e.action === 'FICHE_INTERVENANT').map((e) => e.apres.ficheIntervenant);
        assert.deepEqual(await lirePour(admin), [null, 'TEST Pilote3 promotion'], 'super administrateur : déliaison puis lien, du plus récent au plus ancien');
        assert.deepEqual(await lirePour(jeton(simpleAdmin)), ['TEST Pilote3 promotion'], 'simple administrateur : sans la déliaison');
      } finally {
        await prisma.user.deleteMany({ where: { id: { in: [promu.id] } } });
      }
    });

    test('un simple administrateur ne délie ni ne supprime la fiche d’un compte super administrateur', async () => {
      const superCompte = await prisma.user.create({ data: { email: 'pilote3.superadmin@iris.test', name: 'TEST Pilote3 superadmin', role: 'SUPERADMIN' } });
      const simpleAdmin = await prisma.user.findUniqueOrThrow({ where: { email: 'pilote3.admin@iris.test' } }).catch(() => prisma.user.create({ data: { email: 'pilote3.admin@iris.test', name: 'TEST Pilote3 admin', role: 'ADMIN' } }));
      // Lien d'avant cette PR, posé en base (aucune route ne relie un compte non technicien).
      const fiche = await prisma.intervenant.create({ data: { nom: 'TEST Pilote3 fiche super', role: 'Technicien', tauxHoraireCharge: 40, userId: superCompte.id } });
      try {
        const avant = await journalFiche(superCompte.id);
        const deliaison = await envoyer('put', `/api/intervenants/${fiche.id}/compte`, jeton(simpleAdmin), { userId: null });
        assert.equal(deliaison.status, 403, JSON.stringify(deliaison.body));
        assert.equal((await request(app).delete(`/api/intervenants/${fiche.id}`).set(jeton(simpleAdmin))).status, 403);
        assert.equal((await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId, superCompte.id);
        assert.equal((await journalFiche(superCompte.id)).length, avant.length);
        // Le super administrateur, lui, la délie, puis supprime une fiche reliée : entrées fermées au
        // simple administrateur.
        const lirePour = async (enTete) => (await request(app).get('/api/journal-administration').query({ cible: superCompte.id }).set(enTete)).body.entrees
          .filter((e) => e.action === 'FICHE_INTERVENANT').map((e) => e.detail);
        assert.equal((await envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, { userId: null })).status, 200);
        assert.equal((await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId, null);
        assert.equal((await journalFiche(superCompte.id)).at(-1).concerneSuperAdmin, true, 'déliaison fermée');
        await prisma.intervenant.update({ where: { id: fiche.id }, data: { userId: superCompte.id } });
        assert.equal((await request(app).delete(`/api/intervenants/${fiche.id}`).set(admin)).status, 200);
        const suppression = (await journalFiche(superCompte.id)).at(-1);
        assert.deepEqual([suppression.detail, suppression.concerneSuperAdmin], [`Fiche intervenant supprimée (${fiche.id}).`, true]);
        assert.deepEqual(await lirePour(admin), [`Fiche intervenant supprimée (${fiche.id}).`, `Fiche intervenant ${fiche.id}.`]);
        assert.deepEqual(await lirePour(jeton(simpleAdmin)), [], 'rien pour le simple administrateur');
      } finally {
        await prisma.intervenant.deleteMany({ where: { id: fiche.id } });
        await prisma.user.deleteMany({ where: { id: superCompte.id } });
      }
    });

    test('la promotion du démarrage (SUPERADMIN_EMAILS) délie la fiche d’un technicien, sans auteur et fermée au simple administrateur', async () => {
      const compte = await prisma.user.create({ data: { email: 'pilote3.demarrage@iris.test', name: 'TEST Pilote3 démarrage', role: 'TECHNICIEN' } });
      const fiche = await prisma.intervenant.create({ data: { nom: 'TEST Pilote3 fiche démarrage', role: 'Technicien', tauxHoraireCharge: 40 } });
      const emails = process.env.SUPERADMIN_EMAILS;
      try {
        assert.equal((await envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, { userId: compte.id })).status, 200);
        process.env.SUPERADMIN_EMAILS = `${emails},${compte.email}`;
        await ensureSuperAdmins();
        process.env.SUPERADMIN_EMAILS = emails;
        assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: compte.id } })).role, 'SUPERADMIN');
        assert.equal((await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId, null);
        const entree = (await journalFiche(compte.id)).at(-1);
        assert.deepEqual([entree.apres, entree.auteurId, entree.auteurNom, entree.concerneSuperAdmin], [{ ficheIntervenant: null }, null, 'Iris (démarrage, SUPERADMIN_EMAILS)', true]);
      } finally {
        process.env.SUPERADMIN_EMAILS = emails;
        await prisma.user.deleteMany({ where: { id: compte.id } });
      }
    });

    test('un changement de type simultané à une liaison ne laisse jamais la fiche reliée à un compte non technicien', async () => {
      const issues = { deliee: 0, refusChangement: 0, refusLien: 0 };
      for (let essai = 0; essai < 20; essai += 1) {
        const compte = await prisma.user.create({ data: { email: `pilote3.course.${essai}@iris.test`, name: `TEST Pilote3 course ${essai}`, role: 'TECHNICIEN' } });
        const fiche = await prisma.intervenant.create({ data: { nom: `TEST Pilote3 course ${essai}`, role: 'Technicien', tauxHoraireCharge: 40 } });
        const corpsType = { role: 'COMPTABLE' };
        const corpsLien = { userId: compte.id };
        const [changement, lien] = await Promise.all([envoyer('patch', `/api/users/${compte.id}/role`, admin, corpsType), envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, corpsLien)]);
        const role = (await prisma.user.findUniqueOrThrow({ where: { id: compte.id } })).role;
        const relie = (await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId === compte.id;
        assert.equal(relie && role !== 'TECHNICIEN', false, `essai ${essai} : ${changement.status}/${lien.status}, ${role}, relié=${relie}`);
        if (changement.status === 409) issues.refusChangement += 1;
        else if (lien.status === 400) issues.refusLien += 1;
        else issues.deliee += 1;
        assert.ok([200, 409].includes(changement.status) && [200, 400].includes(lien.status), `essai ${essai} : ${changement.status}/${lien.status}`);
      }
      assert.equal(issues.deliee + issues.refusChangement + issues.refusLien, 20);
    });

    test('la suppression d’un compte relié mentionne la fiche déliée, même reliée au même moment', async () => {
      for (let essai = 0; essai < 10; essai += 1) {
        const compte = await prisma.user.create({ data: { email: `pilote3.suppression.${essai}@iris.test`, name: `TEST Pilote3 suppression ${essai}`, role: 'TECHNICIEN' } });
        const fiche = await prisma.intervenant.create({ data: { nom: `TEST Pilote3 suppression ${essai}`, role: 'Technicien', tauxHoraireCharge: 40 } });
        const corpsLien = { userId: compte.id };
        // Premier essai sans concurrence : la fiche est reliée avant la suppression.
        if (essai === 0) assert.equal((await envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, corpsLien)).status, 200);
        const [suppression, lien] = await Promise.all([
          request(app).delete(`/api/users/${compte.id}`).set(admin),
          essai === 0 ? Promise.resolve({ status: 200 }) : envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, corpsLien),
        ]);
        assert.equal(suppression.status, 200, JSON.stringify(suppression.body));
        assert.ok([200, 400].includes(lien.status), `essai ${essai} : liaison ${lien.status}`);
        assert.equal((await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId, null);
        const entree = await prisma.journalAdministration.findFirst({ where: { action: 'SUPPRESSION', cibleId: compte.id } });
        const mention = `fiche intervenant « ${fiche.nom} » (${fiche.id}) déliée`;
        // Reliée avant la suppression (liaison réussie) : l'entrée la mentionne ; sinon, non.
        assert.equal((entree.detail ?? '').includes(mention), lien.status === 200, `essai ${essai} : liaison ${lien.status}, détail ${entree.detail}`);
      }
    });

    test('un changement de type pendant la suppression du compte répond 404, jamais 500', async () => {
      for (let essai = 0; essai < 15; essai += 1) {
        const compte = await prisma.user.create({ data: { email: `pilote3.supprtype.${essai}@iris.test`, name: `TEST Pilote3 suppression type ${essai}`, role: 'TECHNICIEN' } });
        const corpsType = { role: 'COMPTABLE' };
        const [suppression, changement] = await Promise.all([request(app).delete(`/api/users/${compte.id}`).set(admin), envoyer('patch', `/api/users/${compte.id}/role`, admin, corpsType)]);
        assert.ok([200, 404].includes(suppression.status), `essai ${essai} : suppression ${suppression.status}`);
        assert.ok([200, 404].includes(changement.status), `essai ${essai} : changement ${changement.status} ${JSON.stringify(changement.body)}`);
      }
    });

    test('deux liaisons simultanées de la même fiche laissent un journal cohérent avec le lien final', async () => {
      const a = await prisma.user.create({ data: { email: 'pilote3.concurrent.a@iris.test', name: 'TEST Pilote3 concurrent A', role: 'TECHNICIEN' } });
      const b = await prisma.user.create({ data: { email: 'pilote3.concurrent.b@iris.test', name: 'TEST Pilote3 concurrent B', role: 'TECHNICIEN' } });
      for (let essai = 0; essai < 5; essai += 1) {
        const fiche = await prisma.intervenant.create({ data: { nom: `TEST Pilote3 concurrence ${essai}`, role: 'Technicien', tauxHoraireCharge: 40 } });
        const corpsA = { userId: a.id };
        const corpsB = { userId: b.id };
        const reponses = await Promise.all([envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, corpsA), envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, corpsB)]);
        assert.deepEqual(reponses.map((r) => r.status), [200, 200], JSON.stringify(reponses.map((r) => r.body)));
        const final = (await prisma.intervenant.findUnique({ where: { id: fiche.id } })).userId;
        const autre = final === a.id ? b.id : a.id;
        const entrees = await prisma.journalAdministration.findMany({ where: { action: 'FICHE_INTERVENANT', detail: `Fiche intervenant ${fiche.id}.` }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        const deCompte = (id) => entrees.filter((e) => e.cibleId === id).map((e) => e.apres.ficheIntervenant);
        assert.deepEqual(deCompte(final), [fiche.nom], `essai ${essai} : le compte final est relié une fois`);
        assert.deepEqual(deCompte(autre), [fiche.nom, null], `essai ${essai} : l’autre compte est relié puis délié`);
        await prisma.intervenant.update({ where: { id: fiche.id }, data: { userId: null } });
      }
    });

    test('la file à planifier propose les curatives ; placée, l’intervention s’ouvre au technicien relié', async () => {
      const fiche = await prisma.intervenant.create({ data: { nom: 'TEST Pilote3 placement', role: 'Technicien', tauxHoraireCharge: 40 } });
      assert.equal((await envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, { userId: comptes.technicien.id })).status, 200);
      const tard = await envoyer('post', '/api/interventions', admin, { clientId, titre: 'TEST Pilote3 curative tardive', dateSouhaitee: '20-12-2099' });
      const tot = await envoyer('post', '/api/interventions', admin, { clientId, titre: 'TEST Pilote3 curative urgente', dateSouhaitee: '01-12-2099' });
      const sansDate = await envoyer('post', '/api/interventions', jeton(comptes.conducteur), { clientId, titre: 'TEST Pilote3 curative du conducteur' });
      for (const r of [tard, tot, sansDate]) assert.equal(r.status, 201, JSON.stringify(r.body));
      const file = await request(app).get('/api/planning/interventions-a-planifier').set(admin);
      assert.equal(file.status, 200, JSON.stringify(file.body));
      const ids = file.body.map((item) => item.id);
      const curative = file.body.find((item) => item.id === tot.body.id);
      assert.deepEqual([curative.contratMaintenance, curative.dureePrevisionnelleMinutes, curative.echeanceContrat, curative.dateSouhaitee.slice(0, 10)], [null, null, null, '2099-12-01']);
      assert.ok(ids.indexOf(tot.body.id) < ids.indexOf(tard.body.id), 'par date souhaitée');
      assert.ok(ids.indexOf(tard.body.id) < ids.indexOf(sansDate.body.id), 'sans date en dernier');
      // Le conducteur voit la curative qu'il a ouverte ; un autre conducteur ne la voit pas.
      assert.equal((await request(app).get('/api/planning/interventions-a-planifier').set(jeton(comptes.conducteur))).body.some((i) => i.id === sansDate.body.id), true);
      assert.equal((await request(app).get('/api/planning/interventions-a-planifier').set(jeton(comptes.tiers))).body.some((i) => i.id === sansDate.body.id), false);
      // Placement par l'administration : la curative quitte la file et s'ouvre au technicien relié.
      assert.equal(await voitLeDossier(jeton(comptes.technicien), tot.body.id), false);
      const place = await envoyer('put', `/api/interventions/${tot.body.id}/planning`, admin, { dateDebut: '2099-12-01', creneau: 'HEURES', heureDebut: '09:00', heureFin: '10:00', intervenantIds: [fiche.id] });
      assert.equal(place.status, 200, JSON.stringify(place.body));
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: tot.body.id } })).statut, 'PLANIFIEE');
      assert.equal((await request(app).get('/api/planning/interventions-a-planifier').set(admin)).body.some((i) => i.id === tot.body.id), false);
      assert.equal(await voitLeDossier(jeton(comptes.technicien), tot.body.id), true);
      // Délié, le technicien ne voit plus le dossier.
      assert.equal((await envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, { userId: null })).status, 200);
      assert.equal(await voitLeDossier(jeton(comptes.technicien), tot.body.id), false);
    });

    test('le technicien ne modifie ni le planning, ni sa propre intervention planifiée, ni les référentiels', async () => {
      const fiche = await prisma.intervenant.create({ data: { nom: 'TEST Pilote3 lecture seule', role: 'Technicien', tauxHoraireCharge: 40 } });
      assert.equal((await envoyer('put', `/api/intervenants/${fiche.id}/compte`, admin, { userId: comptes.technicien.id })).status, 200);
      const dossier = await envoyer('post', '/api/interventions', admin, { clientId, titre: 'TEST Pilote3 dossier affecté' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      const placement = await envoyer('put', `/api/interventions/${dossier.body.id}/planning`, admin, { dateDebut: '2099-11-02', creneau: 'JOURNEE', intervenantIds: [fiche.id] });
      assert.equal(placement.status, 200, JSON.stringify(placement.body));
      const libre = await envoyer('post', '/api/planning/events', admin, { categorie: 'HORS_CHANTIER', titre: 'TEST Pilote3 événement libre', dateDebut: '2099-11-03', intervenantIds: [fiche.id] });
      assert.equal(libre.status, 201, JSON.stringify(libre.body));
      const type = await prisma.planningEventType.create({ data: { nom: `TEST Pilote3 type ${Date.now()}`, couleur: '#123456' } });
      const categorie = await prisma.categorie.create({ data: { nom: 'TEST Pilote3 catégorie' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: 'TEST Pilote3 fournisseur' } });
      try {
        const technicien = jeton(comptes.technicien);
        assert.equal(await voitLeDossier(technicien, dossier.body.id), true, 'témoin : le dossier lui est bien ouvert');
        const avant = {
          evenements: await prisma.planningEvent.findMany({ where: { id: { in: [placement.body.id, libre.body.id] } }, include: { intervenants: { select: { id: true } } }, orderBy: { id: 'asc' } }),
          affectations: await prisma.interventionAffectation.findMany({ where: { interventionId: dossier.body.id } }),
          types: await prisma.planningEventType.count(), categories: await prisma.categorie.count(), fournisseurs: await prisma.fournisseur.count(),
        };
        for (const [libelle, appel] of [
          ['créer une affectation', () => envoyer('post', '/api/planning/events', technicien, { categorie: 'HORS_CHANTIER', titre: 'TEST Pilote3 refus', dateDebut: '2099-11-04', intervenantIds: [fiche.id] })],
          ['déplacer une affectation libre', () => envoyer('patch', `/api/planning/events/${libre.body.id}`, technicien, { dateDebut: '2099-11-05' })],
          ['supprimer une affectation libre', () => request(app).delete(`/api/planning/events/${libre.body.id}`).set(technicien)],
          ['changer les intervenants de sa projection', () => envoyer('patch', `/api/planning/events/${placement.body.id}`, technicien, { intervenantIds: [] })],
          ['replanifier sa propre intervention', () => envoyer('put', `/api/interventions/${dossier.body.id}/planning`, technicien, { dateDebut: '2099-11-06', creneau: 'JOURNEE', intervenantIds: [fiche.id] })],
          ['créer un type', () => envoyer('post', '/api/planning/types', technicien, { nom: 'TEST Pilote3 type refusé', couleur: '#654321' })],
          ['modifier un type', () => envoyer('put', `/api/planning/types/${type.id}`, technicien, { nom: 'TEST Pilote3 renommé', couleur: '#000000' })],
          ['supprimer un type', () => request(app).delete(`/api/planning/types/${type.id}`).set(technicien)],
          ['créer une catégorie', () => envoyer('post', '/api/categories', technicien, { nom: 'TEST Pilote3 catégorie refusée' })],
          ['modifier une catégorie', () => envoyer('put', `/api/categories/${categorie.id}`, technicien, { nom: 'TEST Pilote3 renommée' })],
          ['supprimer une catégorie', () => request(app).delete(`/api/categories/${categorie.id}`).set(technicien)],
          ['créer un fournisseur', () => envoyer('post', '/api/fournisseurs', technicien, { nom: 'TEST Pilote3 fournisseur refusé' })],
          ['modifier un fournisseur', () => envoyer('put', `/api/fournisseurs/${fournisseur.id}`, technicien, { nom: 'TEST Pilote3 renommé' })],
          ['supprimer un fournisseur', () => request(app).delete(`/api/fournisseurs/${fournisseur.id}`).set(technicien)],
        ]) {
          const refus = await appel();
          assert.equal(refus.status, 403, `${libelle} : ${refus.status} ${JSON.stringify(refus.body)}`);
        }
        assert.deepEqual({
          evenements: await prisma.planningEvent.findMany({ where: { id: { in: [placement.body.id, libre.body.id] } }, include: { intervenants: { select: { id: true } } }, orderBy: { id: 'asc' } }),
          affectations: await prisma.interventionAffectation.findMany({ where: { interventionId: dossier.body.id } }),
          types: await prisma.planningEventType.count(), categories: await prisma.categorie.count(), fournisseurs: await prisma.fournisseur.count(),
        }, avant, 'aucune écriture');
        assert.deepEqual([(await prisma.categorie.findUnique({ where: { id: categorie.id } })).nom, (await prisma.fournisseur.findUnique({ where: { id: fournisseur.id } })).nom], ['TEST Pilote3 catégorie', 'TEST Pilote3 fournisseur']);
        // Il garde la lecture du planning et des référentiels.
        assert.equal((await request(app).get('/api/planning/events?start=2099-11-02&end=2099-11-03').set(technicien)).status, 200);
        assert.equal((await request(app).get('/api/categories').set(technicien)).status, 200);
        // Témoin : le conducteur garde ces écritures.
        const parConducteur = await envoyer('post', '/api/categories', jeton(comptes.conducteur), { nom: 'TEST Pilote3 catégorie du conducteur' });
        assert.equal(parConducteur.status, 200, JSON.stringify(parConducteur.body));
      } finally {
        await prisma.planningEvent.deleteMany({ where: { id: libre.body.id } });
        await prisma.planningEventType.delete({ where: { id: type.id } }).catch(() => {});
      }
    });
  });

  describe('Interventions SAV', () => {
    let session = '';
    let clientId = '';
    const compteTechnicienSav = async (email, nom) => {
      const compte = await prisma.user.create({ data: { email, name: nom, role: 'TECHNICIEN' } });
      const intervenant = await prisma.intervenant.create({ data: { nom, role: 'Technicien', tauxHoraireCharge: 42, userId: compte.id } });
      return { jeton: jwt.sign({ id: compte.id }, process.env.JWT_SECRET), intervenantId: intervenant.id };
    };
    const voitLeDossier = async (jeton, interventionId) => {
      const liste = await request(app).get('/api/interventions').set('Authorization', `Bearer ${jeton}`);
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      return liste.body.some((item) => item.id === interventionId);
    };

    before(async () => {
      session = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      clientId = (await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Client intervention' })).body.id;
    });

    test('ne laisse pas un technicien non affecté modifier un dossier invisible', async () => {
      const technicien = await compteTechnicienSav('sav.non-affecte@iris.test', 'TEST Intervenant SAV non affecté');
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`).send({ clientId, titre: 'TEST Dossier privé SAV' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(await voitLeDossier(technicien.jeton, creation.body.id), false);
      const mutation = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${technicien.jeton}`).send({ statut: 'PLANIFIEE' });
      assert.equal(mutation.status, 404, JSON.stringify(mutation.body));
    });

    test('journalise de façon immuable chaque changement de statut SAV', async () => {
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Journal SAV' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const transition = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${session}`)
        .send({ statut: 'PLANIFIEE' });
      assert.equal(transition.status, 200, JSON.stringify(transition.body));

      const journal = await request(app).get(`/api/interventions/${creation.body.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.some((entree) => entree.action === 'CREATION' && entree.apres?.reference === creation.body.reference), true);
      const changement = journal.body.find((entree) => entree.action === 'CHANGEMENT_STATUT');
      assert.equal(changement.avant.statut, 'A_PLANIFIER');
      assert.equal(changement.apres.statut, 'PLANIFIEE');
      // Les deux instantanés sont contractuels et doivent rester comparables : une forme
      // différente ferait lire une transition comme un ajout de données au dossier.
      assert.deepEqual(Object.keys(changement.avant).sort(), Object.keys(changement.apres).sort());
      assert.equal(changement.auteurId, creation.body.createdById);
    });

    test('la base impose un unique parent pour chaque trace de journal', async () => {
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await assert.rejects(() => prisma.journalSaisieChantier.create({ data: {
        chantierId: null, interventionId: null, cible: 'INTERVENTION', cibleId: 'TEST-parent-absent', action: 'CREATION', auteurId: auteur.id, auteurNom: 'TEST',
      } }));
      await assert.rejects(() => prisma.journalSaisieChantier.create({ data: {
        chantierId: 'TEST-chantier-inexistant', interventionId: 'TEST-intervention-inexistante', cible: 'INTERVENTION', cibleId: 'TEST-double-parent', action: 'CREATION', auteurId: auteur.id, auteurNom: 'TEST',
      } }));
    });

    test('ferme le journal d’un dossier à un technicien non affecté', async () => {
      const technicien = await compteTechnicienSav('sav.journal@iris.test', 'TEST Intervenant SAV journal');
      const dossier = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Dossier journal fermé', description: 'Détail confidentiel.' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      assert.equal(await voitLeDossier(technicien.jeton, dossier.body.id), false);
      // Le journal porte l'instantané complet d'un dossier : il ne doit jamais révéler les
      // données d'une intervention que le technicien ne peut pas voir dans sa liste.
      const journal = await request(app).get(`/api/interventions/${dossier.body.id}/journal-saisies`).set('Authorization', `Bearer ${technicien.jeton}`);
      assert.equal(journal.status, 404, JSON.stringify(journal.body));
    });

    test('rattache un site et un contact appartenant au client du dossier SAV', async () => {
      const site = await prisma.clientSite.create({ data: { clientId, nom: 'TEST Site SAV', adresse: '1 rue du Test', codePostal: '75001', ville: 'Paris' } });
      const contact = await prisma.clientContact.create({ data: { clientId, nom: 'TEST Contact SAV' } });
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, siteId: site.id, contactId: contact.id, titre: 'TEST Rattachements SAV' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.site.id, site.id);
      assert.equal(creation.body.contact.id, contact.id);
    });

    test('refuse un site ou contact rattaché à un autre client', async () => {
      const autreClient = await prisma.client.create({ data: { raisonSociale: 'TEST Client étranger SAV', actif: true } });
      const siteEtranger = await prisma.clientSite.create({ data: { clientId: autreClient.id, nom: 'TEST Site étranger', adresse: '2 rue du Test', codePostal: '69001', ville: 'Lyon' } });
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, siteId: siteEtranger.id, titre: 'TEST Cloisonnement client SAV' });
      assert.equal(creation.status, 404, JSON.stringify(creation.body));
    });

    test('rattache un chantier lié à la fiche du client, quel que soit son libellé (décision du 16-10-2026)', async () => {
      // Libellé différent de la raison sociale, comme après un renommage du client : seul clientId compte.
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Chantier SAV lié', client: 'TEST Ancien nom du client SAV', clientId, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, chantierId: chantier.id, titre: 'TEST Intervention liée à affaire' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.equal(creation.body.chantier.id, chantier.id);
    });

    test('refuse un chantier d’un autre client, ou sans fiche client, même à libellé identique', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { raisonSociale: true } });
      const autreClient = await prisma.client.create({ data: { raisonSociale: 'TEST Autre client SAV' } });
      const etranger = await prisma.chantier.create({ data: { nom: 'TEST Chantier SAV étranger', client: 'TEST Autre client SAV', clientId: autreClient.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      // Même libellé que le client du dossier, mais lié à une autre fiche, ou à aucune (affaire héritée).
      const homonyme = await prisma.chantier.create({ data: { nom: 'TEST Chantier SAV homonyme', client: client.raisonSociale, clientId: autreClient.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const herite = await prisma.chantier.create({ data: { nom: 'TEST Chantier SAV hérité', client: client.raisonSociale, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      for (const chantier of [etranger, homonyme, herite]) {
        const creation = await request(app).post('/api/interventions').set(auth).send({ clientId, chantierId: chantier.id, titre: 'TEST Cloisonnement affaire SAV' });
        assert.equal(creation.status, 404, `${chantier.nom} : ${JSON.stringify(creation.body)}`);
      }
      assert.equal(await prisma.intervention.count({ where: { chantierId: { in: [etranger.id, homonyme.id, herite.id] } } }), 0);
    });

    test('refuse un chantier annulé du client, et un client désactivé', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const annule = await prisma.chantier.create({ data: { nom: 'TEST Chantier SAV annulé', client: 'TEST Client SAV', clientId, statut: 'ANNULE', annuleLe: new Date(), motifAnnulation: 'TEST', dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const refusAnnule = await request(app).post('/api/interventions').set(auth).send({ clientId, chantierId: annule.id, titre: 'TEST SAV chantier annulé' });
      assert.equal(refusAnnule.status, 404, JSON.stringify(refusAnnule.body));
      const desactive = await prisma.client.create({ data: { raisonSociale: 'TEST Client SAV désactivé', actif: false } });
      const refusDesactive = await request(app).post('/api/interventions').set(auth).send({ clientId: desactive.id, titre: 'TEST SAV client désactivé' });
      assert.equal(refusDesactive.status, 404, JSON.stringify(refusDesactive.body));
      assert.equal(await prisma.intervention.count({ where: { OR: [{ chantierId: annule.id }, { clientId: desactive.id }] } }), 0);
    });

    test('permet au technicien affecté de consigner un compte rendu terrain', async () => {
      const technicien = await compteTechnicienSav('sav.rapport@iris.test', 'TEST Intervenant SAV rapport');
      const dossier = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Rapport terrain SAV' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      await prisma.interventionAffectation.create({ data: { interventionId: dossier.body.id, intervenantId: technicien.intervenantId } });
      await request(app).patch(`/api/interventions/${dossier.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'PLANIFIEE' });
      await request(app).patch(`/api/interventions/${dossier.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'EN_COURS' });
      const rapport = await request(app).post(`/api/interventions/${dossier.body.id}/rapports`).set('Authorization', `Bearer ${technicien.jeton}`)
        .send({ contenu: 'TEST Intervention réalisée : détecteur repositionné et essai concluant.' });
      assert.equal(rapport.status, 201, JSON.stringify(rapport.body));
      assert.equal(rapport.body.auteurId, undefined); // l’API n’expose pas l’identifiant interne de l’auteur
      assert.equal(rapport.body.contenu, 'TEST Intervention réalisée : détecteur repositionné et essai concluant.');
      const intrus = await compteTechnicienSav('sav.intrus@iris.test', 'TEST Intervenant SAV intrus');
      assert.equal(await voitLeDossier(intrus.jeton, dossier.body.id), false);
      assert.equal((await request(app).post(`/api/interventions/${dossier.body.id}/rapports`).set('Authorization', `Bearer ${intrus.jeton}`).send({ contenu: 'TEST Rapport hors périmètre.' })).status, 404);
      assert.equal((await request(app).post(`/api/interventions/rapports/${rapport.body.id}/signature`).set('Authorization', `Bearer ${intrus.jeton}`).send({ signataire: 'TEST Usurpation', confirme: true })).status, 404);
      // La signature demeure possible après clôture : le client peut signer après le départ du technicien.
      assert.equal((await request(app).patch(`/api/interventions/${dossier.body.id}/statut`).set('Authorization', `Bearer ${technicien.jeton}`).send({ statut: 'TERMINEE' })).status, 200);
      const signature = await request(app).post(`/api/interventions/rapports/${rapport.body.id}/signature`).set('Authorization', `Bearer ${technicien.jeton}`)
        .send({ signataire: 'TEST Client signataire', confirme: true });
      assert.equal(signature.status, 201, JSON.stringify(signature.body));
      assert.match(signature.body.empreinte, /^[a-f0-9]{64}$/);
      assert.equal((await request(app).post(`/api/interventions/rapports/${rapport.body.id}/signature`).set('Authorization', `Bearer ${technicien.jeton}`).send({ signataire: 'TEST Client signataire', confirme: true })).status, 409);
      const liste = await request(app).get('/api/interventions').set('Authorization', `Bearer ${technicien.jeton}`);
      const relu = liste.body.find((item) => item.id === dossier.body.id);
      assert.equal(relu.rapports.length, 1);
      assert.equal(relu.rapports[0].contenu, rapport.body.contenu);
      assert.equal(relu.rapports[0].signature.signataire, 'TEST Client signataire');
    });

    test('applique le périmètre hiérarchique aux interventions rattachées à une affaire', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'sav.conducteur@iris.test', name: 'TEST Conducteur SAV', role: 'CONDUCTEUR_TRAVAUX' } });
      const responsable = await prisma.user.create({ data: { email: 'sav.responsable@iris.test', name: 'TEST Responsable SAV', role: 'RESPONSABLE' } });
      await prisma.user.update({ where: { id: conducteur.id }, data: { responsableHierarchiqueId: responsable.id } });
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { raisonSociale: true } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Chantier périmètre SAV', client: client.raisonSociale, clientId, dateDebut: new Date(), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const dossier = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, chantierId: chantier.id, titre: 'TEST Intervention périmètre équipe' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      const sessionConducteur = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const sessionResponsable = jwt.sign({ id: responsable.id }, process.env.JWT_SECRET);
      assert.equal(await voitLeDossier(sessionConducteur, dossier.body.id), true);
      assert.equal(await voitLeDossier(sessionResponsable, dossier.body.id), true);
      const tiers = await prisma.user.create({ data: { email: 'sav.tiers@iris.test', name: 'TEST Conducteur SAV tiers', role: 'CONDUCTEUR_TRAVAUX' } });
      assert.equal(await voitLeDossier(jwt.sign({ id: tiers.id }, process.env.JWT_SECRET), dossier.body.id), false);
    });

    test('la projection planning ouvre et referme l’accès au dossier SAV', async () => {
      const jour = new Date().toISOString().slice(0, 10);
      const dossier = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`).send({ clientId, titre: 'TEST Dossier planifié SAV' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      const premier = await compteTechnicienSav('sav.premier@iris.test', 'TEST Intervenant SAV premier');
      const second = await compteTechnicienSav('sav.second@iris.test', 'TEST Intervenant SAV second');
      const planification = await request(app).put(`/api/interventions/${dossier.body.id}/planning`).set('Authorization', `Bearer ${session}`).send({ dateDebut: jour, creneau: 'JOURNEE', intervenantIds: [premier.intervenantId] });
      assert.equal(planification.status, 200, JSON.stringify(planification.body));
      assert.equal(await voitLeDossier(premier.jeton, dossier.body.id), true);
      assert.equal(await voitLeDossier(second.jeton, dossier.body.id), false);
      const remplacement = await request(app).patch(`/api/planning/events/${planification.body.id}`).set('Authorization', `Bearer ${session}`).send({ intervenantIds: [second.intervenantId] });
      assert.equal(remplacement.status, 200, JSON.stringify(remplacement.body));
      assert.equal(await voitLeDossier(premier.jeton, dossier.body.id), false);
      assert.equal(await voitLeDossier(second.jeton, dossier.body.id), true);
      const suppression = await request(app).delete(`/api/planning/events/${planification.body.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 409, JSON.stringify(suppression.body));
      assert.equal(await voitLeDossier(second.jeton, dossier.body.id), true);
      const suppressionIntervenant = await request(app).delete(`/api/intervenants/${second.intervenantId}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppressionIntervenant.status, 409, JSON.stringify(suppressionIntervenant.body));
    });

    test('liste les interventions sans exposer les dossiers annulés par défaut', async () => {
      const active = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Liste active' });
      const cancelled = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`)
        .send({ clientId, titre: 'TEST Liste annulée' });
      await request(app).patch(`/api/interventions/${cancelled.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ANNULEE' });

      const liste = await request(app).get('/api/interventions').set('Authorization', `Bearer ${session}`);
      assert.equal(liste.status, 200, JSON.stringify(liste.body));
      assert.equal(liste.body.some((item) => item.id === active.body.id), true);
      assert.equal(liste.body.some((item) => item.id === cancelled.body.id), false);
    });

    test('bloque les transitions de statut incohérentes', async () => {
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Transition SAV', priorite: 'NORMALE',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));

      const planification = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${session}`)
        .send({ statut: 'PLANIFIEE' });
      assert.equal(planification.status, 200, JSON.stringify(planification.body));
      assert.equal(planification.body.statut, 'PLANIFIEE');

      const annulation = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${session}`)
        .send({ statut: 'ANNULEE' });
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));

      const reprise = await request(app).patch(`/api/interventions/${creation.body.id}/statut`).set('Authorization', `Bearer ${session}`)
        .send({ statut: 'EN_COURS' });
      assert.equal(reprise.status, 409, JSON.stringify(reprise.body));
    });

    test('crée une intervention SAV avec une référence annuelle stable', async () => {
      const creation = await request(app).post('/api/interventions').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Alarme déclenchée', description: 'Le client signale un déclenchement intempestif.', priorite: 'HAUTE', dateDemande: '06-09-2026', dateSouhaitee: '06-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      assert.match(creation.body.reference, /^I\d{2}-\d{4,}$/);
      assert.equal(creation.body.statut, 'A_PLANIFIER');
      assert.equal(creation.body.priorite, 'HAUTE');
      assert.equal(creation.body.client.id, clientId);
    });

    test('permet au technicien affecté de saisir ses heures sur une intervention de contrat', async () => {
      const technicien = await compteTechnicienSav('sav.cout.heures@iris.test', 'TEST Technicien coût SAV');
      const contrat = await prisma.contratMaintenance.create({ data: {
        clientId, titre: 'TEST Contrat coûts SAV', periodiciteMois: 12, dureePrevisionnelleMinutes: 60,
        dateDebut: new Date('2026-01-01T00:00:00.000Z'), prochaineEcheance: new Date('2026-12-01T00:00:00.000Z'),
      } });
      const intervention = await prisma.intervention.create({ data: {
        reference: `I26-COUT-${Date.now()}`, clientId, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance,
        titre: 'TEST Intervention contrat sans chantier',
      } });
      await prisma.interventionAffectation.create({ data: { interventionId: intervention.id, intervenantId: technicien.intervenantId } });

      const saisie = await request(app).post(`/api/interventions/${intervention.id}/couts/heures`)
        .set('Authorization', `Bearer ${technicien.jeton}`)
        .send({ date: '06-09-2026', nbrHeures: 1.5 });

      assert.equal(saisie.status, 201, JSON.stringify(saisie.body));
      assert.equal(saisie.body.intervenantId, undefined, 'la réponse technicien ne doit exposer aucun rattachement ni taux financier');
      assert.equal(saisie.body.tauxHoraireApplique, undefined, 'le taux horaire direction ne doit jamais être exposé au technicien');
      assert.equal(saisie.body.interventionId, undefined);
    });

    test('réserve les coûts à un technicien et fige son taux à la saisie', async () => {
      const technicien = await compteTechnicienSav('sav.cout.garde.taux@iris.test', 'TEST Garde taux technicien');
      const responsable = await prisma.user.create({ data: { email: 'sav.cout.garde.responsable@iris.test', name: 'TEST Garde taux responsable', role: 'RESPONSABLE' } });
      const intervenantResponsable = await prisma.intervenant.create({ data: { nom: 'TEST Garde taux intervenant responsable', role: 'Responsable', tauxHoraireCharge: 42, userId: responsable.id } });
      const jetonResponsable = jwt.sign({ id: responsable.id }, process.env.JWT_SECRET);
      const contrat = await prisma.contratMaintenance.create({ data: {
        clientId, titre: 'TEST Contrat garde taux', statut: 'ACTIF', periodiciteMois: 12, dureePrevisionnelleMinutes: 60,
        dateDebut: new Date('2026-01-01T00:00:00.000Z'), prochaineEcheance: new Date('2026-12-01T00:00:00.000Z'),
      } });
      const intervention = await prisma.intervention.create({ data: {
        reference: `I26-GARDE-TAUX-${Date.now()}`, clientId, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance, titre: 'TEST Intervention garde taux',
      } });
      await prisma.interventionAffectation.createMany({ data: [
        { interventionId: intervention.id, intervenantId: technicien.intervenantId },
        { interventionId: intervention.id, intervenantId: intervenantResponsable.id },
      ] });

      const lectureResponsable = await request(app).get(`/api/interventions/${intervention.id}/couts`)
        .set('Authorization', `Bearer ${jetonResponsable}`);
      assert.equal(lectureResponsable.status, 403, JSON.stringify(lectureResponsable.body));
      assert.equal(lectureResponsable.body.error, 'Accès non autorisé.');

      const saisie = await request(app).post(`/api/interventions/${intervention.id}/couts/heures`)
        .set('Authorization', `Bearer ${technicien.jeton}`).send({ date: '06-09-2026', nbrHeures: 2 });
      assert.equal(saisie.status, 201, JSON.stringify(saisie.body));

      await prisma.intervenant.update({ where: { id: technicien.intervenantId }, data: { tauxHoraireCharge: 99 } });
      const lectureEncadrement = await request(app).get(`/api/interventions/${intervention.id}/couts`)
        .set('Authorization', `Bearer ${session}`);
      assert.equal(lectureEncadrement.status, 200, JSON.stringify(lectureEncadrement.body));
      assert.equal(lectureEncadrement.body.heures.length, 1);
      assert.equal(lectureEncadrement.body.heures[0].tauxHoraireApplique, 42);
      assert.equal(lectureEncadrement.body.totalMainOeuvreHT, 84);
    });

    test('témoin des gardes des coûts SAV', async () => {
      const technicien = await compteTechnicienSav('sav.cout.garde.technicien@iris.test', 'TEST Garde coûts technicien');
      const collegue = await compteTechnicienSav('sav.cout.garde.collegue@iris.test', 'TEST Garde coûts collègue');
      const conducteur = await prisma.user.create({ data: { email: 'sav.cout.garde.conducteur@iris.test', name: 'TEST Garde coûts conducteur', role: 'CONDUCTEUR_TRAVAUX' } });
      const commercial = await prisma.user.create({ data: { email: 'sav.cout.garde.commercial@iris.test', name: 'TEST Garde coûts commercial', role: 'COMMERCIAL' } });
      const jetonConducteur = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const jetonCommercial = jwt.sign({ id: commercial.id }, process.env.JWT_SECRET);
      const contrat = await prisma.contratMaintenance.create({ data: { clientId, titre: 'TEST Contrat gardes coûts', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: new Date('2026-01-01'), prochaineEcheance: new Date('2026-12-01') } });
      const intervention = await prisma.intervention.create({ data: { reference: `I26-GARDES-${Date.now()}`, clientId, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance, titre: 'TEST Intervention gardes coûts' } });
      const sansContrat = await prisma.intervention.create({ data: { reference: `I26-SANS-CONTRAT-${Date.now()}`, clientId, titre: 'TEST Intervention sans contrat' } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur gardes ${Date.now()}` } });
      await prisma.interventionAffectation.createMany({ data: [{ interventionId: intervention.id, intervenantId: technicien.intervenantId }, { interventionId: intervention.id, intervenantId: collegue.intervenantId }] });
      const heure = await prisma.coutInterventionHeure.create({ data: { interventionId: intervention.id, intervenantId: technicien.intervenantId, date: new Date('2026-09-06'), nbrHeures: 1, tauxHoraireApplique: 42, createdById: (await prisma.user.findUniqueOrThrow({ where: { email: 'sav.cout.garde.technicien@iris.test' } })).id } });
      const achat = await prisma.coutInterventionAchat.create({ data: { interventionId: intervention.id, fournisseurId: fournisseur.id, date: new Date('2026-09-06'), description: 'TEST Achat garde', montantHT: 1, createdById: conducteur.id } });
      await prisma.interventionAffectation.create({ data: { interventionId: intervention.id, intervenantId: (await prisma.intervenant.create({ data: { nom: 'TEST Garde commercial', role: 'Commercial', tauxHoraireCharge: 0, userId: commercial.id } })).id } });

      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${jetonCommercial}`)).status, 403, 'un rôle affecté non autorisé ne lit pas les coûts');
      assert.equal((await request(app).get(`/api/interventions/${sansContrat.id}/couts`).set('Authorization', `Bearer ${session}`)).status, 409, 'sans contrat, la lecture des coûts est refusée');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/heures`).set('Authorization', `Bearer ${session}`).send({ date: '06-09-2026', nbrHeures: 1 })).status, 403, 'l’encadrement ne saisit pas les heures');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/heures`).set('Authorization', `Bearer ${technicien.jeton}`).send({ date: '06-09-2026', nbrHeures: 0 })).status, 400, 'zéro heure exige un motif');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set('Authorization', `Bearer ${technicien.jeton}`).send({ date: '06-09-2026', fournisseurId: fournisseur.id, description: 'TEST', montantHT: 1 })).status, 403, 'un technicien ne saisit pas un achat');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set('Authorization', `Bearer ${session}`).send({ date: '06-09-2026', fournisseurId: fournisseur.id, description: 'TEST', montantHT: 0 })).status, 400, 'zéro achat exige un motif');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set('Authorization', `Bearer ${session}`).send({ date: '06-09-2026', fournisseurId: fournisseur.id, montantHT: 1 })).status, 400, 'un achat exige une description');
      assert.equal((await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heure.id}`).set('Authorization', `Bearer ${session}`).send({ commentaire: 'TEST', motifCorrection: 'Motif correction' })).status, 403, 'le mauvais rôle ne corrige pas les heures');
      assert.equal((await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heure.id}`).set('Authorization', `Bearer ${collegue.jeton}`).send({ commentaire: 'TEST', motifCorrection: 'Motif correction' })).status, 404, 'un technicien ne corrige pas l’heure du collègue');
      assert.equal((await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heure.id}`).set('Authorization', `Bearer ${technicien.jeton}`).send({ commentaire: 'TEST' })).status, 400, 'une correction exige un motif');
      const sansChamp = await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heure.id}`).set('Authorization', `Bearer ${technicien.jeton}`).send({ motifCorrection: 'Motif sans modification' });
      assert.equal(sansChamp.status, 400); assert.equal(sansChamp.body.error, 'Aucun champ à corriger.');
      const achatSansChamp = await request(app).patch(`/api/interventions/${intervention.id}/couts/achats/${achat.id}`).set('Authorization', `Bearer ${session}`).send({ motifCorrection: 'Motif sans modification' });
      assert.equal(achatSansChamp.status, 400); assert.equal(achatSansChamp.body.error, 'Aucun champ à corriger.');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats/${achat.id}/archiver`).set('Authorization', `Bearer ${technicien.jeton}`).send({ motif: 'Archivage interdit' })).status, 403, 'un technicien n’archive pas');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats/${achat.id}/archiver`).set('Authorization', `Bearer ${session}`).send({})).status, 400, 'un archivage exige un motif');
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats/${achat.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Archivage justifié' })).status, 200);
      assert.equal((await request(app).post(`/api/interventions/${intervention.id}/couts/achats/${achat.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Double archivage' })).status, 409);
      assert.equal((await request(app).post(`/api/interventions/${sansContrat.id}/couts/heures/${heure.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Hors contrat' })).status, 409);
      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/journal-saisies`).set('Authorization', `Bearer ${technicien.jeton}`)).status, 403, 'le journal financier reste fermé au technicien');
      assert.equal((await request(app).post('/api/interventions').set('Authorization', `Bearer ${technicien.jeton}`).send({ clientId, titre: 'TEST Création technicien refusée' })).status, 403, 'la création est réservée à l’encadrement');
      const creationConducteur = await request(app).post('/api/interventions').set('Authorization', `Bearer ${jetonConducteur}`).send({ clientId, titre: 'TEST Création conducteur visible' });
      assert.equal(creationConducteur.status, 201, JSON.stringify(creationConducteur.body));
      assert.equal((await request(app).get('/api/interventions').set('Authorization', `Bearer ${jetonConducteur}`)).body.some((item) => item.id === creationConducteur.body.id), true, 'le conducteur voit l’intervention qu’il a créée');
      const suppressionIntervenant = await request(app).delete(`/api/intervenants/${technicien.intervenantId}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppressionIntervenant.status, 409); assert.match(suppressionIntervenant.body.error, /coût\(s\) d'heures SAV/);
    });

    test('protège la confidentialité technicien, restitue l’historique encadrant et arrondit chaque ligne au centime', async () => {
      const premier = await compteTechnicienSav('sav.cout.second@iris.test', 'TEST Technicien coût second');
      const second = await compteTechnicienSav('sav.cout.confidentiel@iris.test', 'TEST Technicien coût confidentiel');
      const contrat = await prisma.contratMaintenance.create({ data: {
        clientId, titre: 'TEST Contrat confidentialité coûts', periodiciteMois: 12, dureePrevisionnelleMinutes: 60,
        dateDebut: new Date('2026-01-01T00:00:00.000Z'), prochaineEcheance: new Date('2026-12-01T00:00:00.000Z'),
      } });
      const intervention = await prisma.intervention.create({ data: {
        reference: `I26-COUT-PRIVE-${Date.now()}`, clientId, contratMaintenanceId: contrat.id, dateDemande: contrat.prochaineEcheance, titre: 'TEST Intervention coûts privés',
      } });
      const fournisseur = await prisma.fournisseur.create({ data: { nom: `TEST Fournisseur coûts ${Date.now()}` } });
      await prisma.interventionAffectation.createMany({ data: [
        { interventionId: intervention.id, intervenantId: premier.intervenantId },
        { interventionId: intervention.id, intervenantId: second.intervenantId },
      ] });
      const heurePremier = await prisma.coutInterventionHeure.create({ data: { interventionId: intervention.id, intervenantId: premier.intervenantId, date: new Date('2026-09-06'), nbrHeures: 1.11, tauxHoraireApplique: 42.42, createdById: (await prisma.user.findUniqueOrThrow({ where: { email: 'sav.cout.second@iris.test' } })).id } });
      await prisma.coutInterventionHeure.create({ data: { interventionId: intervention.id, intervenantId: second.intervenantId, date: new Date('2026-09-06'), nbrHeures: 2.22, tauxHoraireApplique: 42.42, createdById: (await prisma.user.findUniqueOrThrow({ where: { email: 'sav.cout.confidentiel@iris.test' } })).id } });
      await prisma.coutInterventionAchat.create({ data: { interventionId: intervention.id, fournisseurId: fournisseur.id, date: new Date('2026-09-06'), description: 'TEST matériel confidentiel', montantHT: 10.01, createdById: (await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } })).id } });

      const lectureTechnicien = await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${premier.jeton}`);
      assert.equal(lectureTechnicien.status, 200, JSON.stringify(lectureTechnicien.body));
      assert.deepEqual(Object.keys(lectureTechnicien.body).sort(), ['heures']);
      assert.equal(lectureTechnicien.body.heures.length, 1);
      assert.deepEqual(Object.keys(lectureTechnicien.body.heures[0]).sort(), ['commentaire', 'createdAt', 'date', 'id', 'nbrHeures']);
      assert.equal(lectureTechnicien.body.heures[0].nbrHeures, 1.11);
      assert.equal('tauxHoraireApplique' in lectureTechnicien.body.heures[0], false);
      assert.equal('intervenantId' in lectureTechnicien.body.heures[0], false);
      assert.equal('totalMainOeuvreHT' in lectureTechnicien.body, false);
      assert.equal('achats' in lectureTechnicien.body, false);
      assert.equal('totalMaterielHT' in lectureTechnicien.body, false);
      assert.equal('totalCoutsHT' in lectureTechnicien.body, false);

      const lectureEncadrement = await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${session}`);
      assert.equal(lectureEncadrement.status, 200, JSON.stringify(lectureEncadrement.body));
      assert.equal(lectureEncadrement.body.totalMainOeuvreHT, 141.26, '1,11 × 42,42 = 47,09 et 2,22 × 42,42 = 94,17, arrondis par ligne');
      assert.equal(lectureEncadrement.body.totalMaterielHT, 10.01);
      assert.equal(lectureEncadrement.body.totalCoutsHT, 151.27);

      const correctionZero = await request(app).patch(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}`)
        .set('Authorization', `Bearer ${premier.jeton}`).send({ nbrHeures: 0, motifCorrection: 'Erreur de pointage initial' });
      assert.equal(correctionZero.status, 200, JSON.stringify(correctionZero.body));
      assert.equal(correctionZero.body.nbrHeures, 0, 'motifCorrection seul autorise la correction vers zéro');
      assert.equal('tauxHoraireApplique' in correctionZero.body, false, 'une correction technicien ne révèle jamais le taux appliqué');
      assert.equal('intervenantId' in correctionZero.body, false);
      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/journal-saisies`).set('Authorization', `Bearer ${premier.jeton}`)).status, 403, 'le journal contient des instantanés financiers et reste fermé au technicien');
      const trace = await prisma.journalSaisieChantier.findFirstOrThrow({ where: { cibleId: heurePremier.id, action: 'CORRECTION' }, orderBy: { createdAt: 'desc' } });
      assert.equal(trace.motif, 'Erreur de pointage initial');

      const [heuresAvantRefus, achatsAvantRefus, journalAvantRefus] = await Promise.all([
        prisma.coutInterventionHeure.count({ where: { interventionId: intervention.id } }),
        prisma.coutInterventionAchat.count({ where: { interventionId: intervention.id } }),
        prisma.journalSaisieChantier.count({ where: { interventionId: intervention.id } }),
      ]);
      await prisma.contratMaintenance.update({ where: { id: contrat.id }, data: { statut: 'SUSPENDU' } });
      const ajoutRefuse = await request(app).post(`/api/interventions/${intervention.id}/couts/heures`).set('Authorization', `Bearer ${premier.jeton}`).send({ date: '06-09-2026', nbrHeures: 1 });
      assert.equal(ajoutRefuse.status, 409, JSON.stringify(ajoutRefuse.body));
      const achatRefuse = await request(app).post(`/api/interventions/${intervention.id}/couts/achats`).set('Authorization', `Bearer ${session}`).send({ date: '06-09-2026', description: 'Achat refusé après suspension', montantHT: 12, fournisseurId: fournisseur.id });
      assert.equal(achatRefuse.status, 409, JSON.stringify(achatRefuse.body));
      assert.equal(await prisma.coutInterventionHeure.count({ where: { interventionId: intervention.id } }), heuresAvantRefus, 'le refus ne crée aucune heure');
      assert.equal(await prisma.coutInterventionAchat.count({ where: { interventionId: intervention.id } }), achatsAvantRefus, 'le refus ne crée aucun achat');
      assert.equal(await prisma.journalSaisieChantier.count({ where: { interventionId: intervention.id } }), journalAvantRefus, 'le refus ne journalise aucune trace');
      assert.equal((await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${premier.jeton}`)).status, 409, 'hors état saisissable, le technicien ne reçoit plus de surface d’écriture');

      const archivageSuspendu = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Archivage après suspension' });
      assert.equal(archivageSuspendu.status, 200, JSON.stringify(archivageSuspendu.body));
      const historiqueSuspendu = await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${session}`);
      assert.equal(historiqueSuspendu.status, 200, JSON.stringify(historiqueSuspendu.body));
      assert.equal(historiqueSuspendu.body.heures.find((heure) => heure.id === heurePremier.id)?.archivedAt !== null, true);
      const restaurationSuspendue = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}/restaurer`).set('Authorization', `Bearer ${session}`).send({ motif: 'Restauration après suspension' });
      assert.equal(restaurationSuspendue.status, 200, JSON.stringify(restaurationSuspendue.body));

      await prisma.contratMaintenance.update({ where: { id: contrat.id }, data: { statut: 'TERMINE' } });
      await prisma.intervention.update({ where: { id: intervention.id }, data: { statut: 'ANNULEE' } });
      const historiqueCloture = await request(app).get(`/api/interventions/${intervention.id}/couts`).set('Authorization', `Bearer ${session}`);
      assert.equal(historiqueCloture.status, 200, JSON.stringify(historiqueCloture.body));
      const archivageCloture = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}/archiver`).set('Authorization', `Bearer ${session}`).send({ motif: 'Archivage après clôture' });
      assert.equal(archivageCloture.status, 200, JSON.stringify(archivageCloture.body));
      const restaurationCloture = await request(app).post(`/api/interventions/${intervention.id}/couts/heures/${heurePremier.id}/restaurer`).set('Authorization', `Bearer ${session}`).send({ motif: 'Restauration après clôture' });
      assert.equal(restaurationCloture.status, 200, JSON.stringify(restaurationCloture.body));

      const suppressionFournisseur = await request(app).delete(`/api/fournisseurs/${fournisseur.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppressionFournisseur.status, 409, JSON.stringify(suppressionFournisseur.body));
      const suppressionCreateur = await request(app).delete(`/${'api/users'}/${(await prisma.user.findUniqueOrThrow({ where: { email: 'sav.cout.second@iris.test' } })).id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppressionCreateur.status, 409, JSON.stringify(suppressionCreateur.body));
    });
  });

  describe('Contrats de maintenance cyclique', () => {
    test('date demandée curative : saisie française stricte, défaut civil et refus futur', async () => {
      const token = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send({ raisonSociale: 'TEST Client date demande' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const creer = (data) => request(app).post('/api/interventions').set('Authorization', `Bearer ${token}`).send({ clientId: client.body.id, titre: 'TEST Demande client', ...data });
      for (const dateDemande of ['2026-01-01', '2026-01-01T00:00:00Z', '31-02-2026', '01/01/2026', '01-01-9999']) {
        const refuse = await creer({ dateDemande });
        assert.equal(refuse.status, 400, `${dateDemande}: ${JSON.stringify(refuse.body)}`);
      }
      const explicite = await creer({ dateDemande: '02-01-2026' });
      assert.equal(explicite.status, 201, JSON.stringify(explicite.body));
      assert.equal(explicite.body.dateDemande, '2026-01-02T00:00:00.000Z');
      const implicite = await creer({});
      assert.equal(implicite.status, 201, JSON.stringify(implicite.body));
      assert.equal(implicite.body.dateDemande?.slice(0, 10), jourCivilEntreprise(new Date(), (await prisma.companySettings.findUnique({ where: { id: 'singleton' } }))?.fuseauHoraire || 'Europe/Paris'));
    });

    test('date souhaitée curative : jamais avant la demande explicite ou le jour civil implicite', async () => {
      const token = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send({ raisonSociale: 'TEST Client cohérence dates' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const creer = (data) => request(app).post('/api/interventions').set('Authorization', `Bearer ${token}`).send({ clientId: client.body.id, titre: 'TEST Cohérence planning', ...data });
      const refuse = await creer({ dateDemande: '10-01-2026', dateSouhaitee: '09-01-2026' });
      assert.equal(refuse.status, 400, JSON.stringify(refuse.body));
      assert.match(refuse.body.error, /date souhaitée.*date de demande/i);
      const fuseau = (await prisma.companySettings.findUnique({ where: { id: 'singleton' } }))?.fuseauHoraire || 'Europe/Paris';
      const aujourdHui = jourCivilEntreprise(new Date(), fuseau);
      const hier = new Date(`${aujourdHui}T00:00:00.000Z`);
      hier.setUTCDate(hier.getUTCDate() - 1);
      const dateHier = `${String(hier.getUTCDate()).padStart(2, '0')}-${String(hier.getUTCMonth() + 1).padStart(2, '0')}-${hier.getUTCFullYear()}`;
      const impliciteRefuse = await creer({ dateSouhaitee: dateHier });
      assert.equal(impliciteRefuse.status, 400, JSON.stringify(impliciteRefuse.body));
      assert.match(impliciteRefuse.body.error, /date souhaitée.*date de demande/i);
      const egale = await creer({ dateDemande: '10-01-2026', dateSouhaitee: '10-01-2026' });
      assert.equal(egale.status, 201, JSON.stringify(egale.body));
      const sansSouhait = await creer({ dateDemande: '10-01-2026' });
      assert.equal(sansSouhait.status, 201, JSON.stringify(sansSouhait.body));
      assert.equal(sansSouhait.body.dateSouhaitee, null);
    });

    test('date demandée contractuelle : échéance future, bornes et gel SQL', async () => {
      const token = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send({ raisonSociale: 'TEST Client date effet' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${token}`).send({ clientId: client.body.id, titre: 'TEST Contrat date effet', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2099' });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const intervention = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${token}`);
      assert.equal(intervention.status, 201, JSON.stringify(intervention.body));
      assert.equal(intervention.body.dateDemande, contrat.body.prochaineEcheance);
      await assert.rejects(prisma.$executeRaw`UPDATE "Intervention" SET "dateDemande" = '2099-01-02' WHERE "id" = ${intervention.body.id}`);
      await assert.rejects(prisma.$executeRaw`UPDATE "Intervention" SET "dateDemande" = NULL WHERE "id" = ${intervention.body.id}`);
      await assert.rejects(prisma.$executeRaw`UPDATE "ContratMaintenance" SET "dateDebut" = '2100-01-01' WHERE "id" = ${contrat.body.id}`);
      await assert.rejects(prisma.$executeRaw`INSERT INTO "Intervention" ("id", "reference", "clientId", "titre", "contratMaintenanceId", "updatedAt") VALUES ('test-date-effet-sans-date', 'TEST-I-SANS-DATE', ${client.body.id}, 'TEST sans date', ${contrat.body.id}, now())`);
      await assert.rejects(prisma.$executeRaw`INSERT INTO "Intervention" ("id", "reference", "clientId", "titre", "contratMaintenanceId", "dateDemande", "echeanceContrat", "updatedAt") VALUES ('test-date-effet-avant', 'TEST-I-AVANT-EFFET', ${client.body.id}, 'TEST avant', ${contrat.body.id}, '2098-12-31', '2099-01-01', now())`);
      const libre = await prisma.intervention.create({ data: { reference: `TEST-I-LIBRE-${Date.now()}`, clientId: client.body.id, titre: 'TEST à rattacher', dateDemande: new Date('2026-01-01') } });
      await assert.rejects(prisma.$executeRaw`UPDATE "Intervention" SET "contratMaintenanceId" = ${contrat.body.id} WHERE "id" = ${libre.id}`);
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: libre.id } })).contratMaintenanceId, null);
    });
    let session = '';
    let clientId = '';
    let siteId = '';
    let contratId = '';
    // « Réglée » ne se coche plus : une facture l'est quand un règlement la solde. Le règlement
    // est daté du jour d'émission de la facture, jamais futur ni antérieur à elle.
    const reglerEnTotalite = (facture, montant = facture.totalTtc) => request(app).post('/api/reglements').set('Authorization', `Bearer ${session}`)
      .send({ clientId: facture.clientId, dateReglement: facture.dateEmission, montant, moyen: 'VIREMENT', affectations: [{ factureId: facture.id, montant }] });
    const resteDuFacture = async (id) => (await request(app).get('/api/factures/a-regler').set('Authorization', `Bearer ${session}`)).body.factures.find((facture) => facture.id === id)?.resteDu ?? 0;

    before(async () => {
      session = (await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN })).body.token;
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Client contrat maintenance' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      clientId = client.body.id;
      const site = await request(app).post(`/api/clients/${clientId}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site maintenance', adresse: '1 rue des Tests', codePostal: '75001', ville: 'Paris', estSiteIntervention: true });
      assert.equal(site.status, 201, JSON.stringify(site.body));
      siteId = site.body.id;
    });

    test('visite suspendue : absente de la file et PUT refusé sans mutation, puis éligible après réactivation', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const contrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: 'TEST Visite suspendue', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const visite = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth);
      assert.equal(visite.status, 201, JSON.stringify(visite.body));
      const id = visite.body.id;
      const queue = () => request(app).get('/api/planning/interventions-a-planifier').set(auth);
      const changeStatut = statut => request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set(auth).send({ statut, motif: `TEST transition ${statut}` });
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST Technicien visite suspendue', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const place = () => request(app).put(`/api/interventions/${id}/planning`).set(auth).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
      assert.equal((await queue()).body.some(item => item.id === id), true);
      assert.equal((await changeStatut('SUSPENDU')).status, 200);
      assert.equal((await queue()).body.some(item => item.id === id), false);
      const avant = await prisma.intervention.findUniqueOrThrow({ where: { id } });
      const journalAvant = await prisma.journalSaisieChantier.count({ where: { interventionId: id } });
      const refus = await place();
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.deepEqual(await prisma.intervention.findUniqueOrThrow({ where: { id } }), avant);
      assert.equal(await prisma.planningEvent.count({ where: { interventionId: id } }), 0);
      assert.equal(await prisma.interventionAffectation.count({ where: { interventionId: id } }), 0);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { interventionId: id } }), journalAvant);
      assert.equal((await changeStatut('ACTIF')).status, 200);
      assert.equal((await queue()).body.some(item => item.id === id), true);
      const placee = await place();
      assert.equal(placee.status, 200, JSON.stringify(placee.body));
      assert.equal((await queue()).body.some(item => item.id === id), false);
    });

    test('clôture ACTIF ou SUSPENDU : visite déjà générée, même échue, absente de la file et PUT périmé sans effet', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST Technicien clôture visite', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      for (const statutInitial of ['ACTIF', 'SUSPENDU']) {
        const contrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: `TEST Clôture ${statutInitial}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2026' });
        assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
        const visite = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth);
        assert.equal(visite.status, 201, JSON.stringify(visite.body));
        const id = visite.body.id;
        assert.equal(visite.body.echeanceContrat.slice(0, 10), '2026-01-01');
        const queue = () => request(app).get('/api/planning/interventions-a-planifier').set(auth);
        if (statutInitial === 'SUSPENDU') {
          const suspension = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set(auth).send({ statut: 'SUSPENDU', motif: 'TEST suspension avant clôture' });
          assert.equal(suspension.status, 200, JSON.stringify(suspension.body));
        } else {
          assert.equal((await queue()).body.some(item => item.id === id), true);
        }
        const cloture = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set(auth).send({ statut: 'TERMINE', motif: 'TEST clôture avant placement' });
        assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
        assert.equal((await queue()).body.some(item => item.id === id), false, `clôture depuis ${statutInitial}`);
        const avant = await prisma.intervention.findUniqueOrThrow({ where: { id } });
        const journalAvant = await prisma.journalSaisieChantier.findMany({ where: { interventionId: id } });
        const refus = await request(app).put(`/api/interventions/${id}/planning`).set(auth).send({ dateDebut: '2026-01-02', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /contrat clos/i);
        assert.deepEqual(await prisma.intervention.findUniqueOrThrow({ where: { id } }), avant);
        assert.equal(await prisma.planningEvent.count({ where: { interventionId: id } }), 0);
        assert.equal(await prisma.interventionAffectation.count({ where: { interventionId: id } }), 0);
        assert.deepEqual(await prisma.journalSaisieChantier.findMany({ where: { interventionId: id } }), journalAvant);
        const reprise = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set(auth).send({ statut: 'ACTIF', motif: 'TEST réouverture interdite' });
        assert.equal(reprise.status, 409);
        assert.equal((await queue()).body.some(item => item.id === id), false);
      }
    });

    test('clôture après placement : la projection et les affectations existantes restent intactes', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const contrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: 'TEST Clôture projection existante', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const visite = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth);
      assert.equal(visite.status, 201, JSON.stringify(visite.body));
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST Technicien clôture placée', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const placement = await request(app).put(`/api/interventions/${visite.body.id}/planning`).set(auth).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
      assert.equal(placement.status, 200, JSON.stringify(placement.body));
      const avant = await prisma.intervention.findUniqueOrThrow({ where: { id: visite.body.id } });
      const projection = await prisma.planningEvent.findUniqueOrThrow({ where: { interventionId: visite.body.id } });
      const affectations = await prisma.interventionAffectation.findMany({ where: { interventionId: visite.body.id } });
      const journal = await prisma.journalSaisieChantier.findMany({ where: { interventionId: visite.body.id }, orderBy: { id: 'asc' } });
      const cloture = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set(auth).send({ statut: 'TERMINE', motif: 'TEST clôture après placement' });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      assert.deepEqual(await prisma.intervention.findUniqueOrThrow({ where: { id: visite.body.id } }), avant);
      assert.deepEqual(await prisma.planningEvent.findUniqueOrThrow({ where: { interventionId: visite.body.id } }), projection);
      assert.deepEqual(await prisma.interventionAffectation.findMany({ where: { interventionId: visite.body.id } }), affectations);
      assert.deepEqual(await prisma.journalSaisieChantier.findMany({ where: { interventionId: visite.body.id }, orderBy: { id: 'asc' } }), journal);
    });

    test('suspension engagée pendant le PUT : relecture sous verrou et aucun placement', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const contrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: 'TEST Course suspension', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const visite = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth);
      assert.equal(visite.status, 201, JSON.stringify(visite.body));
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST Course suspension technicien', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      let liberer, pret;
      const attente = new Promise(resolve => { liberer = resolve; });
      const verrouPris = new Promise(resolve => { pret = resolve; });
      const verrou = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "ContratMaintenance" WHERE "id" = ${contrat.body.id} FOR UPDATE`;
        pret();
        await attente;
        // Simule la mutation de statut dans la transaction détentrice du verrou :
        // le PUT avait déjà commencé et doit voir le nouveau statut à sa reprise.
        await tx.contratMaintenance.update({ where: { id: contrat.body.id }, data: { statut: 'SUSPENDU' } });
      }, { timeout: 15000 });
      await verrouPris;
      let placement;
      try {
        placement = request(app).put(`/api/interventions/${visite.body.id}/planning`).set(auth)
          .send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] }).then(result => result);
        let bloque = false;
        for (let tour = 0; tour < 150; tour++) {
          const sessions = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"ContratMaintenance"%FOR UPDATE%'`;
          if (sessions.length) { bloque = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(bloque, true, 'le PUT doit attendre le verrou du contrat');
      } finally {
        liberer();
        await verrou;
      }
      const refus = await placement;
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.planningEvent.count({ where: { interventionId: visite.body.id } }), 0);
      assert.equal(await prisma.interventionAffectation.count({ where: { interventionId: visite.body.id } }), 0);
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: visite.body.id } })).statut, 'A_PLANIFIER');
    });

    test('contrat ACTIF/SUSPENDU/TERMINE : premier placement seulement actif, déplacements PUT/PATCH conservés', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST matrice placement', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      for (const statutContrat of ['ACTIF', 'SUSPENDU', 'TERMINE']) {
        const contrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: `TEST Matrice ${statutContrat}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
        assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
        const visite = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth);
        assert.equal(visite.status, 201, JSON.stringify(visite.body));
        const id = visite.body.id;
        const put = dateDebut => request(app).put(`/api/interventions/${id}/planning`).set(auth).send({ dateDebut, creneau: 'JOURNEE', intervenantIds: [technicien.id] });
        const placee = await put('2099-01-01');
        assert.equal(placee.status, 200, JSON.stringify(placee.body));
        if (statutContrat !== 'ACTIF') {
          assert.equal((await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set(auth).send({ statut: statutContrat, motif: 'TEST après placement' })).status, 200);
          const autreContrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: `TEST Premier refus ${statutContrat}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
          assert.equal(autreContrat.status, 201);
          const autreVisite = await request(app).post(`/api/contrats-maintenance/${autreContrat.body.id}/generer-intervention`).set(auth);
          assert.equal(autreVisite.status, 201);
          assert.equal((await request(app).patch(`/api/contrats-maintenance/${autreContrat.body.id}/statut`).set(auth).send({ statut: statutContrat, motif: 'TEST avant placement' })).status, 200);
          const refus = await request(app).put(`/api/interventions/${autreVisite.body.id}/planning`).set(auth).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
          assert.equal(refus.status, 409, JSON.stringify(refus.body));
          assert.equal(await prisma.planningEvent.count({ where: { interventionId: autreVisite.body.id } }), 0);
        }
        const movedPut = await put('2099-01-02');
        assert.equal(movedPut.status, 200, JSON.stringify(movedPut.body));
        assert.equal(movedPut.body.id, placee.body.id);
        const movedPatch = await request(app).patch(`/api/planning/events/${placee.body.id}`).set(auth).send({ dateDebut: '2099-01-03', dateFin: '2099-01-03' });
        assert.equal(movedPatch.status, 200, JSON.stringify(movedPatch.body));
        assert.equal((await prisma.planningEvent.findUniqueOrThrow({ where: { interventionId: id } })).dateDebut.toISOString().slice(0, 10), '2099-01-03');
        assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, 'PLANIFIEE');
        const depart = await request(app).patch(`/api/interventions/${id}/statut`).set(auth).send({ statut: 'EN_COURS' });
        assert.equal(depart.status, 200, JSON.stringify(depart.body));
        assert.equal((await put('2099-01-04')).status, 200);
        assert.equal((await request(app).patch(`/api/planning/events/${placee.body.id}`).set(auth).send({ dateDebut: '2099-01-05', dateFin: '2099-01-05' })).status, 200);
        assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, 'EN_COURS');
        assert.equal((await prisma.planningEvent.findUniqueOrThrow({ where: { interventionId: id } })).dateDebut.toISOString().slice(0, 10), '2099-01-05');
      }
    });

    test('premier placement journalise sa propre transition avec instantanés et auteur', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const contrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: 'TEST Journal placement direct', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
      assert.equal(contrat.status, 201);
      const visite = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth);
      assert.equal(visite.status, 201);
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST journal placement', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const tracesAvant = await prisma.journalSaisieChantier.count({ where: { interventionId: visite.body.id, action: 'CHANGEMENT_STATUT' } });
      assert.equal(tracesAvant, 0);
      const placee = await request(app).put(`/api/interventions/${visite.body.id}/planning`).set(auth).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
      assert.equal(placee.status, 200, JSON.stringify(placee.body));
      const traces = await prisma.journalSaisieChantier.findMany({ where: { interventionId: visite.body.id, action: 'CHANGEMENT_STATUT' } });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].avant.statut, 'A_PLANIFIER');
      assert.equal(traces[0].apres.statut, 'PLANIFIEE');
      assert.equal(traces[0].auteurId, jwt.verify(session, process.env.JWT_SECRET).id);
      const auteur = await prisma.user.findUniqueOrThrow({ where: { id: traces[0].auteurId } });
      assert.equal(traces[0].auteurNom, auteur.name);
    });

    test('file #103 : les dossiers non planifiés du périmètre sont proposés (visites de contrat, et curatives depuis le lot pilote 3a), placement journalisé sans doublon', async () => {
      const auth = token => ({ Authorization: `Bearer ${token}` });
      const contrat = await request(app).post('/api/contrats-maintenance').set(auth(session)).send({ clientId, siteId, titre: 'TEST File contrat', periodiciteMois: 12, dureePrevisionnelleMinutes: 105, dateDebut: '01-01-2099' });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const generated = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth(session));
      assert.equal(generated.status, 201, JSON.stringify(generated.body));
      const id = generated.body.id;
      const queue = () => request(app).get('/api/planning/interventions-a-planifier').set(auth(session));
      const initial = await queue();
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      assert.deepEqual(initial.body.find(item => item.id === id) && {
        reference: initial.body.find(item => item.id === id).reference,
        client: initial.body.find(item => item.id === id).client.raisonSociale,
        site: initial.body.find(item => item.id === id).site.nom,
        duree: initial.body.find(item => item.id === id).dureePrevisionnelleMinutes,
        echeance: initial.body.find(item => item.id === id).echeanceContrat,
      }, { reference: generated.body.reference, client: 'TEST Client contrat maintenance', site: 'TEST Site maintenance', duree: 105, echeance: generated.body.echeanceContrat });
      const manuel = await request(app).patch(`/api/interventions/${id}/statut`).set(auth(session)).send({ statut: 'PLANIFIEE' });
      assert.equal(manuel.status, 200, JSON.stringify(manuel.body));
      assert.equal(await prisma.planningEvent.count({ where: { interventionId: id } }), 0);
      assert.equal((await queue()).body.some(item => item.id === id), true, 'la transition manuelle ne retire pas un dossier encore sans projection');
      const tiers = await prisma.user.create({ data: { email: `file.tiers.${Date.now()}@iris.test`, name: 'TEST Tiers file', role: 'CONDUCTEUR_TRAVAUX' } });
      assert.equal((await request(app).get('/api/planning/interventions-a-planifier').set(auth(jwt.sign({ id: tiers.id }, process.env.JWT_SECRET)))).body.some(item => item.id === id), false);
      assert.equal((await request(app).get('/api/planning/interventions-a-planifier')).status, 401);
      const technicien = await prisma.intervenant.create({ data: { nom: `TEST File technicien ${Date.now()}`, role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const place = body => request(app).put(`/api/interventions/${id}/planning`).set(auth(session)).send(body);
      assert.equal((await place({ dateDebut: '2099-01-01', creneau: 'HEURES', heureDebut: '09:00', heureFin: '10:45', intervenantIds: ['inconnu'] })).status, 400);
      assert.equal((await queue()).body.some(item => item.id === id), true);
      const payload = { dateDebut: '2099-01-01', creneau: 'HEURES', heureDebut: '09:00', heureFin: '11:00', intervenantIds: [technicien.id] };
      const placed = await place(payload);
      assert.equal(placed.status, 200, JSON.stringify(placed.body));
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, 'PLANIFIEE');
      assert.equal((await queue()).body.some(item => item.id === id), false);
      const traces = await prisma.journalSaisieChantier.findMany({ where: { interventionId: id, action: 'CHANGEMENT_STATUT' } });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].avant.statut, 'A_PLANIFIER');
      assert.equal(traces[0].apres.statut, 'PLANIFIEE');
      assert.equal(traces[0].auteurId, jwt.verify(session, process.env.JWT_SECRET).id);
      const auteur = await prisma.user.findUniqueOrThrow({ where: { id: traces[0].auteurId } });
      assert.equal(traces[0].auteurNom, auteur.name);
      const again = await place(payload);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.id, placed.body.id);
      assert.equal(await prisma.planningEvent.count({ where: { interventionId: id } }), 1);
      const sqlProof = await prisma.$queryRaw`SELECT i."statut", count(DISTINCT p."id")::int AS projections, count(DISTINCT a."intervenantId")::int AS affectations FROM "Intervention" i JOIN "PlanningEvent" p ON p."interventionId" = i."id" LEFT JOIN "InterventionAffectation" a ON a."interventionId" = i."id" WHERE i."id" = ${id} GROUP BY i."statut"`;
      assert.deepEqual(sqlProof, [{ statut: 'PLANIFIEE', projections: 1, affectations: 1 }]);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { interventionId: id, action: 'CHANGEMENT_STATUT' } }), 1);
      assert.equal((await request(app).put(`/api/interventions/${id}/planning`).set(auth(jwt.sign({ id: tiers.id }, process.env.JWT_SECRET))).send(payload)).status, 404);
      const projectionUrl = `/api/planning/events/${placed.body.id}`;
      const eventsTiers = await request(app).get('/api/planning/events?start=2099-01-01&end=2099-01-01').set(auth(jwt.sign({ id: tiers.id }, process.env.JWT_SECRET)));
      assert.equal(eventsTiers.status, 200);
      assert.equal(eventsTiers.body.some(event => event.interventionId === id), false);
      assert.equal((await request(app).patch(projectionUrl).set(auth(jwt.sign({ id: tiers.id }, process.env.JWT_SECRET))).send({ intervenantIds: [] })).status, 404);
      assert.equal((await request(app).patch(projectionUrl).set(auth(session)).send({ categorie: 'EVENEMENT' })).status, 400);
      const projectionAvantTitre = await prisma.planningEvent.findUniqueOrThrow({ where: { id: placed.body.id } });
      const titreRefuse = await request(app).patch(projectionUrl).set(auth(session)).send({ titre: 'X' });
      assert.equal(titreRefuse.status, 400, JSON.stringify(titreRefuse.body));
      assert.deepEqual(await prisma.planningEvent.findUniqueOrThrow({ where: { id: placed.body.id } }), projectionAvantTitre);
      assert.equal((await request(app).patch(projectionUrl).set(auth(session)).send({ intervenantIds: ['inconnu'] })).status, 400);
      assert.deepEqual((await prisma.interventionAffectation.findMany({ where: { interventionId: id }, select: { intervenantId: true } })).map(a => a.intervenantId), [technicien.id]);
      const transition = await request(app).patch(`/api/interventions/${id}/statut`).set(auth(session)).send({ statut: 'EN_COURS' });
      assert.equal(transition.status, 200, JSON.stringify(transition.body));
      assert.equal((await place(payload)).status, 200);
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, 'EN_COURS');
      assert.equal((await queue()).body.some(item => item.id === id), false);
    });

    test('second passage EN_COURS sans projection : placement PUT et déplacement PATCH conservent le statut et synchronisent les affectations', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST Second passage', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      for (const source of ['hors contrat', 'contrat ACTIF']) {
        let id;
        if (source === 'hors contrat') {
          const dossier = await request(app).post('/api/interventions').set(auth).send({ clientId, titre: 'TEST Second passage hors contrat' });
          assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
          id = dossier.body.id;
        } else {
          const contrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: 'TEST Second passage contrat', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
          assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
          const visite = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth);
          assert.equal(visite.status, 201, JSON.stringify(visite.body));
          id = visite.body.id;
        }
        assert.equal((await request(app).patch(`/api/interventions/${id}/statut`).set(auth).send({ statut: 'PLANIFIEE' })).status, 200);
        assert.equal((await request(app).patch(`/api/interventions/${id}/statut`).set(auth).send({ statut: 'EN_COURS' })).status, 200);
        assert.equal(await prisma.planningEvent.count({ where: { interventionId: id } }), 0);
        const placed = await request(app).put(`/api/interventions/${id}/planning`).set(auth).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
        assert.equal(placed.status, 200, `${source}: ${JSON.stringify(placed.body)}`);
        assert.equal(placed.body.interventionId, id);
        assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, 'EN_COURS');
        assert.deepEqual((await prisma.interventionAffectation.findMany({ where: { interventionId: id }, select: { intervenantId: true } })).map(a => a.intervenantId), [technicien.id]);
        const moved = await request(app).patch(`/api/planning/events/${placed.body.id}`).set(auth).send({ dateDebut: '2099-01-02', dateFin: '2099-01-02' });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.equal((await prisma.planningEvent.findUniqueOrThrow({ where: { interventionId: id } })).dateDebut.toISOString().slice(0, 10), '2099-01-02');
        assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, 'EN_COURS');
        assert.deepEqual((await prisma.interventionAffectation.findMany({ where: { interventionId: id }, select: { intervenantId: true } })).map(a => a.intervenantId), [technicien.id]);
      }
    });

    test('visite EN_COURS sans projection : contrat suspendu ou clos interdit le premier PUT sans effet', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST Second passage refus', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      for (const statut of ['SUSPENDU', 'TERMINE']) {
        const contrat = await request(app).post('/api/contrats-maintenance').set(auth).send({ clientId, siteId, titre: `TEST Second passage ${statut}`, periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '01-01-2099' });
        assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
        const visite = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set(auth);
        assert.equal(visite.status, 201, JSON.stringify(visite.body));
        const id = visite.body.id;
        for (const etape of ['PLANIFIEE', 'EN_COURS']) {
          assert.equal((await request(app).patch(`/api/interventions/${id}/statut`).set(auth).send({ statut: etape })).status, 200);
        }
        assert.equal((await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set(auth).send({ statut, motif: 'TEST premier passage refusé' })).status, 200);
        const avant = await prisma.intervention.findUniqueOrThrow({ where: { id } });
        // Lectures ordonnées : sans orderBy, PostgreSQL peut rendre les mêmes lignes dans un autre ordre.
        const journalAvant = await prisma.journalSaisieChantier.findMany({ where: { interventionId: id }, orderBy: { id: 'asc' } });
        const refus = await request(app).put(`/api/interventions/${id}/planning`).set(auth).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.deepEqual(await prisma.intervention.findUniqueOrThrow({ where: { id } }), avant);
        assert.deepEqual(await prisma.journalSaisieChantier.findMany({ where: { interventionId: id }, orderBy: { id: 'asc' } }), journalAvant);
        assert.equal(await prisma.planningEvent.count({ where: { interventionId: id } }), 0);
        assert.equal(await prisma.interventionAffectation.count({ where: { interventionId: id } }), 0);
      }
    });

    test('états terminaux sans projection : PUT interdit sans effet', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST Terminal sans projection', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      for (const statut of ['TERMINEE', 'ANNULEE']) {
        const dossier = await request(app).post('/api/interventions').set(auth).send({ clientId, titre: `TEST Terminal sans projection ${statut}` });
        assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
        const id = dossier.body.id;
        const transitions = statut === 'TERMINEE' ? ['PLANIFIEE', 'EN_COURS', 'TERMINEE'] : ['ANNULEE'];
        for (const etape of transitions) assert.equal((await request(app).patch(`/api/interventions/${id}/statut`).set(auth).send({ statut: etape })).status, 200);
        const avant = await prisma.intervention.findUniqueOrThrow({ where: { id } });
        const refus = await request(app).put(`/api/interventions/${id}/planning`).set(auth).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.deepEqual(await prisma.intervention.findUniqueOrThrow({ where: { id } }), avant);
        assert.equal(await prisma.planningEvent.count({ where: { interventionId: id } }), 0);
        assert.equal(await prisma.interventionAffectation.count({ where: { interventionId: id } }), 0);
      }
    });

    test('projection liée déplaçable EN_COURS, figée aux états terminaux, sans fuite de périmètre', async () => {
      const auth = token => ({ Authorization: `Bearer ${token}` });
      const conducteur = await prisma.user.create({ data: { email: `file.conducteur.${Date.now()}@iris.test`, name: 'TEST Conducteur projection', role: 'CONDUCTEUR_TRAVAUX' } });
      const tiers = await prisma.user.create({ data: { email: `file.invisible.${Date.now()}@iris.test`, name: 'TEST Conducteur invisible', role: 'CONDUCTEUR_TRAVAUX' } });
      const conducteurToken = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const tiersToken = jwt.sign({ id: tiers.id }, process.env.JWT_SECRET);
      const premier = await prisma.intervenant.create({ data: { nom: 'TEST Projection premier', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const second = await prisma.intervenant.create({ data: { nom: 'TEST Projection second', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      for (const statut of ['EN_COURS', 'TERMINEE', 'ANNULEE']) {
        const dossier = await request(app).post('/api/interventions').set(auth(conducteurToken)).send({ clientId, titre: `TEST Projection ${statut}` });
        assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
        const id = dossier.body.id;
        const placed = await request(app).put(`/api/interventions/${id}/planning`).set(auth(conducteurToken))
          .send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [premier.id] });
        assert.equal(placed.status, 200, JSON.stringify(placed.body));
        const url = `/api/planning/events/${placed.body.id}`;
        for (const next of statut === 'TERMINEE' ? ['EN_COURS', 'TERMINEE'] : [statut]) {
          const transition = await request(app).patch(`/api/interventions/${id}/statut`).set(auth(session)).send({ statut: next });
          assert.equal(transition.status, 200, JSON.stringify(transition.body));
        }
        const avant = await prisma.planningEvent.findUniqueOrThrow({ where: { id: placed.body.id }, include: { intervenants: { select: { id: true } } } });
        const affectations = await prisma.interventionAffectation.findMany({ where: { interventionId: id }, select: { intervenantId: true } });
        const mutation = { dateDebut: '2099-01-02', dateFin: '2099-01-02', intervenantIds: [second.id] };
        assert.equal((await request(app).patch(url).set(auth(tiersToken)).send(mutation)).status, 404);
        for (const token of [session, conducteurToken]) {
          const resultat = await request(app).patch(url).set(auth(token)).send(mutation);
          assert.equal(resultat.status, statut === 'EN_COURS' ? 200 : 409, JSON.stringify(resultat.body));
        }
        if (statut !== 'EN_COURS') {
          const refusPut = await request(app).put(`/api/interventions/${id}/planning`).set(auth(session)).send({ dateDebut: '2099-01-03', creneau: 'JOURNEE', intervenantIds: [second.id] });
          assert.equal(refusPut.status, 409, JSON.stringify(refusPut.body));
        }
        const apres = await prisma.planningEvent.findUniqueOrThrow({ where: { id: placed.body.id }, include: { intervenants: { select: { id: true } } } });
        if (statut === 'EN_COURS') {
          assert.equal(apres.dateDebut.toISOString().slice(0, 10), '2099-01-02');
          assert.deepEqual(apres.intervenants.map(i => i.id), [second.id]);
          assert.deepEqual((await prisma.interventionAffectation.findMany({ where: { interventionId: id }, select: { intervenantId: true } })).map(a => a.intervenantId), [second.id]);
        } else {
          assert.deepEqual(apres, avant);
          assert.deepEqual(await prisma.interventionAffectation.findMany({ where: { interventionId: id }, select: { intervenantId: true } }), affectations);
        }
        assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, statut);
      }
    });

    test('PUT attend le verrou puis rejette la transition terminale sans toucher projection ni affectations', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const dossier = await request(app).post('/api/interventions').set(auth).send({ clientId, titre: 'TEST PUT statut sous verrou' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      const id = dossier.body.id;
      const premier = await prisma.intervenant.create({ data: { nom: 'TEST PUT verrou premier', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const second = await prisma.intervenant.create({ data: { nom: 'TEST PUT verrou second', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const placed = await request(app).put(`/api/interventions/${id}/planning`).set(auth).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [premier.id] });
      assert.equal(placed.status, 200, JSON.stringify(placed.body));
      const avant = await prisma.planningEvent.findUniqueOrThrow({ where: { interventionId: id }, include: { intervenants: { select: { id: true } } } });
      const affectations = await prisma.interventionAffectation.findMany({ where: { interventionId: id } });
      let liberer, pret;
      const attente = new Promise(resolve => { liberer = resolve; });
      const verrouPris = new Promise(resolve => { pret = resolve; });
      const verrou = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Intervention" WHERE "id" = ${id} FOR UPDATE`;
        pret();
        await attente;
        await tx.intervention.update({ where: { id }, data: { statut: 'TERMINEE' } });
      }, { timeout: 15000 });
      await verrouPris;
      let requete;
      try {
        requete = request(app).put(`/api/interventions/${id}/planning`).set(auth).send({ dateDebut: '2099-01-02', creneau: 'JOURNEE', intervenantIds: [second.id] }).then(result => result);
        let bloque = false;
        for (let tour = 0; tour < 150; tour++) {
          const sessions = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Intervention"%FOR UPDATE%'`;
          if (sessions.length) { bloque = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(bloque, true, 'PUT doit attendre la mutation concurrente');
      } finally {
        liberer();
        await verrou;
      }
      const refus = await requete;
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, 'TERMINEE');
      assert.deepEqual(await prisma.planningEvent.findUniqueOrThrow({ where: { interventionId: id }, include: { intervenants: { select: { id: true } } } }), avant);
      assert.deepEqual(await prisma.interventionAffectation.findMany({ where: { interventionId: id } }), affectations);
    });

    test('PATCH attend le verrou puis recontrôle statut et périmètre avant toute mutation', async () => {
      const auth = token => ({ Authorization: `Bearer ${token}` });
      const conducteur = await prisma.user.create({ data: { email: `file.patch.race.${Date.now()}@iris.test`, name: 'TEST Conducteur PATCH course', role: 'CONDUCTEUR_TRAVAUX' } });
      const token = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Chantier PATCH course', client: 'TEST Client contrat maintenance', clientId, dateDebut: new Date('2099-01-01'), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const premier = await prisma.intervenant.create({ data: { nom: 'TEST PATCH verrou premier', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const second = await prisma.intervenant.create({ data: { nom: 'TEST PATCH verrou second', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      for (const changement of ['statut', 'périmètre']) {
        const dossier = await request(app).post('/api/interventions').set(auth(session)).send({ clientId, chantierId: chantier.id, titre: `TEST PATCH course ${changement}` });
        assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
        const id = dossier.body.id;
        const placed = await request(app).put(`/api/interventions/${id}/planning`).set(auth(session)).send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [premier.id] });
        assert.equal(placed.status, 200, JSON.stringify(placed.body));
        const avant = await prisma.planningEvent.findUniqueOrThrow({ where: { id: placed.body.id }, include: { intervenants: { select: { id: true } } } });
        const affectations = await prisma.interventionAffectation.findMany({ where: { interventionId: id } });
        let liberer, pret;
        const attente = new Promise(resolve => { liberer = resolve; });
        const verrouPris = new Promise(resolve => { pret = resolve; });
        const verrou = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Intervention" WHERE "id" = ${id} FOR UPDATE`;
          pret();
          await attente;
          await tx.intervention.update({ where: { id }, data: { statut: 'TERMINEE' } });
        }, { timeout: 15000 });
        await verrouPris;
        let requete;
        try {
          requete = request(app).patch(`/api/planning/events/${placed.body.id}`).set(auth(token))
            .send({ dateDebut: '2099-01-02', dateFin: '2099-01-02', intervenantIds: [second.id] }).then(result => result);
          let bloque = false;
          for (let tour = 0; tour < 150; tour++) {
            const sessions = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Intervention"%FOR UPDATE%'`;
            if (sessions.length) { bloque = true; break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.equal(bloque, true, 'PATCH doit attendre le verrou après lecture autorisée');
          if (changement === 'périmètre') await prisma.chantier.update({ where: { id: chantier.id }, data: { responsableId: null } });
        } finally {
          liberer();
          await verrou;
        }
        const refus = await requete;
        assert.equal(refus.status, changement === 'statut' ? 409 : 404, `${changement}: ${JSON.stringify(refus.body)}`);
        assert.deepEqual(await prisma.planningEvent.findUniqueOrThrow({ where: { id: placed.body.id }, include: { intervenants: { select: { id: true } } } }), avant);
        assert.deepEqual(await prisma.interventionAffectation.findMany({ where: { interventionId: id } }), affectations);
      }
    });

    test('PUT recontrôle le périmètre après verrouillage si le rattachement change pendant la requête', async () => {
      const auth = token => ({ Authorization: `Bearer ${token}` });
      const conducteur = await prisma.user.create({ data: { email: `file.race.${Date.now()}@iris.test`, name: 'TEST Conducteur course', role: 'CONDUCTEUR_TRAVAUX' } });
      const token = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Chantier course planning', client: 'TEST Client contrat maintenance', clientId, dateDebut: new Date('2099-01-01'), budgetGlobalVendu: 1000, responsableId: conducteur.id } });
      const dossier = await request(app).post('/api/interventions').set(auth(session)).send({ clientId, chantierId: chantier.id, titre: 'TEST Dossier course planning' });
      assert.equal(dossier.status, 201, JSON.stringify(dossier.body));
      const id = dossier.body.id;
      const technicien = await prisma.intervenant.create({ data: { nom: 'TEST Technicien course', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      assert.equal((await request(app).get('/api/interventions').set(auth(token))).body.some(item => item.id === id), true);
      let liberer;
      const attente = new Promise(resolve => { liberer = resolve; });
      let verrouiller;
      const pret = new Promise(resolve => { verrouiller = resolve; });
      const verrou = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Intervention" WHERE "id" = ${id} FOR UPDATE`;
        verrouiller();
        await attente;
      }, { timeout: 15000 });
      await pret;
      let requete;
      try {
        requete = request(app).put(`/api/interventions/${id}/planning`).set(auth(token))
          .send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] }).then(result => result);
        let bloque = false;
        for (let tour = 0; tour < 150; tour++) {
          const sessions = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Intervention"%FOR UPDATE%'`;
          if (sessions.length) { bloque = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(bloque, true, 'le PUT doit être suspendu au verrou après sa première lecture autorisée');
        await prisma.chantier.update({ where: { id: chantier.id }, data: { responsableId: null } });
      } finally {
        liberer();
        await verrou;
      }
      const refus = await requete;
      assert.equal(refus.status, 404, JSON.stringify(refus.body));
      assert.equal((await request(app).get('/api/interventions').set(auth(token))).body.some(item => item.id === id), false);
      assert.equal(await prisma.planningEvent.count({ where: { interventionId: id } }), 0);
      assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id } })).statut, 'A_PLANIFIER');
      const admin = await request(app).put(`/api/interventions/${id}/planning`).set(auth(session))
        .send({ dateDebut: '2099-01-01', creneau: 'JOURNEE', intervenantIds: [technicien.id] });
      assert.equal(admin.status, 200, JSON.stringify(admin.body));
    });

    test('crée un contrat actif rattaché à son client et son site', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Maintenance incendie', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      contratId = contrat.body.id;
      assert.equal(contrat.body.statut, 'ACTIF');
      assert.equal(contrat.body.client.id, clientId);
      assert.equal(contrat.body.site.id, siteId);
      assert.equal(contrat.body.periodiciteMois, 6);
      assert.equal(contrat.body.dureePrevisionnelleMinutes, 120);
    });

    test('enregistre une politique de couverture bornée avec les deux postes explicites', async () => {
      const note = 'Couverture préventive, hors pièces d’usure.';
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat couverture création', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '09-09-2026',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: note,
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      assert.deepEqual({
        politiqueMainOeuvre: contrat.body.politiqueMainOeuvre,
        politiqueMateriel: contrat.body.politiqueMateriel,
        noteCouverture: contrat.body.noteCouverture,
      }, {
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: note,
      });
      const journalCreation = await request(app).get(`/api/contrats-maintenance/${contrat.body.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journalCreation.status, 200, JSON.stringify(journalCreation.body));
      assert.equal(journalCreation.body.length, 1);
      assert.equal(journalCreation.body[0].action, 'CREATION');
      assert.equal(journalCreation.body[0].avant, null, 'la création stocke explicitement un état antérieur NULL');
      assert.equal(journalCreation.body[0].apres.id, contrat.body.id);

      for (const corps of [
        { politiqueMainOeuvre: 'FORFAIT_TOTAL' },
        { politiqueMateriel: 'OPTIONNEL' },
        { noteCouverture: 'x'.repeat(1001) },
      ]) {
        const refus = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
          clientId, siteId, titre: 'TEST Contrat couverture invalide', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '09-09-2026',
          politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS', ...corps,
        });
        assert.equal(refus.status, 400, `${JSON.stringify(corps)} → ${JSON.stringify(refus.body)}`);
      }
    });

    test('réserve la modification de couverture à l’administration et ne crée ni devis ni facture', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat couverture modifiable', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '10-09-2026',
        politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const conducteur = await prisma.user.create({ data: { email: 'contrat.couverture.technicien@iris.test', name: 'TEST Technicien couverture', role: 'TECHNICIEN' } });
      const jetonTechnicien = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const factureAvant = await prisma.facture.count({ where: { contratMaintenanceId: contrat.body.id } });
      const devisAvant = await prisma.devis.count({ where: { clientId } });
      const politique = { politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: 'Déplacement inclus, consommables hors forfait.', motif: 'Renégociation annuelle de la couverture' };

      const refus = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${jetonTechnicien}`).send(politique);
      assert.equal(refus.status, 403, JSON.stringify(refus.body));
      for (const corps of [{}, { titre: 'Modification hors politique' }]) {
        const sansPolitique = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${session}`).send(corps);
        assert.equal(sansPolitique.status, 400, 'une requête sans champ de couverture est refusée');
      }
      const tracesAvantModification = await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: contrat.body.id } });
      assert.equal(tracesAvantModification, 1, 'aucun refus ne crée de journal');
      const miseAJour = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${session}`).send(politique);
      assert.equal(miseAJour.status, 200, JSON.stringify(miseAJour.body));
      assert.deepEqual(Object.fromEntries(Object.keys(politique).filter((cle) => cle !== 'motif').map((cle) => [cle, miseAJour.body[cle]])), {
        politiqueMainOeuvre: politique.politiqueMainOeuvre, politiqueMateriel: politique.politiqueMateriel, noteCouverture: politique.noteCouverture,
      });
      const journal = await request(app).get(`/api/contrats-maintenance/${contrat.body.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      const modification = journal.body.find((entree) => entree.action === 'MODIFICATION_COUVERTURE');
      assert.equal(modification.motif, politique.motif);
      assert.deepEqual(Object.fromEntries(Object.keys(politique).filter((cle) => cle !== 'motif').map((cle) => [cle, modification.avant[cle]])), {
        politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS', noteCouverture: null,
      });
      assert.deepEqual(Object.fromEntries(Object.keys(politique).filter((cle) => cle !== 'motif').map((cle) => [cle, modification.apres[cle]])), {
        politiqueMainOeuvre: politique.politiqueMainOeuvre, politiqueMateriel: politique.politiqueMateriel, noteCouverture: politique.noteCouverture,
      });
      const tracesAvantRefus = journal.body.length;
      assert.equal(await prisma.facture.count({ where: { contratMaintenanceId: contrat.body.id } }), factureAvant, 'la politique ne crée aucune facture');
      assert.equal(await prisma.devis.count({ where: { clientId } }), devisAvant, 'la politique ne crée aucun devis');

      const cloture = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE', motif: 'Fin du contrat de test' });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      const mutationApresCloture = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${session}`).send({ noteCouverture: 'Tentative interdite', motif: 'Contrat déjà clos' });
      assert.equal(mutationApresCloture.status, 409, JSON.stringify(mutationApresCloture.body));
      const journalApresRefus = await request(app).get(`/api/contrats-maintenance/${contrat.body.id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journalApresRefus.body.length, tracesAvantRefus + 1, 'seule la clôture autorisée est tracée ; le refus ne crée aucune trace');
      const generationApresCloture = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generationApresCloture.status, 404, JSON.stringify(generationApresCloture.body));
    });

    test('refuse les motifs invalides de couverture sans modifier le contrat ni son journal', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Motifs couverture', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      for (const motif of [undefined, null, 123, '', '  ab  ', 'x'.repeat(501), '🔧'.repeat(501), 'Avant\naprès', 'Avant\taprès', 'Avant\u007faprès', 'Avant\u0085après', 'Avant\u200baprès', 'Avant\u202eaprès']) {
        const refus = await request(app).patch(`/api/contrats-maintenance/${id}`).set('Authorization', `Bearer ${session}`)
          .send({ politiqueMainOeuvre: 'INCLUSE', ...(motif === undefined ? {} : { motif }) });
        assert.equal(refus.status, 400, `${JSON.stringify(motif)} → ${JSON.stringify(refus.body)}`);
      }
      const journal = await request(app).get(`/api/contrats-maintenance/${id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.body.length, 1);
      assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id } })).politiqueMainOeuvre, creation.body.politiqueMainOeuvre);
      const accepte = await request(app).patch(`/api/contrats-maintenance/${id}`).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMainOeuvre: 'INCLUSE', motif: '  🔧évolution  ' });
      assert.equal(accepte.status, 200, JSON.stringify(accepte.body));
      const trace = await request(app).get(`/api/contrats-maintenance/${id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(trace.body[0].motif, '🔧évolution');
      const borneUnicode = await request(app).patch(`/api/contrats-maintenance/${id}`).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMateriel: 'INCLUS', motif: '🔧'.repeat(500) });
      assert.equal(borneUnicode.status, 200, JSON.stringify(borneUnicode.body));
    });

    test('refuse la version périmée après une modification concurrente sans écraser ni journaliser', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Concurrence couverture', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const url = `/api/contrats-maintenance/${creation.body.id}`;
      const version = creation.body.updatedAt;
      const premier = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ politiqueMainOeuvre: 'INCLUSE', motif: 'Premier changement', expectedUpdatedAt: version });
      assert.equal(premier.status, 200, JSON.stringify(premier.body));
      assert.notEqual(premier.body.updatedAt, version);
      const perime = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ politiqueMateriel: 'INCLUS', motif: 'Éditeur périmé', expectedUpdatedAt: version });
      assert.equal(perime.status, 409, JSON.stringify(perime.body));
      assert.match(perime.body.error, /actualis|modifi|périm/i);
      const relu = await prisma.contratMaintenance.findUniqueOrThrow({ where: { id: creation.body.id } });
      assert.equal(relu.politiqueMainOeuvre, 'INCLUSE');
      assert.equal(relu.politiqueMateriel, 'HORS_FORFAIT');
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: creation.body.id } }), 2);
    });

    test('refuse la couverture inchangée et suspendue, puis autorise la modification après réactivation motivée', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Contrat suspendu couverture', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const couverture = `/api/contrats-maintenance/${id}`;
      const statut = `${couverture}/statut`;
      const inchangée = await request(app).patch(couverture).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMainOeuvre: creation.body.politiqueMainOeuvre, noteCouverture: '  ', motif: 'Contrôle sans changement' });
      assert.equal(inchangée.status, 409, JSON.stringify(inchangée.body));
      const suspension = await request(app).patch(statut).set('Authorization', `Bearer ${session}`).send({ statut: 'SUSPENDU', motif: 'Pause contractuelle' });
      assert.equal(suspension.status, 200, JSON.stringify(suspension.body));
      const refus = await request(app).patch(couverture).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMainOeuvre: 'INCLUSE', motif: 'Changement durant la pause' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /réactiv/i);
      assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id } })).politiqueMainOeuvre, creation.body.politiqueMainOeuvre);
      const avant = await request(app).get(`${couverture}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.deepEqual(avant.body.map((entree) => entree.action).sort(), ['CREATION', 'SUSPENSION']);
      const reactivation = await request(app).patch(statut).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF', motif: 'Reprise du service' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      const modification = await request(app).patch(couverture).set('Authorization', `Bearer ${session}`)
        .send({ politiqueMainOeuvre: 'INCLUSE', motif: 'Nouvelle couverture applicable' });
      assert.equal(modification.status, 200, JSON.stringify(modification.body));
      const journal = await request(app).get(`${couverture}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.body.find((entree) => entree.action === 'REACTIVATION')?.motif, 'Reprise du service');
      assert.equal(journal.body.find((entree) => entree.action === 'MODIFICATION_COUVERTURE')?.motif, 'Nouvelle couverture applicable');
      assert.equal(journal.body.length, 4, 'aucun refus ne crée de trace');
    });

    test('impose le même motif borné sans contrôles à chaque transition de statut', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Motifs statut', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const url = `/api/contrats-maintenance/${id}/statut`;
      const refuser = async (cible) => {
        for (const motif of [undefined, null, '', ' ab ', 'x'.repeat(501), '🔧'.repeat(501), 'Avant\naprès', 'Avant\u0000après', 'Avant\u007faprès', 'Avant\u0085après', 'Avant\u200baprès', 'Avant\u202eaprès']) {
          const refus = await request(app).patch(url).set('Authorization', `Bearer ${session}`)
            .send({ statut: cible, ...(motif === undefined ? {} : { motif }) });
          assert.equal(refus.status, 400, `${cible} ${JSON.stringify(motif)} → ${JSON.stringify(refus.body)}`);
        }
      };
      await refuser('SUSPENDU');
      const suspension = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ statut: 'SUSPENDU', motif: '  Pause demandée  ' });
      assert.equal(suspension.status, 200, JSON.stringify(suspension.body));
      await refuser('ACTIF');
      const reactivation = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF', motif: '🔧évolution' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      await refuser('TERMINE');
      const cloture = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE', motif: 'x'.repeat(500) });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      const journal = await request(app).get(`/api/contrats-maintenance/${id}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.body.length, 4);
      assert.equal(journal.body.find((entree) => entree.action === 'SUSPENSION')?.motif, 'Pause demandée');
      assert.equal(journal.body.find((entree) => entree.action === 'REACTIVATION')?.motif, '🔧évolution');
      assert.equal(journal.body.find((entree) => entree.action === 'CLOTURE')?.motif, 'x'.repeat(500));
    });

    test('CHECK SQL : motif NULL interdit pour une transition CONTRAT, permis pour CREATION', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Contrainte motif journal', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const original = await prisma.journalSaisieChantier.findFirstOrThrow({ where: { contratMaintenanceId: creation.body.id } });
      assert.equal(original.action, 'CREATION');
      assert.equal(original.motif, null, 'la création historique reste compatible');
      for (const action of ['SUSPENSION', 'AVANCEMENT_ECHEANCE', 'MODIFICATION_COUVERTURE']) {
        await assert.rejects(() => prisma.$executeRawUnsafe(
          'INSERT INTO "JournalSaisieChantier" ("id", "contratMaintenanceId", "cible", "cibleId", "action", "auteurId", "auteurNom", "motif") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NULL)',
          creation.body.id, 'CONTRAT', creation.body.id, action, original.auteurId, original.auteurNom,
        ), `motif NULL interdit pour ${action}`);
      }
      const creationDirecte = await prisma.$executeRawUnsafe(
        'INSERT INTO "JournalSaisieChantier" ("id", "contratMaintenanceId", "cible", "cibleId", "action", "auteurId", "auteurNom", "motif") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NULL)',
        creation.body.id, 'CONTRAT', creation.body.id, 'CREATION', original.auteurId, original.auteurNom,
      );
      assert.equal(creationDirecte, 1);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: creation.body.id } }), 2);
      const intervention = await prisma.intervention.create({ data: {
        clientId, reference: `TEST-MOTIF-SAV-${Date.now()}`, titre: 'TEST Motif SAV distinct',
      } });
      assert.equal(await prisma.$executeRawUnsafe(
        'INSERT INTO "JournalSaisieChantier" ("id", "interventionId", "cible", "cibleId", "action", "auteurId", "auteurNom", "motif") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NULL)',
        intervention.id, 'INTERVENTION', intervention.id, 'CHANGEMENT_STATUT', original.auteurId, original.auteurNom,
      ), 1, 'une cible non-contrat reste hors du CHECK');
    });

    test('avancement : succès journalisé avec référence et échéances, refus sans nouvelle trace', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Journal échéance', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const url = `/api/contrats-maintenance/${id}/avancer-echeance`;
      const generation = await request(app).post(`/api/contrats-maintenance/${id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generation.status, 201, JSON.stringify(generation.body));
      const journalAvant = await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } });
      assert.equal((await request(app).post(url).set('Authorization', `Bearer ${session}`)).status, 409);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } }), journalAvant);
      for (const statut of ['PLANIFIEE', 'EN_COURS', 'TERMINEE']) {
        const transition = await request(app).patch(`/api/interventions/${generation.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut });
        assert.equal(transition.status, 200, JSON.stringify(transition.body));
      }
      const avance = await request(app).post(url).set('Authorization', `Bearer ${session}`);
      assert.equal(avance.status, 200, JSON.stringify(avance.body));
      const traces = await prisma.journalSaisieChantier.findMany({ where: { contratMaintenanceId: id, action: 'AVANCEMENT_ECHEANCE' } });
      assert.equal(traces.length, 1);
      const trace = traces[0];
      assert.equal(trace.cible, 'CONTRAT');
      assert.equal(trace.cibleId, id);
      assert.equal(trace.auteurNom, (await prisma.user.findUniqueOrThrow({ where: { id: trace.auteurId } })).name);
      assert.match(trace.motif, new RegExp(generation.body.reference));
      assert.equal(trace.avant.prochaineEcheance, creation.body.prochaineEcheance);
      assert.equal(trace.apres.prochaineEcheance, avance.body.prochaineEcheance);
      assert.equal((await request(app).post(url).set('Authorization', `Bearer ${session}`)).status, 409);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } }), journalAvant + 1);
    });

    test('échec de journalisation : l’avancement est annulé atomiquement', async () => {
      const creation = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, titre: 'TEST Atomicité journal échéance', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '10-09-2026',
      });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const intervention = await prisma.intervention.create({ data: {
        clientId, contratMaintenanceId: id, echeanceContrat: new Date(creation.body.prochaineEcheance), dateDemande: new Date(creation.body.prochaineEcheance),
        reference: `TEST-ATOMICITE-${Date.now()}`, titre: 'TEST Intervention terminée', statut: 'TERMINEE',
      } });
      const avant = await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } });
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "test_refuser_avancement_journal"()
        RETURNS TRIGGER AS $$ BEGIN
          IF NEW."action" = 'AVANCEMENT_ECHEANCE' AND NEW."cibleId" = '${id}' THEN
            RAISE EXCEPTION 'journal refusé pour le test';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql;`);
      await prisma.$executeRawUnsafe('CREATE TRIGGER "test_refuser_avancement_journal" BEFORE INSERT ON "JournalSaisieChantier" FOR EACH ROW EXECUTE FUNCTION "test_refuser_avancement_journal"()');
      try {
        const refus = await request(app).post(`/api/contrats-maintenance/${id}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
        assert.equal(refus.status, 500, JSON.stringify(refus.body));
        assert.equal((await prisma.contratMaintenance.findUniqueOrThrow({ where: { id } })).prochaineEcheance.toISOString(), creation.body.prochaineEcheance);
        assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: id } }), avant);
        assert.equal((await prisma.intervention.findUniqueOrThrow({ where: { id: intervention.id } })).statut, 'TERMINEE');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_refuser_avancement_journal" ON "JournalSaisieChantier"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "test_refuser_avancement_journal"()');
      }
    });

    test('fige la couverture dans l’intervention générée et la rend lisible au technicien affecté', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat instantané couverture', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '11-09-2026',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: 'Main-d’œuvre incluse, matériel refacturable.',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const generation = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generation.status, 201, JSON.stringify(generation.body));
      assert.deepEqual(generation.body.couvertureContrat, {
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT', noteCouverture: 'Main-d’œuvre incluse, matériel refacturable.',
      });

      const technicien = await prisma.user.create({ data: { email: 'contrat.couverture.lecteur@iris.test', name: 'TEST Technicien lecteur couverture', role: 'TECHNICIEN' } });
      const intervenant = await prisma.intervenant.create({ data: { userId: technicien.id, nom: 'TEST Intervenant couverture', role: 'TECHNICIEN', tauxHoraireCharge: 42 } });
      await prisma.interventionAffectation.create({ data: { interventionId: generation.body.id, intervenantId: intervenant.id } });
      const jetonTechnicien = jwt.sign({ id: technicien.id }, process.env.JWT_SECRET);
      const lectureTechnicien = await request(app).get('/api/interventions').set('Authorization', `Bearer ${jetonTechnicien}`);
      assert.equal(lectureTechnicien.status, 200, JSON.stringify(lectureTechnicien.body));
      const interventionTechnicien = lectureTechnicien.body.find((intervention) => intervention.id === generation.body.id);
      assert.deepEqual(interventionTechnicien?.couvertureContrat, generation.body.couvertureContrat);

      const mutation = await request(app).patch(`/api/contrats-maintenance/${contrat.body.id}`).set('Authorization', `Bearer ${session}`).send({
        politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS', noteCouverture: 'Nouvelle politique pour les prochaines échéances.', motif: 'Evolution pour les prochaines échéances',
      });
      assert.equal(mutation.status, 200, JSON.stringify(mutation.body));
      const relue = await request(app).get('/api/interventions').set('Authorization', `Bearer ${session}`);
      assert.equal(relue.status, 200, JSON.stringify(relue.body));
      const interventionRelue = relue.body.find((intervention) => intervention.id === generation.body.id);
      assert.deepEqual(interventionRelue?.couvertureContrat, generation.body.couvertureContrat, 'une modification ultérieure du contrat ne réécrit pas l’instantané pour l’encadrement autorisé');
    });

    test('la base refuse toute donnée commerciale ou note structurée dans un instantané de couverture', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat contrainte JSON', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '12-09-2026',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const generation = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generation.status, 201, JSON.stringify(generation.body));

      for (const [index, couvertureInvalide] of [
        { politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS', montant: 1 },
        { politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS', noteCouverture: { texte: 'pas une chaîne' } },
      ].entries()) {
        await assert.rejects(() => prisma.$executeRawUnsafe(
          'INSERT INTO "Intervention" ("id", "reference", "clientId", "contratMaintenanceId", "titre", "couvertureContrat", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::jsonb, now(), now())',
          `TEST-CONTRAINTE-COUVERTURE-${Date.now()}-${index}`, clientId, contrat.body.id, 'TEST Instantané SQL invalide', JSON.stringify(couvertureInvalide),
        ), `PostgreSQL doit refuser ${JSON.stringify(couvertureInvalide)}`);
      }
      await assert.rejects(() => prisma.$executeRawUnsafe(
        'INSERT INTO "Intervention" ("id", "reference", "clientId", "titre", "couvertureContrat", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, now(), now())',
        `TEST-CONTRAINTE-COUVERTURE-SANS-CONTRAT-${Date.now()}`, clientId, 'TEST Instantané SQL sans contrat', JSON.stringify({ politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'INCLUS' }),
      ), 'PostgreSQL doit refuser une couverture sans contrat de maintenance');
    });

    test('la base interdit toute réécriture Prisma de l’instantané de couverture', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Contrat snapshot immuable', periodiciteMois: 12, dureePrevisionnelleMinutes: 90, dateDebut: '13-09-2026',
        politiqueMainOeuvre: 'INCLUSE', politiqueMateriel: 'HORS_FORFAIT',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const generation = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generation.status, 201, JSON.stringify(generation.body));
      await assert.rejects(() => prisma.$executeRawUnsafe(
        'UPDATE "Intervention" SET "couvertureContrat" = $1::jsonb WHERE "id" = $2',
        JSON.stringify({ politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS' }), generation.body.id,
      ), 'l’instantané ne doit pas être réécrivable par SQL direct');
      await assert.rejects(() => prisma.intervention.update({
        where: { id: generation.body.id },
        data: { couvertureContrat: { politiqueMainOeuvre: 'HORS_FORFAIT', politiqueMateriel: 'INCLUS' } },
      }), 'l’instantané ne doit être modifiable ni via Prisma ni par SQL direct');
    });

    test('réserve toutes les routes contrat à l’administration et ferme les contournements', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'contrat.conducteur@iris.test', name: 'TEST Conducteur contrat', role: 'CONDUCTEUR_TRAVAUX' } });
      const sessionConducteur = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const routesProtegees = [
        request(app).get('/api/contrats-maintenance'),
        request(app).post('/api/contrats-maintenance').send({ clientId, titre: 'TEST Contrat interdit', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026' }),
        request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).send({ statut: 'SUSPENDU' }),
        request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`),
        request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`),
      ];
      for (const route of routesProtegees) assert.equal((await route.set('Authorization', `Bearer ${sessionConducteur}`)).status, 403);

      const autreClient = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client contrat étranger' });
      const siteEtranger = await request(app).post(`/api/clients/${autreClient.body.id}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site étranger contrat', adresse: '2 rue du Test', codePostal: '69001', ville: 'Lyon' });
      const refusSite = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`)
        .send({ clientId, siteId: siteEtranger.body.id, titre: 'TEST Contrat site étranger', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026' });
      assert.equal(refusSite.status, 404, JSON.stringify(refusSite.body));

      for (const invalide of [{ periodiciteMois: 0 }, { periodiciteMois: 61 }, { dureePrevisionnelleMinutes: 5 }, { dureePrevisionnelleMinutes: 2000 }, { titre: 'ab' }]) {
        const refus = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`)
          .send({ clientId, titre: 'TEST Contrat bornes', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026', ...invalide });
        assert.equal(refus.status, 400, `${JSON.stringify(invalide)} → ${JSON.stringify(refus.body)}`);
      }

      const clientInactif = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client contrat inactif' });
      await prisma.client.update({ where: { id: clientInactif.body.id }, data: { actif: false } });
      const refusInactif = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`)
        .send({ clientId: clientInactif.body.id, titre: 'TEST Contrat client inactif', periodiciteMois: 6, dureePrevisionnelleMinutes: 120, dateDebut: '08-09-2026' });
      assert.equal(refusInactif.status, 404, JSON.stringify(refusInactif.body));
    });

    test('#95 : remappages et retrait exigent un motif, puis conservent une trace transactionnelle', async () => {
      const auth = `Bearer ${session}`;
      assert.equal((await request(app).get('/api/comptabilite/regles/journal')).status, 401);
      const nonAdmin = await prisma.user.create({ data: { email: 'regles95@iris.test', name: 'TEST Règles #95', role: 'CONDUCTEUR_TRAVAUX' } });
      const nonAdminAuth = `Bearer ${jwt.sign({ id: nonAdmin.id }, process.env.JWT_SECRET)}`;
      assert.equal((await request(app).get('/api/comptabilite/regles/journal').set('Authorization', nonAdminAuth)).status, 403);
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', nonAdminAuth).send({ journal: 'VTE' })).status, 403);
      const a = await prisma.compteComptable.create({ data: { code: '445895', libelle: 'TVA origine #95', nature: 'TVA' } });
      const b = await prisma.compteComptable.create({ data: { code: '445896', libelle: 'TVA cible #95', nature: 'TVA' } });
      const u = '/api/comptabilite/tva/9.5';
      assert.equal((await request(app).put(u).set('Authorization', auth).send({ compteId: a.id })).status, 400);
      assert.equal((await request(app).put(u).set('Authorization', auth).send({ compteId: a.id, motif: 'Création du taux initial' })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', auth).send({ journal: 'VTE' })).status, 400);
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', auth).send({ journal: 'VTE', motif: 'Création du journal initial' })).status, 200);
      const tvaVersion = await versionTva(9.5);
      const journalVersion = await versionRegle('JOURNAL_VENTES');
      for (const motif of [undefined, 'ab', 'invalide\u200b']) {
        const body = { compteId: b.id, ...tvaVersion, ...(motif === undefined ? {} : { motif }) };
        const tracesAvant = await prisma.journalRegleComptable.count();
        assert.equal((await request(app).put(u).set('Authorization', auth).send(body)).status, 400);
        assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 9.5 } })).compteId, a.id);
        assert.equal(await prisma.journalRegleComptable.count(), tracesAvant);
      }
      const tvaAvant = await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 9.5 } });
      assert.equal((await request(app).put(u).set('Authorization', auth).send({ compteId: b.id, expectedCompteId: a.id, expectedUpdatedAt: tvaAvant.updatedAt.toISOString(), motif: 'Changement du compte TVA' })).status, 200);
      const journalAvant = await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'JOURNAL_VENTES' } });
      for (const motif of [undefined, 'ab', 'invalide\u200b']) {
        const tracesAvant = await prisma.journalRegleComptable.count();
        assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', auth).send({ journal: 'NOUV', ...journalVersion, ...(motif === undefined ? {} : { motif }) })).status, 400);
        assert.equal((await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'JOURNAL_VENTES' } })).journal, 'VTE');
        assert.equal(await prisma.journalRegleComptable.count(), tracesAvant);
      }
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', auth).send({ journal: 'NOUV', expectedValeur: 'VTE', expectedUpdatedAt: journalAvant.updatedAt.toISOString(), motif: 'Changement du journal' })).status, 200);
      const actuel = await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 9.5 } });
      const retrait = { confirmation: '9.5', expectedCompteId: b.id, expectedUpdatedAt: actuel.updatedAt.toISOString() };
      for (const motif of [undefined, 'ab', 'invalide\u200b']) {
        const tracesAvant = await prisma.journalRegleComptable.count();
        assert.equal((await request(app).delete(u).set('Authorization', auth).send({ ...retrait, ...(motif === undefined ? {} : { motif }) })).status, 400);
        assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 9.5 } })).compteId, b.id);
        assert.equal(await prisma.journalRegleComptable.count(), tracesAvant);
      }
      assert.equal((await request(app).delete(u).set('Authorization', auth).send({ ...retrait, motif: 'Retrait du taux TVA' })).status, 204);
      const journal = await request(app).get('/api/comptabilite/regles/journal').set('Authorization', auth);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.deepEqual(journal.body.map(j => [j.type, j.action, j.avant, j.apres, j.motif]), [
        ['TVA', 'CREATION', null, a.id, 'Création du taux initial'],
        ['REGLE', 'CREATION', null, 'VTE', 'Création du journal initial'],
        ['TVA', 'REMAPPAGE', a.id, b.id, 'Changement du compte TVA'],
        ['REGLE', 'REMAPPAGE', 'VTE', 'NOUV', 'Changement du journal'],
        ['TVA', 'RETRAIT', b.id, null, 'Retrait du taux TVA'],
      ]);
      await assert.rejects(prisma.journalRegleComptable.update({ where: { id: journal.body[0].id }, data: { motif: 'Falsifié' } }), /immuable/);
      await assert.rejects(prisma.journalRegleComptable.delete({ where: { id: journal.body[0].id } }), /immuable/);
      await retirerRegleFixture('JOURNAL_VENTES');
    });

    test('#95 : suppression de l’auteur d’une règle journalisée refuse 409 avant la FK', async () => {
      const auteur = await prisma.user.create({ data: { email: 'journal.regle.auteur@iris.test', name: 'TEST Auteur règle', role: 'ADMIN' } });
      const compte = await prisma.compteComptable.create({ data: { code: '706878', libelle: 'Règle auteur', nature: 'PRODUIT' } });
      const token = jwt.sign({ id: auteur.id }, process.env.JWT_SECRET);
      const creation = await request(app).put('/api/comptabilite/regles/VENTE_ARTICLE').set('Authorization', `Bearer ${token}`).send({ compteId: compte.id, motif: 'Création par auteur protégé' });
      assert.equal(creation.status, 200, JSON.stringify(creation.body));
      const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 409, JSON.stringify(suppression.body));
      assert.match(suppression.body.error, /preuve de traçabilité/);
      assert.match(suppression.body.error, /Désactivez-le plutôt/);
      assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
      assert.equal(await prisma.journalRegleComptable.count({ where: { auteurId: auteur.id } }), 1);
      await retirerRegleFixture('VENTE_ARTICLE');
    });

    test('#95 : SQL refuse un remappage sans preuve, et une preuve invalide', async () => {
      const a = await prisma.compteComptable.create({ data: { code: '706895', libelle: 'Ventes source SQL', nature: 'PRODUIT' } });
      const b = await prisma.compteComptable.create({ data: { code: '706896', libelle: 'Ventes cible SQL', nature: 'PRODUIT' } });
      const auth = `Bearer ${session}`;
      await assert.rejects(prisma.regleComptable.create({ data: { cle: 'VENTE_ARTICLE', compteId: a.id } }), /sans journal motivé/);
      await assert.rejects(prisma.regleTvaComptable.create({ data: { taux: 9.5, compteId: a.id } }), /sans journal motivé/);
      assert.equal(await prisma.regleTvaComptable.findUnique({ where: { taux: 9.5 } }), null);
      assert.equal(await prisma.regleComptable.findUnique({ where: { cle: 'VENTE_ARTICLE' } }), null);
      assert.equal((await request(app).put('/api/comptabilite/regles/VENTE_ARTICLE').set('Authorization', auth).send({ motif: "Création de règle de test",  compteId: a.id })).status, 200);
      await assert.rejects(prisma.regleComptable.update({ where: { cle: 'VENTE_ARTICLE' }, data: { compteId: b.id } }), /sans journal motivé/);
      await assert.rejects(prisma.regleComptable.delete({ where: { cle: 'VENTE_ARTICLE' } }), /sans journal motivé/);
      assert.equal((await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'VENTE_ARTICLE' } })).compteId, a.id);
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await assert.rejects(prisma.journalRegleComptable.create({ data: { type: 'REGLE', cible: 'VENTE_ARTICLE', action: 'REMAPPAGE', avant: a.id, apres: b.id, motif: 'ab', auteurId: auteur.id, auteurNom: auteur.name } }), /JournalRegleComptable_motif_check/);
      await assert.rejects(prisma.journalRegleComptable.create({ data: { type: 'TVA', cible: '100.99', action: 'RETRAIT', avant: a.id, motif: 'Taux supérieur à cent', auteurId: auteur.id, auteurNom: auteur.name } }), /JournalRegleComptable_transition_check/);
      await assert.rejects(prisma.journalRegleComptable.create({ data: { type: 'TVA', cible: '9.5', action: 'RETRAIT', avant: a.id, apres: b.id, motif: 'Retrait factice', auteurId: auteur.id, auteurNom: auteur.name } }), /JournalRegleComptable_transition_check/);
      await assert.rejects(prisma.journalRegleComptable.create({ data: { type: 'REGLE', cible: 'VENTE_ARTICLE', action: 'REMAPPAGE', avant: a.id, apres: a.id, motif: 'Transition fictive identique', auteurId: auteur.id, auteurNom: auteur.name } }), /JournalRegleComptable_transition_check/);
      for (const motif of ['Avant\u200baprès', 'Avant\u202eaprès']) {
        await assert.rejects(prisma.journalRegleComptable.create({ data: { type: 'REGLE', cible: 'VENTE_ARTICLE', action: 'REMAPPAGE', avant: a.id, apres: b.id, motif, auteurId: auteur.id, auteurNom: auteur.name } }), /JournalRegleComptable_motif_check/);
      }
      assert.equal(await prisma.journalRegleComptable.count({ where: { cible: 'VENTE_ARTICLE', action: 'CREATION', motif: 'Création de règle de test' } }), 1);
      await retirerRegleFixture('VENTE_ARTICLE');
    });

    test('#95 : chaque transition SQL exige son propre événement, sans insertion fabriquée ni changement d’identité', async () => {
      const auth = `Bearer ${session}`;
      const a = await prisma.compteComptable.create({ data: { code: '706891', libelle: 'Source répétée', nature: 'PRODUIT' } });
      const b = await prisma.compteComptable.create({ data: { code: '706892', libelle: 'Cible répétée', nature: 'PRODUIT' } });
      const creee = await request(app).put('/api/comptabilite/regles/VENTE_ARTICLE').set('Authorization', auth).send({ ...(await versionRegle('VENTE_ARTICLE')), motif: "Création de règle de test", compteId: a.id });
      assert.equal(creee.status, 200, JSON.stringify(creee.body));
      const auteur = await auteurFixture(prisma);
      const event = (avant, apres) => ({ type: 'REGLE', cible: 'VENTE_ARTICLE', action: 'REMAPPAGE', avant, apres, motif: 'Transition SQL répétée', auteurId: auteur.id, auteurNom: auteur.name });
      await assert.rejects(prisma.journalRegleComptable.create({ data: event(a.id, b.id) }), /sans transition|sans journal motivé/);
      assert.equal(await prisma.journalRegleComptable.count({ where: { motif: 'Transition SQL répétée' } }), 0);
      await assert.rejects(prisma.$transaction(async tx => {
        for (const [avant, apres] of [[a.id, b.id], [b.id, a.id], [a.id, b.id]]) {
          await tx.regleComptable.update({ where: { cle: 'VENTE_ARTICLE' }, data: { compteId: apres } });
        }
        assert.equal((await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM "TransitionRegleComptable" WHERE "transactionId" = txid_current()'))[0].n, 3);
        await tx.journalRegleComptable.create({ data: event(a.id, b.id) });
        await tx.journalRegleComptable.create({ data: event(b.id, a.id) });
        const counts = await tx.$queryRawUnsafe('SELECT (SELECT count(*)::int FROM "TransitionRegleComptable" WHERE "transactionId" = txid_current() AND "avant"=$1 AND "apres"=$2) AS transitions, (SELECT count(*)::int FROM "JournalRegleComptable" WHERE "avant"=$1 AND "apres"=$2) AS events', a.id, b.id);
        assert.deepEqual(counts.map(x => [x.transitions, x.events]), [[2, 1]]);
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      }), /sans journal motivé/);
      assert.equal((await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'VENTE_ARTICLE' } })).compteId, a.id);
      assert.equal(await prisma.journalRegleComptable.count({ where: { motif: 'Transition SQL répétée' } }), 0);
      await assert.rejects(prisma.regleComptable.update({ where: { cle: 'VENTE_ARTICLE' }, data: { cle: 'CLIENT' } }), /[Ii]dentité|[Ii]dentite/);
      await assert.rejects(prisma.$executeRaw`UPDATE "TransitionRegleComptable" SET "avant" = ${a.id} WHERE "type" = 'REGLE' AND "cible" = 'VENTE_ARTICLE'`, /Preuve de transition immuable/);
      await assert.rejects(prisma.$executeRaw`DELETE FROM "TransitionRegleComptable" WHERE "type" = 'REGLE' AND "cible" = 'VENTE_ARTICLE'`, /Preuve de transition immuable/);
      const tva = await prisma.compteComptable.create({ data: { code: '445891', libelle: 'TVA identité', nature: 'TVA' } });
      assert.equal((await request(app).put('/api/comptabilite/tva/9.5').set('Authorization', auth).send({ motif: "Création de règle de test",  compteId: tva.id })).status, 200);
      await assert.rejects(prisma.regleTvaComptable.update({ where: { taux: 9.5 }, data: { taux: 9.6 } }), /[Ii]dentité|[Ii]dentite/);
      await retirerTvaFixture(9.5);
      await retirerRegleFixture('VENTE_ARTICLE');
    });

    test('#95 : deux administrateurs ne peuvent pas écraser un remappage périmé', async () => {
      const auth = `Bearer ${session}`;
      const a = await prisma.compteComptable.create({ data: { code: '706883', libelle: 'Avant concurrent', nature: 'PRODUIT' } });
      const b = await prisma.compteComptable.create({ data: { code: '706894', libelle: 'Après concurrent', nature: 'PRODUIT' } });
      const c = await prisma.compteComptable.create({ data: { code: '706882', libelle: 'Périmé concurrent', nature: 'PRODUIT' } });
      const url = '/api/comptabilite/regles/VENTE_ARTICLE';
      const initial = await request(app).put(url).set('Authorization', auth).send({ ...(await versionRegle('VENTE_ARTICLE')), motif: "Création de règle de test", compteId: a.id });
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      const attente = { expectedValeur: a.id, expectedUpdatedAt: initial.body.updatedAt, motif: 'Changement concurrent' };
      const premier = await request(app).put(url).set('Authorization', auth).send({ motif: "Création de règle de test", compteId: b.id, ...attente });
      assert.equal(premier.status, 200, JSON.stringify(premier.body));
      const perime = await request(app).put(url).set('Authorization', auth).send({ motif: "Création de règle de test", compteId: c.id, ...attente });
      assert.equal(perime.status, 409, JSON.stringify(perime.body));
      assert.equal((await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'VENTE_ARTICLE' } })).compteId, b.id);
      assert.equal(await prisma.journalRegleComptable.count({ where: { cible: 'VENTE_ARTICLE', motif: 'Changement concurrent' } }), 1);
      await retirerRegleFixture('VENTE_ARTICLE');
    });

    test('#95 : remappage TVA périmé refuse 409 sans mutation ni trace', async () => {
      const a = await prisma.compteComptable.create({ data: { code: '445881', libelle: 'TVA périmée A', nature: 'TVA' } });
      const b = await prisma.compteComptable.create({ data: { code: '445882', libelle: 'TVA périmée B', nature: 'TVA' } });
      const c = await prisma.compteComptable.create({ data: { code: '445883', libelle: 'TVA périmée C', nature: 'TVA' } });
      const url = '/api/comptabilite/tva/9.5';
      const auth = `Bearer ${session}`;
      const initial = await request(app).put(url).set('Authorization', auth).send({ compteId: a.id, motif: 'Création TVA concurrente' });
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      const attendu = { expectedCompteId: a.id, expectedUpdatedAt: initial.body.updatedAt };
      assert.equal((await request(app).put(url).set('Authorization', auth).send({ compteId: b.id, ...attendu, motif: 'Premier changement TVA' })).status, 200);
      const tracesAvant = await prisma.journalRegleComptable.count({ where: { type: 'TVA', cible: '9.5' } });
      const perime = await request(app).put(url).set('Authorization', auth).send({ compteId: c.id, ...attendu, motif: 'Tentative TVA périmée' });
      assert.equal(perime.status, 409, JSON.stringify(perime.body));
      assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 9.5 } })).compteId, b.id);
      assert.equal(await prisma.journalRegleComptable.count({ where: { type: 'TVA', cible: '9.5' } }), tracesAvant);
      await retirerTvaFixture(9.5);
    });

    test('#95 : retrait standard périmé refuse 409 sans suppression ni trace', async () => {
      const a = await prisma.compteComptable.create({ data: { code: '706881', libelle: 'Règle périmée A', nature: 'PRODUIT' } });
      const b = await prisma.compteComptable.create({ data: { code: '706877', libelle: 'Règle périmée B', nature: 'PRODUIT' } });
      const url = '/api/comptabilite/regles/VENTE_ARTICLE';
      const auth = `Bearer ${session}`;
      const initial = await request(app).put(url).set('Authorization', auth).send({ ...(await versionRegle('VENTE_ARTICLE')), compteId: a.id, motif: 'Création avant retrait' });
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      const attendu = { expectedValeur: a.id, expectedUpdatedAt: initial.body.updatedAt };
      assert.equal((await request(app).put(url).set('Authorization', auth).send({ compteId: b.id, ...attendu, motif: 'Remappage avant retrait' })).status, 200);
      const tracesAvant = await prisma.journalRegleComptable.count({ where: { type: 'REGLE', cible: 'VENTE_ARTICLE' } });
      const perime = await request(app).delete(url).set('Authorization', auth).send({ ...attendu, motif: 'Retrait depuis vue périmée' });
      assert.equal(perime.status, 409, JSON.stringify(perime.body));
      assert.equal((await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'VENTE_ARTICLE' } })).compteId, b.id);
      assert.equal(await prisma.journalRegleComptable.count({ where: { type: 'REGLE', cible: 'VENTE_ARTICLE' } }), tracesAvant);
      await retirerRegleFixture('VENTE_ARTICLE');
    });

    test('#95 : les codes et libellés des comptes restent figés après renommage', async () => {
      const auth = `Bearer ${session}`;
      const a = await prisma.compteComptable.create({ data: { code: '706889', libelle: 'Ancien libellé figé', nature: 'PRODUIT' } });
      const b = await prisma.compteComptable.create({ data: { code: '706890', libelle: 'Nouveau libellé figé', nature: 'PRODUIT' } });
      const url = '/api/comptabilite/regles/VENTE_ARTICLE';
      const initial = await request(app).put(url).set('Authorization', auth).send({ ...(await versionRegle('VENTE_ARTICLE')), motif: "Création de règle de test", compteId: a.id });
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      const change = await request(app).put(url).set('Authorization', auth).send({ compteId: b.id, expectedValeur: a.id, expectedUpdatedAt: initial.body.updatedAt, motif: 'Figement des comptes' });
      assert.equal(change.status, 200, JSON.stringify(change.body));
      const trace = (await request(app).get('/api/comptabilite/regles/journal').set('Authorization', auth)).body.find(j => j.motif === 'Figement des comptes');
      assert.deepEqual([trace.avantCode, trace.avantLibelle, trace.apresCode, trace.apresLibelle], ['706889', 'Ancien libellé figé', '706890', 'Nouveau libellé figé']);
      for (const [compte, libelle] of [[a, 'Renommé depuis'], [b, 'Renommé vers']]) {
        const actuel = await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } });
        const correction = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', auth).send({ libelle, motif: 'Correction de libellé historisé', expectedUpdatedAt: actuel.updatedAt.toISOString() });
        assert.equal(correction.status, 200, JSON.stringify(correction.body));
      }
      const figee = (await request(app).get('/api/comptabilite/regles/journal').set('Authorization', auth)).body.find(j => j.id === trace.id);
      assert.deepEqual([figee.avantCode, figee.avantLibelle, figee.apresCode, figee.apresLibelle], ['706889', 'Ancien libellé figé', '706890', 'Nouveau libellé figé']);
      await retirerRegleFixture('VENTE_ARTICLE');
    });

    test('#95 : retrait motivé d’une règle standard conserve le journal et bloque une émission future', async () => {
      const auth = `Bearer ${session}`;
      const compte = await prisma.compteComptable.create({ data: { code: '706897', libelle: 'Ventes à retirer', nature: 'PRODUIT' } });
      const creee = await request(app).put('/api/comptabilite/regles/VENTE_ARTICLE').set('Authorization', auth).send({ ...(await versionRegle('VENTE_ARTICLE')), motif: "Création de règle de test", compteId: compte.id });
      assert.equal(creee.status, 200, JSON.stringify(creee.body));
      const body = { expectedValeur: compte.id, expectedUpdatedAt: creee.body.updatedAt };
      const u = '/api/comptabilite/regles/VENTE_ARTICLE';
      for (const motif of [undefined, 'ab', 'invalide\u200b']) {
        const tracesAvant = await prisma.journalRegleComptable.count();
        assert.equal((await request(app).delete(u).set('Authorization', auth).send({ ...body, ...(motif === undefined ? {} : { motif }) })).status, 400);
        assert.equal((await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'VENTE_ARTICLE' } })).compteId, compte.id);
        assert.equal(await prisma.journalRegleComptable.count(), tracesAvant);
      }
      assert.equal((await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'VENTE_ARTICLE' } })).compteId, compte.id);
      assert.equal((await request(app).delete(u).set('Authorization', auth).send({ ...body, motif: 'Retrait du mapping des ventes' })).status, 204);
      assert.equal(await prisma.regleComptable.findUnique({ where: { cle: 'VENTE_ARTICLE' } }), null);
      const journal = (await request(app).get('/api/comptabilite/regles/journal').set('Authorization', auth)).body;
      assert.deepEqual(journal.filter(j => j.cible === 'VENTE_ARTICLE' && j.motif === 'Retrait du mapping des ventes').map(j => [j.action, j.avant, j.apres, j.motif]), [['RETRAIT', compte.id, null, 'Retrait du mapping des ventes']]);
    });

    test('#95 : retrait standard attend le verrou comptable global', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '706879', libelle: 'Règle sous verrou', nature: 'PRODUIT' } });
      const url = '/api/comptabilite/regles/VENTE_ARTICLE';
      const auth = `Bearer ${session}`;
      const creee = await request(app).put(url).set('Authorization', auth).send({ ...(await versionRegle('VENTE_ARTICLE')), compteId: compte.id, motif: 'Création sous verrou' });
      assert.equal(creee.status, 200, JSON.stringify(creee.body));
      let liberer, annoncer;
      const verrouPose = new Promise(resolve => { annoncer = resolve; });
      const attente = new Promise(resolve => { liberer = resolve; });
      const transaction = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
        annoncer();
        await attente;
      }, { timeout: 10_000 });
      await verrouPose;
      const retrait = request(app).delete(url).set('Authorization', auth).send({ expectedValeur: compte.id, expectedUpdatedAt: creee.body.updatedAt, motif: 'Retrait après verrou' })
        .timeout({ deadline: 12_000 }).then(r => r, e => ({ status: 0, body: { error: String(e) } }));
      let bloquee = false;
      try {
        for (let i = 0; i < 60; i++) {
          const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(814086)%') AS attente`;
          if (etat.attente) { bloquee = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(await prisma.regleComptable.count({ where: { cle: 'VENTE_ARTICLE' } }), 1);
      } finally { liberer(); await transaction; }
      assert.equal(bloquee, true, 'DELETE doit attendre le verrou partagé avec les émissions');
      assert.equal((await retrait).status, 204);
      assert.equal(await prisma.regleComptable.count({ where: { cle: 'VENTE_ARTICLE' } }), 0);
    });

    test('TVA #92 : supprime seulement le taux ciblé, refuse les taux et corps invalides, protège la route', async () => {
      const auth = `Bearer ${session}`;
      const cible = await prisma.compteComptable.create({ data: { code: '445792', libelle: 'TVA #92', nature: 'TVA' } });
      const autre = await prisma.compteComptable.create({ data: { code: '445793', libelle: 'Autre TVA #92', nature: 'TVA' } });
      for (const [taux, compteId] of [[7.7, cible.id], [10, autre.id]]) {
        const r = await request(app).put(`/api/comptabilite/tva/${taux}`).set('Authorization', auth).send({ motif: "Création de règle de test",  compteId });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      const conducteur = await prisma.user.upsert({ where: { email: 'tva92.conducteur@iris.test' }, create: { email: 'tva92.conducteur@iris.test', name: 'TEST TVA #92', role: 'CONDUCTEUR_TRAVAUX' }, update: {} });
      const nonAdmin = `Bearer ${jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET)}`;
      const url = '/api/comptabilite/tva/7.7';
      const snapshot = (await request(app).get('/api/comptabilite').set('Authorization', auth)).body.reglesTva;
      const attendu = taux => {
        const regle = snapshot.find(r => r.taux === taux);
        return { confirmation: String(taux), expectedCompteId: regle.compteId, expectedUpdatedAt: regle.updatedAt, motif: 'Retrait du taux comptable' };
      };
      assert.equal((await request(app).delete(url)).status, 401);
      assert.equal((await request(app).delete(url).set('Authorization', nonAdmin).send(attendu(7.7))).status, 403);
      const valide = attendu(7.7);
      for (const [chemin, body] of [
        ['/api/comptabilite/tva/invalide', valide],
        [url, {}],
        [url, { ...valide, confirmation: '10' }],
        [url, { ...valide, confirmation: 7.7 }],
        [url, { ...valide, champImprevu: true }],
        ['/api/comptabilite/tva/100.01', { ...valide, confirmation: '100.01' }],
      ]) {
        const refus = await request(app).delete(chemin).set('Authorization', auth).send(body);
        assert.equal(refus.status, 400, `${chemin} ${JSON.stringify(body)} → ${JSON.stringify(refus.body)}`);
        assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 7.7 } }), 1, 'un corps invalide ne retire pas le taux ciblé');
        assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 10 } }), 1, 'un corps invalide ne retire pas les autres taux');
      }
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 7.7 } }), 1);
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 10 } }), 1);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send(attendu(7.7))).status, 204);
      assert.equal(await prisma.regleTvaComptable.findUnique({ where: { taux: 7.7 } }), null);
      assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 10 } })).compteId, autre.id);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: cible.id } })).actif, true);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send(attendu(7.7))).status, 404);
      assert.equal((await request(app).delete('/api/comptabilite/tva/10').set('Authorization', auth).send(attendu(10))).status, 204);
    });

    test('TVA #92 : confirmation décimale française exacte 5,5 retire la règle sans accepter un autre taux', async () => {
      const auth = `Bearer ${session}`;
      const compte = await prisma.compteComptable.create({ data: { code: '445797', libelle: 'TVA virgule #92', nature: 'TVA' } });
      const url = '/api/comptabilite/tva/5.5';
      assert.equal((await request(app).put(url).set('Authorization', auth).send({ motif: "Création de règle de test", compteId: compte.id })).status, 200);
      const regle = (await request(app).get('/api/comptabilite').set('Authorization', auth)).body.reglesTva.find(r => r.taux === 5.5);
      const attendu = { expectedCompteId: regle.compteId, expectedUpdatedAt: regle.updatedAt, motif: 'Retrait du taux français' };
      assert.equal((await request(app).delete(url).set('Authorization', auth).send({ ...attendu, confirmation: '5,6' })).status, 400);
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 5.5 } }), 1);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send({ ...attendu, confirmation: '5,5' })).status, 204);
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 5.5 } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).actif, true);
    });

    test('TVA #92 : retrait périmé après remappage refuse 409 sans effacer le nouveau compte', async () => {
      const auth = `Bearer ${session}`;
      const ancien = await prisma.compteComptable.create({ data: { code: '445795', libelle: 'TVA initiale #92', nature: 'TVA' } });
      const nouveau = await prisma.compteComptable.create({ data: { code: '445796', libelle: 'TVA nouvelle #92', nature: 'TVA' } });
      const url = '/api/comptabilite/tva/8.8';
      assert.equal((await request(app).put(url).set('Authorization', auth).send({ motif: "Création de règle de test", compteId: ancien.id })).status, 200);
      const photographie = (await request(app).get('/api/comptabilite').set('Authorization', auth)).body.reglesTva.find(r => r.taux === 8.8);
      assert.equal(photographie.compteId, ancien.id);
      const versionAvant = await versionTva(8.8);
      assert.equal(versionAvant.expectedCompteId, ancien.id);
      const remappage = await request(app).put(url).set('Authorization', auth).send({ compteId: nouveau.id, ...versionAvant, motif: 'Remappage avant retrait' });
      assert.equal(remappage.status, 200, JSON.stringify(remappage.body));
      const refus = await request(app).delete(url).set('Authorization', auth).send({ confirmation: '8.8', expectedCompteId: photographie.compteId, expectedUpdatedAt: photographie.updatedAt, motif: 'Retrait périmé' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { id: photographie.id } })).compteId, nouveau.id);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send({ confirmation: '8.8', expectedCompteId: nouveau.id, expectedUpdatedAt: photographie.updatedAt, motif: 'Retrait périmé' })).status, 409, 'la version périmée est aussi refusée');
      const actuelle = (await request(app).get('/api/comptabilite').set('Authorization', auth)).body.reglesTva.find(r => r.taux === 8.8);
      const mauvaisCompte = await request(app).delete(url).set('Authorization', auth).send({ confirmation: '8.8', expectedCompteId: ancien.id, expectedUpdatedAt: actuelle.updatedAt, motif: 'Retrait périmé' });
      assert.equal(mauvaisCompte.status, 409, JSON.stringify(mauvaisCompte.body));
      assert.equal((await prisma.regleTvaComptable.findUniqueOrThrow({ where: { id: photographie.id } })).compteId, nouveau.id);
      assert.equal((await request(app).delete(url).set('Authorization', auth).send({ confirmation: '8.8', expectedCompteId: actuelle.compteId, expectedUpdatedAt: actuelle.updatedAt, motif: 'Retrait du mapping' })).status, 204);
    });

    test('TVA #92 : le retrait attend le verrou global comptable puis ne retire que la règle', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '445794', libelle: 'TVA verrou #92', nature: 'TVA' } });
      assert.equal((await request(app).put('/api/comptabilite/tva/6.6').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte.id })).status, 200);
      const snapshot = (await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`)).body.reglesTva.find(r => r.taux === 6.6);
      let liberer;
      let annoncer;
      const pose = new Promise(resolve => { annoncer = resolve; });
      const attente = new Promise(resolve => { liberer = resolve; });
      const transaction = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
        annoncer();
        await attente;
      }, { timeout: 10_000 });
      await pose;
      const retrait = request(app).delete('/api/comptabilite/tva/6.6').set('Authorization', `Bearer ${session}`).send({ confirmation: '6.6', expectedCompteId: snapshot.compteId, expectedUpdatedAt: snapshot.updatedAt, motif: 'Retrait sous verrou' }).then(r => r);
      let bloquee = false;
      try {
        for (let i = 0; i < 60; i++) {
          const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(814086)%') AS attente`;
          if (etat.attente) { bloquee = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 6.6 } }), 1);
      } finally { liberer(); await transaction; }
      assert.equal(bloquee, true, 'le retrait doit attendre le verrou partagé avec les émissions');
      assert.equal((await retrait).status, 204);
      assert.equal(await prisma.regleTvaComptable.count({ where: { taux: 6.6 } }), 0);
    });

    test('chronologie #101 : lecture admin seule, nulle sans numéro et filtrée sur FACTURE numérotée quel que soit le statut', async () => {
      const url = '/api/factures/chronologie';
      const auth = `Bearer ${session}`;
      const conducteur = await prisma.user.create({ data: { email: `test.chronologie.${Date.now()}@iris.test`, name: 'TEST Chronologie', role: 'CONDUCTEUR_TRAVAUX' } });
      const autreToken = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      assert.equal((await request(app).get(url)).status, 401);
      assert.equal((await request(app).get(url).set('Authorization', `Bearer ${autreToken}`)).status, 403);
      const initial = await request(app).get(url).set('Authorization', auth);
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      assert.deepEqual(initial.body, { derniereDateEmission: null });
      const creer = (type, statut, numero, jour, factureOrigineId = null) => prisma.$transaction(async tx => {
        const piece = await tx.facture.create({ data: {
          clientId, clientRaisonSociale: 'TEST Client contrat maintenance', type, statut, numero, factureOrigineId,
          dateEmission: new Date(`${jour}T00:00:00.000Z`), dateEcheance: new Date(`${jour}T00:00:00.000Z`),
          totalHt: 10, totalTva: 2, totalTtc: 12, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST chronologie',
          ecrituresScellees: false,
        } });
        if (statut !== 'BROUILLON') await tx.ecritureFacture.createMany({ data: [
          { factureId: piece.id, ordre: 0, cle: 'CLIENT', journalCode: 'VE', compteNum: '411000', compteLib: 'Clients', debit: type === 'AVOIR' ? 0 : 12, credit: type === 'AVOIR' ? 12 : 0 },
          { factureId: piece.id, ordre: 1, cle: 'VENTE_PRESTATION', journalCode: 'VE', compteNum: '706000', compteLib: 'Ventes', debit: type === 'AVOIR' ? 10 : 0, credit: type === 'AVOIR' ? 0 : 10 },
          { factureId: piece.id, ordre: 2, cle: 'TVA', journalCode: 'VE', compteNum: '445710', compteLib: 'TVA', debit: type === 'AVOIR' ? 2 : 0, credit: type === 'AVOIR' ? 0 : 2 },
        ] });
        if (statut !== 'BROUILLON') await tx.facture.update({ where: { id: piece.id }, data: { ecrituresScellees: true } });
        return piece;
      });
      const ids = [];
      try {
        ids.push((await creer('FACTURE', 'BROUILLON', null, '2026-09-30')).id);
        ids.push((await creer('AVOIR', 'EMISE', 'TEST-A-101', '2026-09-29', ids[0])).id);
        assert.deepEqual((await request(app).get(url).set('Authorization', auth)).body, { derniereDateEmission: null });
        ids.push((await creer('FACTURE', 'EMISE', 'TEST-F-101', '2026-09-27')).id);
        assert.deepEqual((await request(app).get(url).set('Authorization', auth)).body, { derniereDateEmission: '2026-09-27T00:00:00.000Z' });
        ids.push((await creer('FACTURE', 'ANNULEE', 'TEST-F-102', '2026-09-28')).id);
        assert.deepEqual((await request(app).get(url).set('Authorization', auth)).body, { derniereDateEmission: '2026-09-28T00:00:00.000Z' });
        // Une facture ne naît jamais « réglée » (gardes des règlements, immédiate et différée) : ce
        // test de chronologie fabrique la pièce brute en suspendant ces seuls gardes, le temps de
        // l'insertion.
        await prisma.$executeRawUnsafe('ALTER TABLE "Facture" DISABLE TRIGGER "facture_statut_reglements"');
        await prisma.$executeRawUnsafe('ALTER TABLE "Facture" DISABLE TRIGGER "facture_statut_reglement_differe"');
        try {
          ids.push((await creer('FACTURE', 'REGLEE', 'TEST-F-103', '2026-09-29')).id);
        } finally {
          await prisma.$executeRawUnsafe('ALTER TABLE "Facture" ENABLE TRIGGER "facture_statut_reglement_differe"');
          await prisma.$executeRawUnsafe('ALTER TABLE "Facture" ENABLE TRIGGER "facture_statut_reglements"');
        }
        assert.deepEqual((await request(app).get(url).set('Authorization', auth)).body, { derniereDateEmission: '2026-09-29T00:00:00.000Z' });
      } finally {
        for (const id of ids.slice(1)) await purgerEcrituresJetables(id);
        await prisma.facture.deleteMany({ where: { id: { in: ids.slice(1) } } });
        await prisma.facture.deleteMany({ where: { id: ids[0] } });
      }
    });

    test('refuse une facture sans origine métier déclarée', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST origine absente', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 400, JSON.stringify(facture.body));
    });

    test('ne divulgue pas un contrat rattaché à un autre client', async () => {
      const autreClient = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client origine étrangère' });
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({ clientId: autreClient.body.id, titre: 'TEST Contrat étranger', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '08-09-2026' });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CONTRAT', contratMaintenanceId: contrat.body.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST origine étrangère', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 404, JSON.stringify(facture.body));
    });

    test('refuse de facturer une affaire annulée', async () => {
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Affaire annulée', client: 'TEST Client', clientId, dateDebut: new Date('2026-09-01T00:00:00.000Z'), statut: 'ANNULE', budgetGlobalVendu: 100 } });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST affaire annulée', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 409, JSON.stringify(facture.body));
    });

    test('#106 : une facture issue d’une intervention verrouille le client de l’affaire et préserve sa trace', async () => {
      const auth = `Bearer ${session}`;
      const autreClient = await prisma.client.create({ data: { raisonSociale: 'TEST destination #106' } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST affaire #106', client: 'TEST Client', clientId, dateDebut: new Date('2026-09-01'), budgetGlobalVendu: 100 } });
      const intervention = await prisma.intervention.create({ data: { reference: `TEST-106-${Date.now()}`, titre: 'TEST intervention facturée', clientId, chantierId: chantier.id } });
      const facture = await request(app).post('/api/factures').set('Authorization', auth).send({ clientId, origine: 'INTERVENTION', interventionId: intervention.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST intervention #106', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.equal(facture.body.chantierId, null, 'La facture ne doit pas être directement liée à l’affaire.');
      const traceUrl = `/api/factures/${facture.body.id}/tracabilite`;
      const avant = await request(app).get(traceUrl).set('Authorization', auth);
      assert.equal(avant.status, 200, JSON.stringify(avant.body));
      assert.equal(avant.body.facture.chantier.id, chantier.id);
      assert.equal((await request(app).patch(`/api/chantiers/${chantier.id}`).set('Authorization', auth).send({ clientId: 'client-inexistant' })).status, 404);
      const refus = await request(app).patch(`/api/chantiers/${chantier.id}`).set('Authorization', auth).send({ clientId: autreClient.id, nom: 'Modification refusée' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /déjà facturée/);
      // Le refus ne réécrit pas non plus le libellé client.
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).client, 'TEST Client');
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).clientId, clientId);
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).nom, chantier.nom);
      const apres = await request(app).get(traceUrl).set('Authorization', auth);
      assert.equal(apres.status, 200, JSON.stringify(apres.body));
      assert.deepEqual(apres.body, avant.body, 'La trace et les rattachements ne changent pas après le refus.');
    });

    test('#105 : trace la chaîne devis → affaire → interventions selon l’origine de facture, sans fuite entre affaires ni clients', async () => {
      const autreClient = await prisma.client.create({ data: { raisonSociale: 'TEST trace autre client' } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Affaire traçable', numeroDevis: 'TEST-D-105-AFFAIRE', client: 'TEST Client', clientId, dateDebut: new Date('2026-09-01'), budgetGlobalVendu: 100 } });
      const autreChantier = await prisma.chantier.create({ data: { nom: 'TEST autre affaire', client: 'TEST Client', clientId, dateDebut: new Date('2026-09-01'), budgetGlobalVendu: 100 } });
      const devis = await prisma.devis.create({ data: { dossierId: `TEST-105-${Date.now()}`, numero: chantier.numeroDevis, version: 1, clientId, objet: 'TEST devis origine', totalHt: 100, totalTva: 20, totalTtc: 120 } });
      await prisma.devisConversion.create({ data: { devisId: devis.id, dossierId: devis.dossierId, cibleType: 'CHANTIER', cibleId: chantier.id } });
      const interventionZ = await prisma.intervention.create({ data: { reference: `TEST-105-Z-${Date.now()}`, titre: 'TEST Z liée', clientId, chantierId: chantier.id } });
      const interventionA = await prisma.intervention.create({ data: { reference: `TEST-105-A-${Date.now()}`, titre: 'TEST A liée', clientId, chantierId: chantier.id } });
      const interventions = [interventionZ, interventionA];
      const etrangere = await prisma.intervention.create({ data: { reference: `TEST-105-X-${Date.now()}`, titre: 'TEST autre affaire', clientId, chantierId: autreChantier.id } });
      const autreClientIntervention = await prisma.intervention.create({ data: { reference: `TEST-105-Y-${Date.now()}`, titre: 'TEST autre client', clientId: autreClient.id, chantierId: chantier.id } });
      const creer = async (origine, rattachement) => {
        const response = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine, ...rattachement, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST trace', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        return response.body.id;
      };
      for (const [origine, rattachement] of [['CHANTIER', { chantierId: chantier.id }], ['INTERVENTION', { interventionId: interventions[0].id }]]) {
        const id = await creer(origine, rattachement);
        const url = `/api/factures/${id}/tracabilite`;
        assert.equal((await request(app).get(url)).status, 401);
        const nonAdmin = await prisma.user.upsert({ where: { email: 'trace105.conducteur@iris.test' }, create: { email: 'trace105.conducteur@iris.test', name: 'TEST trace', role: 'CONDUCTEUR_TRAVAUX' }, update: {} });
        assert.equal((await request(app).get(url).set('Authorization', `Bearer ${jwt.sign({ id: nonAdmin.id }, process.env.JWT_SECRET)}`)).status, 403);
        const trace = await request(app).get(url).set('Authorization', `Bearer ${session}`);
        assert.equal(trace.status, 200, JSON.stringify(trace.body));
        assert.equal(trace.body.facture.client.id, clientId);
        assert.equal(trace.body.facture.chantierId || trace.body.facture.intervention.chantierId, chantier.id);
        assert.deepEqual(trace.body.facture.chantier, { id: chantier.id, nom: chantier.nom, numeroDevis: chantier.numeroDevis, statut: chantier.statut });
        assert.equal(trace.body.devis.id, devis.id);
        assert.equal(trace.body.devis.numero, trace.body.facture.chantier.numeroDevis);
        assert.deepEqual(trace.body.interventionsLiees.map(item => item.id), [interventions[1].id, interventions[0].id]);
        assert.ok(trace.body.interventionsLiees.every(item => item.clientId === clientId));
        assert.ok(!trace.body.interventionsLiees.some(item => [etrangere.id, autreClientIntervention.id].includes(item.id)));
      }
      const factureIncoherente = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: autreClient.id, origine: 'INTERVENTION', interventionId: autreClientIntervention.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST trace incohérente', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(factureIncoherente.status, 201, JSON.stringify(factureIncoherente.body));
      const traceIncoherente = await request(app).get(`/api/factures/${factureIncoherente.body.id}/tracabilite`).set('Authorization', `Bearer ${session}`);
      assert.equal(traceIncoherente.status, 200, JSON.stringify(traceIncoherente.body));
      assert.equal(traceIncoherente.body.facture.chantier, null, 'Une affaire d’un autre client ne doit pas être proposée.');
      assert.equal(traceIncoherente.body.devis, null);
      assert.deepEqual(traceIncoherente.body.interventionsLiees, []);
    });

    test('#105 : une conversion étrangère ne fournit pas de devis à une affaire valide', async () => {
      const autreClient = await prisma.client.create({ data: { raisonSociale: 'TEST devis étranger #105' } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST affaire sans devis client', client: 'TEST Client', clientId, dateDebut: new Date('2026-09-01'), budgetGlobalVendu: 100 } });
      const devis = await prisma.devis.create({ data: { dossierId: `TEST-105-foreign-${Date.now()}`, numero: 'TEST-D-105-ETRANGER', version: 1, clientId: autreClient.id, objet: 'TEST devis étranger', totalHt: 100, totalTva: 20, totalTtc: 120 } });
      await prisma.devisConversion.create({ data: { devisId: devis.id, dossierId: devis.dossierId, cibleType: 'CHANTIER', cibleId: chantier.id } });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST étranger', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      const trace = await request(app).get(`/api/factures/${facture.body.id}/tracabilite`).set('Authorization', `Bearer ${session}`);
      assert.equal(trace.status, 200, JSON.stringify(trace.body));
      assert.equal(trace.body.facture.chantier.id, chantier.id);
      assert.equal(trace.body.devis, null);
    });

    test('#105 : plusieurs conversions du même client vers une affaire sont ambiguës, sans devis arbitraire', async () => {
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST affaire ambiguë', client: 'TEST Client', clientId, dateDebut: new Date('2026-09-01'), budgetGlobalVendu: 100 } });
      for (const suffixe of ['A', 'B']) {
        const devis = await prisma.devis.create({ data: { dossierId: `TEST-105-duplicate-${suffixe}-${Date.now()}`, numero: `TEST-D-105-${suffixe}`, version: 1, clientId, objet: `TEST doublon ${suffixe}`, totalHt: 100, totalTva: 20, totalTtc: 120 } });
        await prisma.devisConversion.create({ data: { devisId: devis.id, dossierId: devis.dossierId, cibleType: 'CHANTIER', cibleId: chantier.id } });
      }
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST ambigu', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      const trace = await request(app).get(`/api/factures/${facture.body.id}/tracabilite`).set('Authorization', `Bearer ${session}`);
      assert.equal(trace.status, 200, JSON.stringify(trace.body));
      assert.equal(trace.body.facture.chantier.id, chantier.id);
      assert.equal(trace.body.devis, null);
      assert.equal(trace.body.devisAmbigu, true);
    });

    test('#105 : un contrat seul ne fabrique ni affaire ni interventions liées', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({ clientId, titre: 'TEST contrat seul #105', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '08-09-2026' });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CONTRAT', contratMaintenanceId: contrat.body.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST contrat #105', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      const trace = await request(app).get(`/api/factures/${facture.body.id}/tracabilite`).set('Authorization', `Bearer ${session}`);
      assert.equal(trace.status, 200, JSON.stringify(trace.body));
      assert.equal(trace.body.facture.contratMaintenance.id, contrat.body.id);
      assert.equal(trace.body.facture.chantier, null);
      assert.equal(trace.body.devis, null);
      assert.deepEqual(trace.body.interventionsLiees, []);
    });

    test('expose la traçabilité d’une facture hors affaire motivée', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Refacturation de frais', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST frais', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      const trace = await request(app).get(`/api/factures/${facture.body.id}/tracabilite`).set('Authorization', `Bearer ${session}`);
      assert.equal(trace.status, 200, JSON.stringify(trace.body));
      assert.equal(trace.body.facture.origine, 'HORS_AFFAIRE');
      assert.equal(trace.body.facture.motifHorsAffaire, 'Refacturation de frais');
      assert.equal(trace.body.devis, null);
      assert.deepEqual(trace.body.interventionsLiees, []);
      assert.equal(trace.body.facture.chantier, null);
      assert.equal(trace.body.facture.intervention, null);
    });

    test('crée une facture brouillon avec des lignes fiscales figées', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST Maintenance', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 }],
      });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.equal(facture.body.statut, 'BROUILLON');
      assert.equal(facture.body.numero, null, 'La numérotation légale est attribuée à l’émission, pas au brouillon.');
      assert.equal(facture.body.totalHt, 200);
      assert.equal(facture.body.totalTva, 40);
      assert.equal(facture.body.totalTtc, 240);
    });

    test('crée une facture à deux lignes, dont un article', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Facturation mixte', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [
          { designation: 'TEST Pose', nature: 'PRESTATION', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 },
          { designation: 'TEST Détecteur', nature: 'ARTICLE', quantite: 3, prixUnitaireHt: 50, tauxTva: 10 },
        ],
      });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.equal(facture.body.lignes.length, 2);
      assert.deepEqual(facture.body.lignes.map((ligne) => ({ designation: ligne.designation, nature: ligne.nature, ordre: ligne.ordre })), [
        { designation: 'TEST Pose', nature: 'PRESTATION', ordre: 0 },
        { designation: 'TEST Détecteur', nature: 'ARTICLE', ordre: 1 },
      ]);
      assert.equal(facture.body.totalHt, 350);
      assert.equal(facture.body.totalTva, 55);
      assert.equal(facture.body.totalTtc, 405);
    });

    test('expose à l’administration les prérequis pour facturer', async () => {
      const reponse = await request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.pret, false);
      const plan = reponse.body.controles.find((controle) => controle.cle === 'PLAN_COMPTABLE');
      assert.equal(plan.bloquant, true); assert.equal(plan.route, '/comptabilite');
      const mentions = reponse.body.controles.find((controle) => controle.cle === 'MENTIONS_LEGALES');
      assert.equal(mentions.route, '/mentions-legales');
      const prefixe = reponse.body.controles.find((controle) => controle.cle === 'PREFIXE_FACTURE');
      assert.equal(prefixe.bloquant, false); assert.equal(prefixe.route, null);
      const tva = reponse.body.controles.find((controle) => controle.cle === 'TVA');
      assert.equal(tva.pret, false);
      assert.equal(typeof tva.bloquant, 'boolean', 'La portée TVA dépend des brouillons créés par les tests précédents.');
      assert.match(tva.detail, /0 %/);
      assert.ok(reponse.body.controles.some((controle) => controle.cle === 'ADRESSES_CLIENTS' && controle.bloquant === false));
    });

    test('paramètre un compte comptable sans imposer de plan préchargé', async () => {
      const compte = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '706100', libelle: 'Prestations techniques', nature: 'PRODUIT' });
      assert.equal(compte.status, 201, JSON.stringify(compte.body));
      assert.equal(compte.body.code, '706100');
      const regle = await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte.body.id });
      assert.equal(regle.status, 200, JSON.stringify(regle.body));
      assert.equal(regle.body.compteId, compte.body.id);
    });

    test('désactive et réactive un compte libre sans modifier son identité', async () => {
      const code = `898${String(Date.now()).slice(-9)}`;
      const creation = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code, libelle: 'Compte temporaire', nature: 'CHARGE' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const url = `/api/comptabilite/comptes/${creation.body.id}/activation`;
      const desactivation = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' });
      assert.equal(desactivation.status, 200, JSON.stringify(desactivation.body));
      assert.equal(desactivation.body.actif, false);
      assert.equal(desactivation.body.code, code);
      assert.equal(desactivation.body.libelle, 'Compte temporaire');
      assert.equal((await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`)).body.comptes.find(c => c.id === creation.body.id)?.actif, false);
      assert.equal((await request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: creation.body.id })).status, 404);
      const reactivation = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: true, motif: 'Retour en service' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      assert.equal(reactivation.body.actif, true);
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: creation.body.id } })).code, code);
    });

    test('refuse de désactiver un compte utilisé par une règle standard jusqu’à son remappage', async () => {
      const premier = await prisma.compteComptable.create({ data: { code: `897${String(Date.now()).slice(-9)}`, libelle: 'Prestations liées', nature: 'PRODUIT' } });
      const second = await prisma.compteComptable.create({ data: { code: `896${String(Date.now()).slice(-9)}`, libelle: 'Prestations remplacement', nature: 'PRODUIT' } });
      const url = `/api/comptabilite/comptes/${premier.id}/activation`;
      assert.equal((await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ ...(await versionRegle('VENTE_PRESTATION')),  motif: 'Révision de règle comptable testée', compteId: premier.id })).status, 200);
      const conflit = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' });
      assert.equal(conflit.status, 409, JSON.stringify(conflit.body));
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: premier.id } })).actif, true);
      assert.equal((await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ ...(await versionRegle('VENTE_PRESTATION')),  motif: 'Révision de règle comptable testée', compteId: second.id })).status, 200);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' })).status, 200);
    });

    test('refuse de désactiver un compte TVA utilisé jusqu’à son remappage', async () => {
      const premier = await prisma.compteComptable.create({ data: { code: `895${String(Date.now()).slice(-9)}`, libelle: 'TVA liée', nature: 'TVA' } });
      const second = await prisma.compteComptable.create({ data: { code: `894${String(Date.now()).slice(-9)}`, libelle: 'TVA remplacement', nature: 'TVA' } });
      const url = `/api/comptabilite/comptes/${premier.id}/activation`;
      assert.equal((await request(app).put('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ ...(await versionTva(5.5)),  motif: 'Révision de règle comptable testée', compteId: premier.id })).status, 200);
      const conflit = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' });
      assert.equal(conflit.status, 409, JSON.stringify(conflit.body));
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: premier.id } })).actif, true);
      assert.equal((await request(app).put('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ ...(await versionTva(5.5)),  motif: 'Révision de règle comptable testée', compteId: second.id })).status, 200);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' })).status, 200);
    });

    test('une règle attend le verrou du compte puis refuse un compte désactivé entre-temps', async () => {
      for (const { nature, chemin, lire } of [
        { nature: 'PRODUIT', chemin: '/api/comptabilite/regles/VENTE_ARTICLE', lire: () => prisma.regleComptable.findUnique({ where: { cle: 'VENTE_ARTICLE' } }) },
        { nature: 'TVA', chemin: '/api/comptabilite/tva/7.7', lire: () => prisma.regleTvaComptable.findUnique({ where: { taux: 7.7 } }) },
      ]) {
        const compte = await prisma.compteComptable.create({ data: { code: `${nature === 'TVA' ? '890' : '891'}${String(Date.now()).slice(-9)}`, libelle: 'Course activation', nature } });
        const source = await prisma.compteComptable.create({ data: { code: `${nature === 'TVA' ? '888' : '889'}${String(Date.now()).slice(-9)}`, libelle: 'Source du remappage', nature } });
        if (nature === 'TVA') await tvaFixture(7.7, source.id);
        else await regleFixture('VENTE_ARTICLE', source.id);
        let liberer;
        let annoncer;
        const verrouPose = new Promise(resolve => { annoncer = resolve; });
        const libere = new Promise(resolve => { liberer = resolve; });
        const transaction = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "CompteComptable" WHERE "id" = ${compte.id} FOR UPDATE`;
          annoncer();
          await libere;
          await tx.compteComptable.update({ where: { id: compte.id }, data: { actif: false } });
        }, { timeout: 10_000 });
        await verrouPose;
        const requete = request(app).put(chemin).set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test", compteId: compte.id });
        // Le serveur doit réellement attendre le verrou SQL, pas simplement être lent à démarrer.
        const reponsePromise = requete.then(reponse => reponse);
        let attenteObservee = false;
        try {
          for (let tentative = 0; tentative < 60; tentative++) {
            const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%CompteComptable%' AND query LIKE '%FOR UPDATE%') AS attente`;
            if (etat.attente) { attenteObservee = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } finally { liberer(); await transaction; }
        const reponse = await reponsePromise;
        assert.equal(attenteObservee, true, `${chemin} doit attendre le verrou du compte`);
        assert.equal(reponse.status, 404, JSON.stringify(reponse.body));
        assert.equal((await lire())?.compteId, source.id, 'le remappage refusé conserve le compte source actif');
        assert.equal((await prisma.compteComptable.findUnique({ where: { id: source.id } })).actif, true);
      }
    });

    test('la désactivation attend le remappage vers son compte et refuse sans journal', async () => {
      for (const { nature, cle, taux, prefixe } of [
        { nature: 'PRODUIT', cle: 'VENTE_ARTICLE', prefixe: '885' },
        { nature: 'TVA', taux: 7.7, prefixe: '884' },
      ]) {
        const cible = await prisma.compteComptable.create({ data: { code: `${prefixe}${String(Date.now()).slice(-9)}`, libelle: 'Cible course symétrique', nature } });
        let liberer;
        let annoncer;
        const verrouPose = new Promise(resolve => { annoncer = resolve; });
        const libere = new Promise(resolve => { liberer = resolve; });
        const remappage = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "CompteComptable" WHERE "id" = ${cible.id} FOR UPDATE`;
          if (cle) await regleFixture(cle, cible.id, tx);
          else await tvaFixture(taux, cible.id, tx);
          annoncer();
          await libere;
        }, { timeout: 10_000 });
        await verrouPose;
        const reponsePromise = request(app).patch(`/api/comptabilite/comptes/${cible.id}/activation`)
          .set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Remappage concurrent' })
          .timeout({ deadline: 12_000 }).then(r => r, e => ({ status: 0, body: { error: String(e) } }));
        let attenteObservee = false;
        try {
          for (let tentative = 0; tentative < 60; tentative++) {
            const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%CompteComptable%' AND query LIKE '%FOR UPDATE%') AS attente`;
            if (etat.attente) { attenteObservee = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } finally { liberer(); await remappage; }
        const reponse = await reponsePromise;
        assert.equal(attenteObservee, true, `${nature} : désactivation bloquée par le verrou du compte cible`);
        assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
        assert.equal((await prisma.compteComptable.findUnique({ where: { id: cible.id } })).actif, true);
        const regle = cle ? await prisma.regleComptable.findUnique({ where: { cle } }) : await prisma.regleTvaComptable.findUnique({ where: { taux } });
        assert.equal(regle.compteId, cible.id);
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: cible.id } }), 0);
      }
    });

    test('valide strictement la transition de compte et protège la route', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `893${String(Date.now()).slice(-9)}`, libelle: 'Compte protégé', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}/activation`;
      assert.equal((await request(app).patch(url).send({ actif: false, motif: 'Compte devenu inutile' })).status, 401);
      const conducteur = await prisma.user.create({ data: { email: 'comptabilite.conducteur@iris.test', name: 'TEST Conducteur comptabilité', role: 'CONDUCTEUR_TRAVAUX' } });
      const nonAdmin = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${nonAdmin}`).send({ actif: false, motif: 'Compte devenu inutile' })).status, 403);
      for (const body of [{}, { actif: 'false' }, { actif: null }, { actif: false, libelle: 'Injection' }, { actif: false }, { actif: false, motif: '  ' }, { actif: false, motif: 'ab' }, { actif: false, motif: 'Motif\ninvalide' }, { actif: false, motif: 'Motif\tinvalide' }, { actif: false, motif: 'Motif\u0000invalide' }, { actif: false, motif: 'x'.repeat(501) }, { actif: false, motif: 42 }, { actif: false, motif: 'Valide', code: '999' }]) {
        assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${session}`).send(body)).status, 400);
      }
      assert.equal((await request(app).patch('/api/comptabilite/comptes/inexistant/activation').set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'Compte devenu inutile' })).status, 404);
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: compte.id } })).actif, true);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      assert.equal((await request(app).get(`/api/comptabilite/comptes/${compte.id}/journal`)).status, 401);
      assert.equal((await request(app).get(`/api/comptabilite/comptes/${compte.id}/journal`).set('Authorization', `Bearer ${nonAdmin}`)).status, 403);
      assert.equal((await request(app).get('/api/comptabilite/comptes/inexistant/journal').set('Authorization', `Bearer ${session}`)).status, 404);
    });

    test('modifie un compte avec motif et instantanés auditables sans changer son code', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `878${String(Date.now()).slice(-9)}`, libelle: 'Avant', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const reponse = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Après', nature: 'ACTIF', motif: 'Correction de classification', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.deepEqual([reponse.body.code, reponse.body.libelle, reponse.body.nature], [compte.code, 'Après', 'ACTIF']);
      const journal = await request(app).get(`${url}/journal`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200);
      assert.equal(journal.body.length, 1);
      assert.deepEqual([journal.body[0].action, journal.body[0].avantLibelle, journal.body[0].apresLibelle, journal.body[0].avantNature, journal.body[0].apresNature, journal.body[0].motif], ['MODIFICATION', 'Avant', 'Après', 'CHARGE', 'ACTIF', 'Correction de classification']);
      assert.equal(journal.body[0].auteurId, (await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } })).id);
    });

    test('un ADMIN modifie un compte inactif sans le réactiver et signe son journal', async () => {
      const admin = await prisma.user.create({ data: { email: 'comptabilite.modification.admin@iris.test', name: 'TEST Admin modification', role: 'ADMIN' } });
      const compte = await prisma.compteComptable.create({ data: { code: `869${String(Date.now()).slice(-9)}`, libelle: 'Libellé inactif', nature: 'CHARGE', actif: false } });
      const token = jwt.sign({ id: admin.id }, process.env.JWT_SECRET);
      const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${token}`).send({ libelle: 'Libellé rectifié', motif: 'Correction historique', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.actif, false);
      const [trace] = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id } });
      assert.deepEqual([trace.auteurId, trace.auteurNom, trace.avantNature, trace.apresNature], [admin.id, admin.name, 'CHARGE', 'CHARGE']);
    });

    test('une version périmée ou absente ne modifie rien et ne journalise rien', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `868${String(Date.now()).slice(-9)}`, libelle: 'Initial', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const premier = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Premier', motif: 'Premier éditeur', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(premier.status, 200, JSON.stringify(premier.body));
      for (const body of [
        { libelle: 'Écrasement', nature: 'ACTIF', motif: 'Éditeur périmé', expectedUpdatedAt: compte.updatedAt.toISOString() },
        { libelle: 'Écrasement', motif: 'Version manquante' },
      ]) {
        const reponse = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send(body);
        assert.equal(reponse.status, body.expectedUpdatedAt ? 409 : 400, JSON.stringify(reponse.body));
      }
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Premier');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 1);
    });

    test('refuse les rôles non admin, les champs étrangers et les motifs invalides sans trace', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `877${String(Date.now()).slice(-9)}`, libelle: 'Initial', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const valide = { libelle: 'Révisé', nature: 'PRODUIT', motif: 'Correction motivée', expectedUpdatedAt: compte.updatedAt.toISOString() };
      assert.equal((await request(app).patch(url).send(valide)).status, 401);
      const conducteur = await prisma.user.create({ data: { email: 'comptabilite.modification.conducteur@iris.test', name: 'TEST Conducteur modification', role: 'CONDUCTEUR_TRAVAUX' } });
      const nonAdmin = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${nonAdmin}`).send(valide)).status, 403);
      for (const body of [{ ...valide, code: '999' }, { ...valide, libelle: '   ' }, { ...valide, libelle: 'Ligne\nbrisée' }, { ...valide, libelle: 'Compte\u0085invalide' }, { ...valide, libelle: 42 }, { ...valide, nature: 'INCONNU' }, { ...valide, motif: 'ab' }, { ...valide, motif: 'x'.repeat(501) }, { ...valide, motif: 'Motif\tinterdit' }, { ...valide, motif: 'Motif\u007finterdit' }, { ...valide, motif: 'Motif\u0085interdit' }, { ...valide, motif: '\u200B'.repeat(3) }, { ...valide, motif: 'Motif \u202E inversé' }, { ...valide, libelle: 'Compte \u202E inversé' }]) {
        const r = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send(body);
        assert.equal(r.status, 400, JSON.stringify({ body, reponse: r.body }));
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      }
      assert.equal((await request(app).patch('/api/comptabilite/comptes/inexistant').set('Authorization', `Bearer ${session}`).send(valide)).status, 404);
      assert.deepEqual([(await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, await prisma.journalCompteComptable.count({ where: { compteId: compte.id } })], ['Initial', 0]);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Initial', motif: 'Sans changement', expectedUpdatedAt: compte.updatedAt.toISOString() })).status, 400);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('création et import refusent le libellé bidi sans aucun compte créé', async () => {
      const code = `864${String(Date.now()).slice(-9)}`;
      const autreCode = `863${String(Date.now()).slice(-9)}`;
      const libelle = 'Compte \u202E inversé';
      const creation = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code, libelle, nature: 'CHARGE' });
      assert.equal(creation.status, 400, JSON.stringify(creation.body));
      const importation = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [{ code, libelle: 'Compte autorisé', nature: 'CHARGE' }, { code: autreCode, libelle, nature: 'CHARGE' }] });
      assert.equal(importation.status, 400, JSON.stringify(importation.body));
      assert.deepEqual(importation.body.erreurs.map(e => e.ligne), [2]);
      assert.equal(await prisma.compteComptable.count({ where: { code: { in: [code, autreCode] } } }), 0);
    });

    test('activation et modification refusent le même motif invisible sans journal', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `862${String(Date.now()).slice(-9)}`, libelle: 'Compte sans trace', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      for (const motif of ['\u200B'.repeat(3), 'Motif \u202E inversé']) {
        const modification = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Tentative', motif, expectedUpdatedAt: compte.updatedAt.toISOString() });
        const activation = await request(app).patch(`${url}/activation`).set('Authorization', `Bearer ${session}`).send({ actif: false, motif });
        assert.equal(modification.status, 400, JSON.stringify(modification.body));
        assert.equal(activation.status, 400, JSON.stringify(activation.body));
      }
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, compte.libelle);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('les deux actions acceptent 500 emoji comptés en points de code', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `865${String(Date.now()).slice(-9)}`, libelle: 'Compte emoji', nature: 'CHARGE' } });
      const motif = '🔧'.repeat(500);
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const modification = await request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Compte corrigé', motif, expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(modification.status, 200, JSON.stringify(modification.body));
      const activation = await request(app).patch(`${url}/activation`).set('Authorization', `Bearer ${session}`).send({ actif: false, motif });
      assert.equal(activation.status, 200, JSON.stringify(activation.body));
      assert.deepEqual((await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id }, orderBy: { createdAt: 'asc' } })).map(j => j.motif), [motif, motif]);
    });

    test('corrige un libellé hérité C1 en conservant son instantané avant sans 500', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `861${String(Date.now()).slice(-9)}`, libelle: 'Ancien\u0085libellé', nature: 'CHARGE' } });
      const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Libellé corrigé', motif: 'Correction historique', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      const [trace] = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id } });
      assert.deepEqual([trace.avantLibelle, trace.apresLibelle], ['Ancien\u0085libellé', 'Libellé corrigé']);
    });

    test('refuse une nature incompatible avec une règle client, vente ou TVA sans effet', async () => {
      const client = await prisma.compteComptable.create({ data: { code: `876${String(Date.now()).slice(-9)}`, libelle: 'Clients liés', nature: 'ACTIF' } });
      const vente = await prisma.compteComptable.create({ data: { code: `875${String(Date.now()).slice(-9)}`, libelle: 'Ventes liées', nature: 'PRODUIT' } });
      const tva = await prisma.compteComptable.create({ data: { code: `874${String(Date.now()).slice(-9)}`, libelle: 'TVA liée', nature: 'TVA' } });
      for (const [cle, compteId] of [['CLIENT', client.id], ['VENTE_PRESTATION', vente.id], ['VENTE_ARTICLE', vente.id]]) {
        assert.equal((await request(app).put(`/api/comptabilite/regles/${cle}`).set('Authorization', `Bearer ${session}`).send({ ...await versionRegle(cle), motif: 'Révision de règle comptable testée', compteId })).status, 200);
      }
      assert.equal((await request(app).put('/api/comptabilite/tva/17').set('Authorization', `Bearer ${session}`).send({ ...(await versionTva(17)),  motif: 'Révision de règle comptable testée', compteId: tva.id })).status, 200);
      for (const compte of [client, vente, tva]) {
        const r = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Tentative', nature: 'CHARGE', motif: 'Changement de nature', expectedUpdatedAt: compte.updatedAt.toISOString() });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, compte.libelle);
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      }
    });

    test('les contraintes SQL protègent code et journal de modification', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `873${String(Date.now()).slice(-9)}`, libelle: 'Origine SQL', nature: 'CHARGE' } });
      await assert.rejects(prisma.compteComptable.update({ where: { id: compte.id }, data: { code: '999123' } }), /Code du compte comptable immuable/);
      const r = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Destination SQL', motif: 'Correction SQL', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const trace = await prisma.journalCompteComptable.findFirstOrThrow({ where: { compteId: compte.id } });
      for (const data of [{ motif: 'Falsifié' }, { avantLibelle: 'Falsifié' }]) await assert.rejects(prisma.journalCompteComptable.update({ where: { id: trace.id }, data }), /Journal comptable immuable/);
      await assert.rejects(prisma.journalCompteComptable.delete({ where: { id: trace.id } }), /Journal comptable immuable/);
      const auteur = await prisma.user.findUniqueOrThrow({ where: { id: trace.auteurId } });
      for (const [id, avantLibelle, apresLibelle, avantNature, apresNature, motif] of [
        ['test-modification-identique', 'Même', 'Même', 'CHARGE', 'CHARGE', 'Motif correct'],
        ['test-modification-vide', '', 'Après', 'CHARGE', 'ACTIF', 'Motif correct'],
        ['test-modification-nature', 'Avant', 'Après', 'INCONNU', 'ACTIF', 'Motif correct'],
        ['test-modification-motif', 'Avant', 'Après', 'CHARGE', 'ACTIF', 'Non\nvalide'],
        ['test-modification-apres-controle', 'Avant', 'Après\u0005', 'CHARGE', 'ACTIF', 'Motif correct'],
        ['test-modification-apres-espace', 'Avant', ' Après', 'CHARGE', 'ACTIF', 'Motif correct'],
        ['test-modification-apres-bidi', 'Avant', 'Après\u202E', 'CHARGE', 'ACTIF', 'Motif correct'],
        ['test-modification-motif-invisible', 'Avant', 'Après', 'CHARGE', 'ACTIF', '\u200B'.repeat(3)],
      ]) {
        await assert.rejects(prisma.$executeRaw`INSERT INTO "JournalCompteComptable" ("id", "compteId", "auteurId", "auteurNom", "action", "avantLibelle", "apresLibelle", "avantNature", "apresNature", "motif") VALUES (${id}, ${compte.id}, ${auteur.id}, ${auteur.name}, 'MODIFICATION', ${avantLibelle}, ${apresLibelle}, ${avantNature}, ${apresNature}, ${motif})`, /constraint|check/i);
      }
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 1);
    });

    test('SQL direct sans journal motivé est rejeté à la validation de transaction', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `867${String(Date.now()).slice(-9)}`, libelle: 'Original SQL', nature: 'CHARGE' } });
      await assert.rejects(prisma.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Fraude SQL' } }), /journal|motif|transition/i);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Original SQL');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('SQL avance la version même si un UPDATE remet le même instant milliseconde', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `860${String(Date.now()).slice(-9)}`, libelle: 'Version SQL', nature: 'CHARGE' } });
      await prisma.$executeRaw`UPDATE "CompteComptable" SET "updatedAt" = ${compte.updatedAt} WHERE "id" = ${compte.id}`;
      const apres = await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } });
      assert.ok(apres.updatedAt.getTime() >= compte.updatedAt.getTime() + 1);
    });

    test('SQL accepte une transition avec journal dans la même transaction, pas un journal antérieur', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `866${String(Date.now()).slice(-9)}`, libelle: 'Avant SQL', nature: 'CHARGE' } });
      const auteur = await prisma.user.findUniqueOrThrow({ where: { email: 'secours@iris.test' } });
      await prisma.$transaction(async tx => {
        await tx.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Après SQL' } });
        await tx.journalCompteComptable.create({ data: { compteId: compte.id, auteurId: auteur.id, auteurNom: auteur.name, action: 'MODIFICATION', avantLibelle: 'Avant SQL', apresLibelle: 'Après SQL', avantNature: 'CHARGE', apresNature: 'CHARGE', motif: 'Correction SQL motivée' } });
      });
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Après SQL');
      await assert.rejects(prisma.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Avant SQL' } }), /journal|motif|transition/i);
      await prisma.$transaction(async tx => {
        await tx.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Avant SQL' } });
        await tx.journalCompteComptable.create({ data: { compteId: compte.id, auteurId: auteur.id, auteurNom: auteur.name, action: 'MODIFICATION', avantLibelle: 'Après SQL', apresLibelle: 'Avant SQL', avantNature: 'CHARGE', apresNature: 'CHARGE', motif: 'Retour motivé' } });
      });
      // Le premier journal A→B existe, mais une troisième transition A→B
      // doit exiger une nouvelle écriture créée dans cette transaction.
      await assert.rejects(prisma.compteComptable.update({ where: { id: compte.id }, data: { libelle: 'Après SQL' } }), /journal|motif|transition/i);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Avant SQL');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 2);
    });

    test('attend le verrou global puis relit les règles avant une modification de nature', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `872${String(Date.now()).slice(-9)}`, libelle: 'Compte concurrent', nature: 'PRODUIT' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      let signalerVerrou;
      const verrouPris = new Promise(resolve => { signalerVerrou = resolve; });
      let liberer;
      const barriere = new Promise(resolve => { liberer = resolve; });
      const transaction = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
        await regleFixture('VENTE_ARTICLE', compte.id, tx);
        signalerVerrou();
        await barriere;
      }, { timeout: 20_000 });
      await verrouPris;
      const demande = request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle: 'Changé', nature: 'CHARGE', motif: 'Concurrence de remappage', expectedUpdatedAt: compte.updatedAt.toISOString() });
      const resultat = demande.then(r => r);
      try {
        let attente = false;
        for (let i = 0; i < 30 && !attente; i++) {
          const [etat] = await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%') AS attente`;
          attente = etat.attente;
          if (!attente) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(attente, true, 'la modification doit attendre le verrou du paramétrage');
      } finally { liberer(); await transaction; }
      const reponse = await resultat;
      assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).nature, 'PRODUIT');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('deux modifications simultanées journalisent une chaîne avant/après cohérente', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `870${String(Date.now()).slice(-9)}`, libelle: 'Départ', nature: 'CHARGE' } });
      const url = `/api/comptabilite/comptes/${compte.id}`;
      const requetes = await Promise.all(['Premier', 'Second'].map(libelle => request(app).patch(url).set('Authorization', `Bearer ${session}`).send({ libelle, motif: `Correction ${libelle}`, expectedUpdatedAt: compte.updatedAt.toISOString() })));
      assert.deepEqual(requetes.map(r => r.status).sort(), [200, 409]);
      const traces = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].avantLibelle, 'Départ');
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, traces[0].apresLibelle);
    });

    test('une insertion du journal refusée annule la modification du compte', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `871${String(Date.now()).slice(-9)}`, libelle: 'Avant rollback', nature: 'CHARGE' } });
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "journal_test_refus_insertion" CHECK ("motif" <> \'TEST refus atomique\')');
      try {
        const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Après rollback', motif: 'TEST refus atomique', expectedUpdatedAt: compte.updatedAt.toISOString() });
        assert.equal(reponse.status, 500, JSON.stringify(reponse.body));
        assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Avant rollback');
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      } finally { await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT "journal_test_refus_insertion"'); }
    });

    test('autorise un ADMIN ordinaire à changer le statut d’un compte', async () => {
      const admin = await prisma.user.create({ data: { email: 'comptabilite.admin@iris.test', name: 'TEST Admin comptabilité', role: 'ADMIN' } });
      const token = jwt.sign({ id: admin.id }, process.env.JWT_SECRET);
      const compte = await prisma.compteComptable.create({ data: { code: `892${String(Date.now()).slice(-9)}`, libelle: 'Compte admin', nature: 'CHARGE' } });
      const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}/activation`).set('Authorization', `Bearer ${token}`).send({ actif: false, motif: 'Compte devenu inutile' });
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.actif, false);
      const journal = await request(app).get(`/api/comptabilite/comptes/${compte.id}/journal`).set('Authorization', `Bearer ${token}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.length, 1);
      const { compteId, auteurId, auteurNom, action, avant, apres, motif } = journal.body[0];
      assert.deepEqual({ compteId, auteurId, auteurNom, action, avant, apres, motif }, {
        compteId: compte.id, auteurId: admin.id, auteurNom: admin.name, action: 'DESACTIVATION', avant: true, apres: false, motif: 'Compte devenu inutile',
      });
      assert.ok(journal.body[0].createdAt);
      const url = `/api/comptabilite/comptes/${compte.id}/activation`;
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${token}`).send({ actif: false, motif: 'Doublon injustifié' })).status, 409);
      assert.equal((await prisma.journalCompteComptable.count({ where: { compteId: compte.id } })), 1);
      assert.equal((await request(app).patch(url).set('Authorization', `Bearer ${token}`).send({ actif: true, motif: '  Retour en service  ' })).status, 200);
      const traces = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id } });
      assert.equal(traces.length, 2);
      const retour = traces.find(trace => trace.action === 'REACTIVATION');
      assert.ok(retour);
      assert.deepEqual([retour.avant, retour.apres, retour.motif], [false, true, 'Retour en service']);
      await assert.rejects(prisma.journalCompteComptable.update({ where: { id: journal.body[0].id }, data: { motif: 'Altéré' } }), /Journal comptable immuable/);
      await assert.rejects(prisma.journalCompteComptable.delete({ where: { id: journal.body[0].id } }), /Journal comptable immuable/);
      assert.equal((await prisma.journalCompteComptable.count({ where: { compteId: compte.id } })), 2);
    });

    test('les CHECK SQL refusent transitions et motifs incohérents dans le journal comptable', async () => {
      const auteur = await prisma.user.create({ data: { email: 'journal.comptable.sql@iris.test', name: 'TEST Journal SQL', role: 'ADMIN' } });
      const compte = await prisma.compteComptable.create({ data: { code: `880${String(Date.now()).slice(-9)}`, libelle: 'Contrôles SQL', nature: 'CHARGE' } });
      for (const { id, action, avant, apres, motif } of [
        { id: 'test-journal-transition-invalide', action: 'DESACTIVATION', avant: false, apres: false, motif: 'Correction métier' },
        { id: 'test-journal-motif-vide', action: 'DESACTIVATION', avant: true, apres: false, motif: '' },
        { id: 'test-journal-motif-controle', action: 'DESACTIVATION', avant: true, apres: false, motif: 'Motif\ninvalide' },
        { id: 'test-journal-motif-invisible', action: 'DESACTIVATION', avant: true, apres: false, motif: '\u200B'.repeat(3) },
      ]) {
        await assert.rejects(prisma.$executeRaw`INSERT INTO "JournalCompteComptable" ("id", "compteId", "auteurId", "auteurNom", "action", "avant", "apres", "motif") VALUES (${id}, ${compte.id}, ${auteur.id}, ${auteur.name}, ${action}, ${avant}, ${apres}, ${motif})`);
      }
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('la suppression de l’auteur d’un journal comptable explique la preuve à conserver', async () => {
      const auteur = await prisma.user.create({ data: { email: 'journal.comptable.auteur@iris.test', name: 'TEST Auteur comptable', role: 'ADMIN' } });
      const compte = await prisma.compteComptable.create({ data: { code: `879${String(Date.now()).slice(-9)}`, libelle: 'Compte auteur protégé', nature: 'CHARGE' } });
      const token = jwt.sign({ id: auteur.id }, process.env.JWT_SECRET);
      assert.equal((await request(app).patch(`/api/comptabilite/comptes/${compte.id}/activation`).set('Authorization', `Bearer ${token}`).send({ actif: false, motif: 'Fin utilisation' })).status, 200);
      const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 409, JSON.stringify(suppression.body));
      assert.match(suppression.body.error, /preuve de traçabilité/);
      assert.match(suppression.body.error, /Désactivez-le plutôt/);
      assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
      assert.equal(await prisma.journalCompteComptable.count({ where: { auteurId: auteur.id } }), 1);
    });

    test('une écriture du journal refusée par la base annule aussi le statut', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `881${String(Date.now()).slice(-9)}`, libelle: 'Rollback journal', nature: 'CHARGE' } });
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT IF EXISTS "journal_test_refus_insertion"');
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "journal_test_refus_insertion" CHECK ("motif" <> \'TEST refus atomique\')');
      try {
        const reponse = await request(app).patch(`/api/comptabilite/comptes/${compte.id}/activation`).set('Authorization', `Bearer ${session}`).send({ actif: false, motif: 'TEST refus atomique' });
        assert.equal(reponse.status, 500, JSON.stringify(reponse.body));
        assert.equal((await prisma.compteComptable.findUnique({ where: { id: compte.id } })).actif, true);
        assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT "journal_test_refus_insertion"');
      }
    });

    test('signale un code inactif lors de la création et refuse un import atomiquement', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: `887${String(Date.now()).slice(-9)}`, libelle: 'Compte inactif import', nature: 'CHARGE', actif: false } });
      const codeLibre = `886${String(Date.now()).slice(-9)}`;
      const creation = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: compte.code, libelle: compte.libelle, nature: compte.nature });
      assert.equal(creation.status, 409);
      assert.match(creation.body.error, /inactif/);
      const importation = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [{ code: codeLibre, libelle: 'Nouveau', nature: 'CHARGE' }, { code: compte.code, libelle: compte.libelle, nature: compte.nature }] });
      assert.equal(importation.status, 409, JSON.stringify(importation.body));
      assert.deepEqual(importation.body.erreurs.map(e => e.ligne), [2]);
      assert.match(importation.body.erreurs[0].erreur, /inactif/);
      assert.equal(await prisma.compteComptable.count({ where: { code: codeLibre } }), 0);
      assert.equal((await prisma.compteComptable.findUnique({ where: { id: compte.id } })).actif, false);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('aperçu de 4 900 modifications liées : lectures bornées et règles respectées', async () => {
      const lignes = Array.from({ length: 4900 }, (_, i) => ({ code: String(880000 + i), libelle: `Modifié ${i}`, nature: 'ACTIF' }));
      await prisma.compteComptable.createMany({ data: lignes.map(c => ({ ...c, libelle: `Initial ${c.code}`, nature: 'CHARGE' })) });
      const lie = await prisma.compteComptable.findUniqueOrThrow({ where: { code: lignes[0].code } });
      await regleFixture('CLIENT', lie.id);
      // Compter les lectures applicatives (pas le temps machine) distingue un préchargement
      // borné d'une requête par compte, même sur une CI lente.
      const { prisma: prismaApp } = await import('../dist/index.js');
      let lectures = 0;
      let enCours = true;
      prismaApp.$use(async (params, next) => {
        if (enCours && ['CompteComptable', 'RegleComptable', 'RegleTvaComptable'].includes(params.model) && ['findMany', 'count'].includes(params.action)) lectures++;
        return next(params);
      });
      let reponse;
      try {
        reponse = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', phase: 'apercu', lignes });
      } finally { enCours = false; }
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body).slice(0, 300));
      assert.equal(reponse.body.actions.length, lignes.length);
      assert.ok(lectures <= 4, `préchargement borné attendu, ${lectures} lectures observées pour 4 900 comptes`);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: lie.id } }), 0);
    });

    test('aperçu puis confirmation de mise à jour CSV : aucun effet avant confirmation, journal par compte', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899851', libelle: 'Ancien', nature: 'CHARGE' } });
      const lignes = [{ code: compte.code, libelle: 'Nouveau', nature: 'ACTIF' }, { code: '899852', libelle: 'Création', nature: 'CHARGE' }];
      const url = '/api/comptabilite/importer';
      const apercu = await request(app).post(url).set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', phase: 'apercu', lignes });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      assert.deepEqual(apercu.body.actions.map(({ code, action }) => [code, action]), [['899851', 'modifier'], ['899852', 'creer']]);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Ancien');
      assert.equal(await prisma.compteComptable.count({ where: { code: '899852' } }), 0);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
      const confirmation = await request(app).post(url).set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', phase: 'confirmer', lignes, motif: 'Correction du référentiel', apercuId: apercu.body.apercuId });
      assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Nouveau');
      assert.equal(await prisma.compteComptable.count({ where: { code: '899852' } }), 1);
      const traces = await prisma.journalCompteComptable.findMany({ where: { compteId: compte.id } });
      assert.deepEqual(traces.map(t => [t.action, t.motif, t.avantNature, t.apresNature]), [['MODIFICATION', 'Correction du référentiel', 'CHARGE', 'ACTIF']]);
    });

    test('aperçu périmé après PATCH, motif invalide et jeton falsifié : aucune écriture du lot', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899853', libelle: 'Original', nature: 'CHARGE' } });
      const lignes = [{ code: '899854', libelle: 'Nouveau', nature: 'ACTIF' }, { code: compte.code, libelle: 'Import', nature: 'ACTIF' }];
      const url = '/api/comptabilite/importer';
      const envoyer = body => request(app).post(url).set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      for (const motif of [undefined, 'ab', '\u200B'.repeat(3)]) {
        const refus = await envoyer({ phase: 'confirmer', motif, apercuId: apercu.body.apercuId });
        assert.equal(refus.status, 400, JSON.stringify(refus.body));
      }
      assert.equal((await envoyer({ phase: 'confirmer', motif: 'Motif valable', apercuId: apercu.body.apercuId + 'x' })).status, 409);
      const patch = await request(app).patch(`/api/comptabilite/comptes/${compte.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Intermédiaire', motif: 'Autre éditeur', expectedUpdatedAt: compte.updatedAt.toISOString() });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
      const refuse = await envoyer({ phase: 'confirmer', motif: 'Motif valable', apercuId: apercu.body.apercuId });
      assert.equal(refuse.status, 409, JSON.stringify(refuse.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: '899854' } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Intermédiaire');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 1);
    });

    test('aperçu lié au fichier : substitution des lignes rejetée sans création ni journal', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899863', libelle: 'Original', nature: 'CHARGE' } });
      const lignes = [{ code: '899864', libelle: 'Création', nature: 'CHARGE' }, { code: compte.code, libelle: 'Révision', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', ...body });
      const apercu = await envoyer({ phase: 'apercu', lignes });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      const substitution = await envoyer({ phase: 'confirmer', lignes: [{ ...lignes[0], libelle: 'Substitué' }, lignes[1]], motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(substitution.status, 409, JSON.stringify(substitution.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: '899864' } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Original');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('aperçu réservé à son auteur : autre administrateur refusé sans effet', async () => {
      const admin = await prisma.user.create({ data: { email: 'comptabilite.import.autre.admin@iris.test', name: 'TEST Autre admin import', role: 'ADMIN' } });
      const lignes = [{ code: '899865', libelle: 'À créer', nature: 'CHARGE' }];
      const envoyer = token => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${token}`);
      const apercu = await envoyer(session).send({ mode: 'mettre_a_jour', phase: 'apercu', lignes });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      const refus = await envoyer(jwt.sign({ id: admin.id }, process.env.JWT_SECRET)).send({ mode: 'mettre_a_jour', phase: 'confirmer', lignes, motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      assert.equal(await prisma.journalCompteComptable.count({ where: { auteurId: admin.id } }), 0);
    });

    test('aperçu expiré après dix minutes : horloge restaurée même en cas d’échec', async () => {
      const lignes = [{ code: '899866', libelle: 'À créer', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      const horloge = Date.now;
      try {
        Date.now = () => horloge() + 10 * 60_000 + 1_000;
        const refus = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /périmé/i);
      } finally { Date.now = horloge; }
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
    });

    test('signature HMAC de l’ancien domaine rejetée, vraie signature acceptée', async () => {
      const lignes = [{ code: '899867', libelle: 'À créer', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      const [contenu] = apercu.body.apercuId.split('.');
      const signatureAncienne = createHmac('sha256', process.env.JWT_SECRET).update(contenu).digest('base64url');
      const refus = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: `${contenu}.${signatureAncienne}` });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      const succes = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(succes.status, 200, JSON.stringify(succes.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 1);
    });

    test('remappage comptable après aperçu : 409 sans écriture du lot', async () => {
      const source = await prisma.compteComptable.create({ data: { code: '899868', libelle: 'Source', nature: 'PRODUIT' } });
      const cible = await prisma.compteComptable.create({ data: { code: '899869', libelle: 'Cible', nature: 'PRODUIT' } });
      const lignes = [{ code: '899870', libelle: 'Ne pas créer', nature: 'CHARGE' }, { code: source.code, libelle: 'Révisé', nature: 'PRODUIT' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const regle = '/api/comptabilite/regles/VENTE_ARTICLE';
      assert.equal((await request(app).put(regle).set('Authorization', `Bearer ${session}`).send({ ...await versionRegle('VENTE_ARTICLE'), compteId: source.id, motif: 'Configuration avant aperçu' })).status, 200);
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      assert.equal((await request(app).put(regle).set('Authorization', `Bearer ${session}`).send({ ...await versionRegle('VENTE_ARTICLE'), compteId: cible.id, motif: 'Changement après aperçu' })).status, 200);
      const refus = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: source.id } })).libelle, 'Source');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: source.id } }), 0);
    });

    test('remappage TVA après aperçu : 409 sans écriture du lot', async () => {
      const source = await prisma.compteComptable.create({ data: { code: '899871', libelle: 'TVA source', nature: 'TVA' } });
      const cible = await prisma.compteComptable.create({ data: { code: '899872', libelle: 'TVA cible', nature: 'TVA' } });
      const lignes = [{ code: '899873', libelle: 'Ne pas créer', nature: 'CHARGE' }, { code: source.code, libelle: 'Révisé', nature: 'TVA' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const regle = '/api/comptabilite/tva/20';
      assert.equal((await request(app).put(regle).set('Authorization', `Bearer ${session}`).send({ ...await versionTva(20), compteId: source.id, motif: 'Configuration avant aperçu' })).status, 200);
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      assert.equal((await request(app).put(regle).set('Authorization', `Bearer ${session}`).send({ ...await versionTva(20), compteId: cible.id, motif: 'Changement après aperçu' })).status, 200);
      const refus = await envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: source.id } })).libelle, 'TVA source');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: source.id } }), 0);
    });

    test('modes et phases inconnus refusés atomiquement', async () => {
      const lignes = [{ code: '899874', libelle: 'Ne pas créer', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes, ...body });
      for (const body of [{ mode: 'inconnu' }, { mode: 'mettre_a_jour', phase: 'inconnue' }, { mode: 'mettre_a_jour' }, { phase: 'apercu' }]) {
        const refus = await envoyer(body);
        assert.equal(refus.status, 400, JSON.stringify({ body, reponse: refus.body }));
        assert.equal(await prisma.compteComptable.count({ where: { code: lignes[0].code } }), 0);
      }
    });

    test('mise à jour CSV refuse les inactifs et natures liées à des règles sans effet partiel', async () => {
      const inactif = await prisma.compteComptable.create({ data: { code: '899855', libelle: 'Inactif', nature: 'CHARGE', actif: false } });
      const lie = await prisma.compteComptable.create({ data: { code: '899856', libelle: 'Vente', nature: 'PRODUIT' } });
      await regleFixture('VENTE_ARTICLE', lie.id);
      const url = '/api/comptabilite/importer';
      for (const [compte, attendu] of [[inactif, /inactif/], [lie, /nature incompatible/i]]) {
        const reponse = await request(app).post(url).set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', phase: 'apercu', lignes: [{ code: '899857', libelle: 'Ne pas créer', nature: 'CHARGE' }, { code: compte.code, libelle: 'Changé', nature: 'ACTIF' }] });
        assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
        assert.deepEqual(reponse.body.erreurs.map(e => e.ligne), [2]);
        assert.match(reponse.body.erreurs[0].erreur, attendu);
      }
      assert.equal(await prisma.compteComptable.count({ where: { code: '899857' } }), 0);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: { in: [inactif.id, lie.id] } } }), 0);
    });

    test('mise à jour CSV annule les modifications si le journal du lot échoue', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899858', libelle: 'Original', nature: 'CHARGE' } });
      const lignes = [{ code: '899859', libelle: 'Création', nature: 'CHARGE' }, { code: compte.code, libelle: 'Corrigé', nature: 'CHARGE' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" ADD CONSTRAINT "journal_test_refus_insertion" CHECK ("motif" <> \'TEST refus atomique\')');
      try {
        const reponse = await envoyer({ phase: 'confirmer', motif: 'TEST refus atomique', apercuId: apercu.body.apercuId });
        assert.equal(reponse.status, 500, JSON.stringify(reponse.body));
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "JournalCompteComptable" DROP CONSTRAINT "journal_test_refus_insertion"');
      }
      assert.equal(await prisma.compteComptable.count({ where: { code: '899859' } }), 0);
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).libelle, 'Original');
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    test('confirmation attend le verrou global puis refuse un aperçu devenu périmé', async () => {
      const compte = await prisma.compteComptable.create({ data: { code: '899860', libelle: 'Original', nature: 'CHARGE' } });
      const lignes = [{ code: compte.code, libelle: 'Import', nature: 'ACTIF' }];
      const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
      const apercu = await envoyer({ phase: 'apercu' });
      assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
      let liberer;
      const barriere = new Promise(resolve => { liberer = resolve; });
      let verrouPris;
      const signal = new Promise(resolve => { verrouPris = resolve; });
      const concurrent = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
        verrouPris();
        await barriere;
        await tx.compteComptable.update({ where: { id: compte.id }, data: { actif: false } });
      });
      await signal;
      const requete = envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId }).then(reponse => reponse);
      let attenteObservee = false;
      try {
        for (let i = 0; i < 40; i++) {
          const activites = await prisma.$queryRaw`SELECT "wait_event" FROM pg_stat_activity WHERE "wait_event" = 'advisory'`;
          if (activites.length) { attenteObservee = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } finally { liberer(); await concurrent; }
      const refus = await requete;
      assert.equal(attenteObservee, true, 'la confirmation doit attendre le verrou du périmètre');
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal((await prisma.compteComptable.findUniqueOrThrow({ where: { id: compte.id } })).actif, false);
      assert.equal(await prisma.journalCompteComptable.count({ where: { compteId: compte.id } }), 0);
    });

    for (const ordre of ['creation', 'confirmation']) {
      test(`course création / confirmation CSV : ${ordre} prend le verrou en premier`, async () => {
        const code = ordre === 'creation' ? '899861' : '899862';
        const lignes = [{ code, libelle: 'Import CSV', nature: 'CHARGE' }];
        const envoyer = body => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ mode: 'mettre_a_jour', lignes, ...body });
        const apercu = await envoyer({ phase: 'apercu' });
        assert.equal(apercu.status, 200, JSON.stringify(apercu.body));
        const creer = () => request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code, libelle: 'Création unitaire', nature: 'CHARGE' }).then(r => r);
        const confirmer = () => envoyer({ phase: 'confirmer', motif: 'Correction motivée', apercuId: apercu.body.apercuId }).then(r => r);
        let liberer, verrouPris;
        const barriere = new Promise(resolve => { liberer = resolve; });
        const signal = new Promise(resolve => { verrouPris = resolve; });
        const verrou = prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
          verrouPris();
          await barriere;
        });
        await signal;
        const premier = ordre === 'creation' ? creer() : confirmer();
        const attendre = async (nombre) => {
          for (let i = 0; i < 80; i++) {
            const activites = await prisma.$queryRaw`SELECT "pid" FROM pg_stat_activity WHERE "wait_event" = 'advisory'`;
            if (activites.length >= nombre) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          assert.fail(`${nombre} requête(s) attendue(s) sur le verrou comptable`);
        };
        let second;
        try {
          await attendre(1);
          second = ordre === 'creation' ? confirmer() : creer();
          await attendre(2);
        } finally { liberer(); await verrou; }
        const [reponsePremier, reponseSecond] = await Promise.all([premier, second]);
        assert.equal(reponsePremier.status, ordre === 'creation' ? 201 : 200, JSON.stringify(reponsePremier.body));
        assert.equal(reponseSecond.status, 409, JSON.stringify(reponseSecond.body));
        const compte = await prisma.compteComptable.findUniqueOrThrow({ where: { code } });
        assert.equal(compte.libelle, ordre === 'creation' ? 'Création unitaire' : 'Import CSV');
        assert.equal(await prisma.compteComptable.count({ where: { code } }), 1);
      });
    }

    test('importe un plan comptable contrôlé ligne par ligne', async () => {
      const importation = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [{ code: '411000', libelle: 'Clients', nature: 'ACTIF' }, { code: '445710', libelle: 'TVA collectée', nature: 'TVA' }] });
      assert.equal(importation.status, 201, JSON.stringify(importation.body));
      assert.equal(importation.body.importes, 2);
    });

    test('refuse les caractères de contrôle dans un compte créé directement, sans écriture', async () => {
      for (const [index, libelle] of ['Clients\nFrance', 'Clients\tFrance', 'Clients\rFrance', 'Clients\u0000France', 'Clients\u007fFrance', 'Clients\t'].entries()) {
        const code = String(899970 + index);
        const reponse = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code, libelle, nature: 'ACTIF' });
        assert.equal(reponse.status, 400, JSON.stringify(reponse.body));
        assert.equal(await prisma.compteComptable.count({ where: { code } }), 0);
      }
    });

    test('refuse un lot avec libellé contenant retour ou tabulation sans écriture partielle', async () => {
      for (const [index, libelle] of ['Clients\nFrance', 'Clients\tFrance', 'Clients\rFrance', 'Clients\u0000France', 'Clients\u007fFrance', 'Clients\t'].entries()) {
        const code = String(899980 + index * 2);
        const reponse = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes: [
          { code, libelle: 'Valide', nature: 'ACTIF' },
          { code: String(Number(code) + 1), libelle, nature: 'ACTIF' },
        ] });
        assert.equal(reponse.status, 400, JSON.stringify(reponse.body));
        assert.deepEqual(reponse.body.erreurs.map(({ ligne }) => ligne), [2]);
        assert.equal(await prisma.compteComptable.count({ where: { code: { in: [code, String(Number(code) + 1)] } } }), 0);
      }
    });

    test('importe 5 000 comptes au-delà des 100 Ko par défaut et réimporte sans doublons', async () => {
      const lignes = Array.from({ length: 5000 }, (_, index) => ({ code: String(800000 + index), libelle: `Compte de test ${index} ${'x'.repeat(65)}`, nature: 'CHARGE' }));
      assert.ok(Buffer.byteLength(JSON.stringify({ lignes })) > 100 * 1024);
      const importer = () => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes });
      const premier = await importer();
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      assert.equal(premier.body.importes, lignes.length);
      const second = await importer();
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.ignores, lignes.length);
    });

    test('refuse en JSON un corps de plus de 5 Mo sans écrire de compte', async () => {
      const reponse = await request(app).post('/api/comptabilite/importer').set('Content-Type', 'application/json')
        .send(JSON.stringify({ lignes: [{ code: '899990', libelle: 'X'.repeat(5 * 1024 * 1024), nature: 'ACTIF' }] }));
      assert.equal(reponse.status, 413);
      assert.match(reponse.headers['content-type'], /application\/json/);
      assert.match(reponse.body.error, /volumineux|taille/i);
      assert.equal(await prisma.compteComptable.count({ where: { code: '899990' } }), 0);
    });

    test('refuse 409 et annule tout le lot si un code existant diffère', async () => {
      const lignes = [{ code: '899991', libelle: 'Nouveau', nature: 'ACTIF' }, { code: '411000', libelle: 'Autre libellé', nature: 'PASSIF' }];
      const reponse = await request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`).send({ lignes });
      assert.equal(reponse.status, 409, JSON.stringify(reponse.body));
      assert.deepEqual(reponse.body.erreurs.map(({ ligne }) => ligne), [2]);
      assert.equal(await prisma.compteComptable.count({ where: { code: '899991' } }), 0);
      assert.equal((await prisma.compteComptable.findUnique({ where: { code: '411000' } })).libelle, 'Clients');
    });

    test('deux imports concurrents divergents ne peuvent pas masquer un conflit', async () => {
      const envoyer = (libelle) => request(app).post('/api/comptabilite/importer').set('Authorization', `Bearer ${session}`)
        .send({ lignes: [{ code: '899992', libelle, nature: 'ACTIF' }] });
      const reponses = await Promise.all([envoyer('Premier'), envoyer('Second')]);
      assert.deepEqual(reponses.map(reponse => reponse.status).sort(), [201, 409], reponses.map(reponse => JSON.stringify(reponse.body)).join(' / '));
      assert.equal(await prisma.compteComptable.count({ where: { code: '899992' } }), 1);
    });

    test('pagination #109 : count et lignes lisent le même instant malgré une insertion concurrente', async () => {
      const avant = await prisma.facture.count();
      const transaction = appPrisma.$transaction.bind(appPrisma);
      let inseree;
      let observee = false;
      appPrisma.$transaction = (operation, options) => transaction(async tx => {
        const facture = new Proxy(tx.facture, { get(cible, methode) {
          if (methode !== 'count') return cible[methode];
          return async (...args) => {
            const total = await cible.count(...args);
            inseree = await prisma.facture.create({ data: {
              clientId, clientRaisonSociale: 'TEST concurrent #109', origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST concurrent #109',
              dateEmission: new Date('2026-09-08T00:00:00Z'), dateEcheance: new Date('2026-10-08T00:00:00Z'),
              totalHt: 10, totalTva: 2, totalTtc: 12,
            } });
            observee = true;
            return total;
          };
        } });
        return operation(new Proxy(tx, { get(cible, propriete) { return propriete === 'facture' ? facture : cible[propriete]; } }));
      }, options);
      try {
        const reponse = await request(app).get('/api/factures?page=1&pageSize=100').set('Authorization', `Bearer ${session}`);
        assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
        assert.equal(observee, true, 'la lecture paginée doit utiliser la transaction');
        assert.equal(reponse.body.total, avant);
        assert.ok(!reponse.body.items.some(item => item.id === inseree.id));
        assert.equal(await prisma.facture.count(), avant + 1);
      } finally {
        appPrisma.$transaction = transaction;
        if (inseree) await prisma.facture.delete({ where: { id: inseree.id } });
      }
    });

    test('pagination #109 : contrat legacy, bornes, accès et ordre total stable', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const creer = async motif => {
        const reponse = await request(app).post('/api/factures').set(auth).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: motif, quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
        assert.equal(reponse.status, 201);
        return reponse.body.id;
      };
      const ids = await Promise.all(['TEST pagination A', 'TEST pagination B', 'TEST pagination C'].map(creer));
      const memeInstant = new Date('2026-09-08T12:00:00Z');
      await prisma.facture.updateMany({ where: { id: { in: ids } }, data: { createdAt: memeInstant } });
      const legacy = await request(app).get('/api/factures').set(auth);
      assert.equal(legacy.status, 200);
      assert.ok(Array.isArray(legacy.body));
      const attendu = [...ids].sort().reverse();
      assert.deepEqual(legacy.body.filter(f => ids.includes(f.id)).map(f => f.id), attendu);
      const premier = await request(app).get('/api/factures?page=1&pageSize=2').set(auth);
      assert.equal(premier.status, 200);
      assert.equal(premier.body.page, 1);
      assert.equal(premier.body.pageSize, 2);
      assert.equal(premier.body.total, legacy.body.length);
      assert.deepEqual(premier.body.items.map(f => f.id), legacy.body.slice(0, 2).map(f => f.id));
      assert.ok(premier.body.items[0].client && Array.isArray(premier.body.items[0].lignes));
      const second = await request(app).get('/api/factures?page=2&pageSize=2').set(auth);
      assert.deepEqual(second.body.items.map(f => f.id), legacy.body.slice(2, 4).map(f => f.id));
      const vide = await request(app).get('/api/factures?page=999&pageSize=2').set(auth);
      assert.deepEqual(vide.body.items, []);
      assert.equal(vide.body.total, legacy.body.length);
      for (const query of ['page=1', 'pageSize=2', 'page=0&pageSize=2', 'page=1&pageSize=0', 'page=1&pageSize=101', 'page=1.5&pageSize=2', 'page=1e2&pageSize=2', 'page=%2B1&pageSize=2', 'page=01&pageSize=2', 'page=1&page=2&pageSize=2', 'page=9007199254740992&pageSize=2']) {
        const refus = await request(app).get(`/api/factures?${query}`).set(auth);
        assert.equal(refus.status, 400, query);
      }
      assert.equal((await request(app).get('/api/factures?page=1&pageSize=2')).status, 401);
      const nonAdmin = await prisma.user.create({ data: { email: 'facture.pagination@iris.test', name: 'TEST pagination', role: 'CONDUCTEUR_TRAVAUX' } });
      try {
        assert.equal((await request(app).get('/api/factures?page=1&pageSize=2').set('Authorization', `Bearer ${jwt.sign({ id: nonAdmin.id }, process.env.JWT_SECRET)}`)).status, 403);
      } finally { await prisma.user.delete({ where: { id: nonAdmin.id } }); }
    });

    test('réserve factures et comptabilité à l’administration', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'facture.conducteur@iris.test', name: 'TEST Conducteur facture', role: 'CONDUCTEUR_TRAVAUX' } });
      const token = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const routes = [() => request(app).get('/api/factures'), () => request(app).post('/api/factures').send({ motif: "Création de règle de test",  clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }), () => request(app).get('/api/factures/export-comptable.csv'), () => request(app).get('/api/facturation/prete-a-facturer'), () => request(app).get('/api/comptabilite'), () => request(app).post('/api/comptabilite/comptes').send({ code: '999999', libelle: 'TEST interdit', nature: 'PRODUIT' }), () => request(app).post('/api/comptabilite/importer').send({ lignes: [{ code: '999998', libelle: 'TEST interdit', nature: 'PRODUIT' }] }), () => request(app).post('/api/factures/inexistante/emettre'), () => request(app).post('/api/factures/inexistante/regler'), () => request(app).post('/api/factures/inexistante/annuler'), () => request(app).get('/api/factures/a-regler'), () => request(app).get('/api/reglements'), () => request(app).post('/api/reglements').send({ clientId, dateReglement: '11-09-2026', montant: 1, moyen: 'VIREMENT', affectations: [] }), () => request(app).post('/api/reglements/inexistant/contrepasser').send({ motif: 'TEST interdit' }), () => request(app).put('/api/comptabilite/regles/CLIENT').send({ compteId: 'peu-importe' }), () => request(app).put('/api/comptabilite/tva/20').send({ compteId: 'peu-importe' })];
      for (const route of routes) assert.equal((await route().set('Authorization', `Bearer ${token}`)).status, 403);
    });

    test('refuse une date d’émission future', async () => {
      const reponse = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '01-01-2099', dateEcheance: '01-02-2099', lignes: [{ designation: 'TEST future', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(reponse.status, 400); assert.match(reponse.body.error, /future/i);
    });

    test('crée une version légale brouillon distincte', async () => {
      const reponse = await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`).send({ mentions: 'TEST Mentions version 2', cgv: 'TEST CGV version 2', penalites: 'TEST Pénalités version 2', escompte: 'Sans escompte' });
      assert.equal(reponse.status, 201, JSON.stringify(reponse.body));
      assert.equal(reponse.body.version, 2);
      assert.equal(reponse.body.actif, false);
    });

    test('publie une version légale et remplace l’active', async () => {
      const reponse = await request(app).post('/api/mentions-legales/2/publier').set('Authorization', `Bearer ${session}`);
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.actif, true);
      assert.ok(reponse.body.publieeLe);
      const versions = await request(app).get('/api/mentions-legales').set('Authorization', `Bearer ${session}`);
      assert.equal(versions.body.filter((version) => version.actif).length, 1);
      assert.equal(versions.body.find((version) => version.actif)?.version, 2);
    });

    test('conserve la date exacte de première publication après activation d’une autre version puis réactivation', async () => {
      const creer = await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`)
        .send({ mentions: 'TEST Mentions version 3', cgv: 'TEST CGV version 3', penalites: 'TEST Pénalités version 3' });
      assert.equal(creer.status, 201, JSON.stringify(creer.body));
      assert.equal(creer.body.publieeLe, null);
      const publier = version => request(app).post(`/api/mentions-legales/${version}/publier`).set('Authorization', `Bearer ${session}`);
      const premiere = await publier(3);
      assert.equal(premiere.status, 200, JSON.stringify(premiere.body));
      assert.ok(premiere.body.publieeLe);
      const originale = premiere.body.publieeLe;
      assert.equal((await publier(2)).status, 200);
      await new Promise(resolve => setTimeout(resolve, 20)); // éviter une égalité accidentelle à la milliseconde
      const reactivee = await publier(3);
      assert.equal(reactivee.status, 200, JSON.stringify(reactivee.body));
      assert.equal(reactivee.body.publieeLe, originale);
      const versions = await request(app).get('/api/mentions-legales').set('Authorization', `Bearer ${session}`);
      assert.equal(versions.status, 200);
      assert.equal(versions.body.filter(version => version.actif).length, 1);
      assert.equal(versions.body.find(version => version.version === 3).publieeLe, originale);
      assert.equal((await publier(2)).status, 200);
      await prisma.mentionsLegalesVersion.delete({ where: { version: 3 } });
    });

    test('le garde SQL refuse le changement d’identifiant d’une version publiée', async () => {
      const version = await prisma.mentionsLegalesVersion.create({ data: {
        version: 991, mentions: 'TEST Mentions immuables', cgv: 'TEST CGV immuables',
        penalites: 'TEST Pénalités immuables', actif: false, publieeLe: new Date(),
      } });
      try {
        await assert.rejects(
          () => prisma.$executeRaw`UPDATE "MentionsLegalesVersion" SET "id" = ${`${version.id}-modifie`} WHERE "id" = ${version.id}`,
          erreur => /Une version légale publiée est immuable/.test(erreur.message),
        );
        assert.equal((await prisma.mentionsLegalesVersion.findUniqueOrThrow({ where: { version: 991 } })).id, version.id);
      } finally {
        await prisma.mentionsLegalesVersion.delete({ where: { version: 991 } });
      }
    });

    test('le garde SQL refuse le changement de date publiée mais autorise le changement d’activation', async () => {
      const avant = await prisma.mentionsLegalesVersion.findUniqueOrThrow({ where: { version: 2 } });
      assert.ok(avant.publieeLe);
      await assert.rejects(
        () => prisma.$executeRaw`UPDATE "MentionsLegalesVersion" SET "publieeLe" = ${new Date('2000-01-01T00:00:00.000Z')} WHERE "id" = ${avant.id}`,
        erreur => /Une version légale publiée est immuable/.test(erreur.message),
      );
      assert.equal((await prisma.mentionsLegalesVersion.findUniqueOrThrow({ where: { version: 2 } })).publieeLe.toISOString(), avant.publieeLe.toISOString());
      await prisma.mentionsLegalesVersion.update({ where: { version: 2 }, data: { actif: false } });
      await prisma.mentionsLegalesVersion.update({ where: { version: 1 }, data: { actif: true } });
      assert.equal(await prisma.mentionsLegalesVersion.count({ where: { actif: true } }), 1);
      await prisma.mentionsLegalesVersion.update({ where: { version: 1 }, data: { actif: false } });
      await prisma.mentionsLegalesVersion.update({ where: { version: 2 }, data: { actif: true } });
      assert.equal(await prisma.mentionsLegalesVersion.count({ where: { actif: true } }), 1);
    });

    test('interdit de modifier le contenu d’une version publiée', async () => {
      await assert.rejects(() => prisma.mentionsLegalesVersion.update({ where: { version: 2 }, data: { cgv: 'TEST tentative de modification interdite' } }));
      const version = await prisma.mentionsLegalesVersion.findUnique({ where: { version: 2 } });
      assert.equal(version.cgv, 'TEST CGV version 2');
    });

    test('liste les versions légales pour l’administration', async () => {
      const reponse = await request(app).get('/api/mentions-legales').set('Authorization', `Bearer ${session}`);
      assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
      assert.equal(reponse.body.length, 2);
      assert.equal(reponse.body.find((version) => version.actif)?.version, 2);
    });

    test('refuse l’émission sans mentions légales publiées', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Facture en attente de paramétrage', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST mentions absentes', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      await prisma.mentionsLegalesVersion.deleteMany({});
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 409, JSON.stringify(emission.body));
      await prisma.mentionsLegalesVersion.create({ data: { version: 1, mentions: 'TEST Mentions légales', cgv: 'TEST Conditions générales', penalites: 'TEST Pénalités de retard', actif: true, publieeLe: new Date() } });
    });

    test('refuse une imputation incomplète à l’émission sans consommer de numéro', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST compte requis', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST compte requis', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201);
      const avant = await prisma.sequenceFacture.findUnique({ where: { annee: 2026 } });
      const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /comptable/i);
      assert.equal((await prisma.facture.findUnique({ where: { id: brouillon.body.id } })).numero, null);
      assert.deepEqual(await prisma.sequenceFacture.findUnique({ where: { annee: 2026 } }), avant);
      const compte = async code => (await prisma.compteComptable.findUnique({ where: { code } })).id;
      for (const [cle, code] of [['CLIENT', '411000'], ['VENTE_PRESTATION', '706100'], ['VENTE_ARTICLE', '706100']]) {
        assert.equal((await request(app).put(`/api/comptabilite/regles/${cle}`).set('Authorization', `Bearer ${session}`).send({ ...await versionRegle(cle),  motif: 'Révision de règle comptable testée', compteId: await compte(code) })).status, 200);
      }
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ ...(await versionRegle('JOURNAL_VENTES')),  motif: 'Révision de règle comptable testée', journal: 'VTE' })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ ...(await versionTva(20)),  motif: 'Révision de règle comptable testée', compteId: await compte('445710') })).status, 200);
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
    });

    test('refuse à l’émission un taux de TVA sans compte, sans consommer de séquence', async () => {
      const compteTva = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
      assert.equal((await request(app).put('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ ...(await versionTva(5.5)),  motif: 'Révision de règle comptable testée', compteId: compteTva.id })).status, 200);
      const mapping55 = (await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`)).body.reglesTva.find(r => r.taux === 5.5);
      assert.equal((await request(app).delete('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ confirmation: '5.5', expectedCompteId: mapping55.compteId, expectedUpdatedAt: mapping55.updatedAt, motif: 'Retrait avant émission' })).status, 204);
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST TVA absente', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST taux réduit', quantite: 1, prixUnitaireHt: 9, tauxTva: 5.5 }] });
      assert.equal(brouillon.status, 201);
      const avant = await prisma.sequenceFacture.findUniqueOrThrow({ where: { annee: 2026 } });
      const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /TVA:5\.5/);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: brouillon.body.id } })).numero, null);
      assert.deepEqual(await prisma.sequenceFacture.findUniqueOrThrow({ where: { annee: 2026 } }), avant);
    });

    test('exige VENTE_ARTICLE même pour une facture sans ligne article', async () => {
      const article = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '706100' } });
      await regleFixture('VENTE_ARTICLE', article.id);
      const regle = await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'VENTE_ARTICLE' } });
      await retirerRegleFixture('VENTE_ARTICLE');
      try {
        const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST règle article obligatoire', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST prestation', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
        assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
        const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /VENTE_ARTICLE/);
        assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: brouillon.body.id } })).numero, null);
      } finally {
        await regleFixture(regle.cle, regle.compteId ?? regle.journal);
      }
    });

    test('attribue un numéro annuel seulement lors de l’émission', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST Émission facture', quantite: 1, prixUnitaireHt: 50, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      assert.equal(emission.body.statut, 'EMISE');
      assert.equal(emission.body.mentionsLegalesVersion?.version, 1);
      assert.equal(emission.body.mentionsLegalesVersion?.mentions, 'TEST Mentions légales');
      const journalFacture = await request(app).get(`/api/factures/${brouillon.body.id}/journal`).set('Authorization', `Bearer ${session}`);
      assert.equal(journalFacture.status, 200, JSON.stringify(journalFacture.body));
      assert.deepEqual(journalFacture.body.map((entree) => entree.action), ['CREATION_BROUILLON', 'EMISSION']);
      await assert.rejects(() => prisma.facture.update({ where: { id: brouillon.body.id }, data: { motifHorsAffaire: 'TEST tentative de modification' } }));
      assert.match(emission.body.numero, /\d{4}/, 'Une facture émise porte une numérotation annuelle.');
      const reemission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(reemission.status, 409, JSON.stringify(reemission.body));
      assert.equal((await prisma.facture.findUnique({ where: { id: brouillon.body.id } })).numero, emission.body.numero);
      const configuration = await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`);
      assert.equal(configuration.status, 200, JSON.stringify(configuration.body));
      const compte = (code) => configuration.body.comptes.find((c) => c.code === code);
      await Promise.all([
        request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte('411000').id }),
        request(app).put('/api/comptabilite/regles/TVA_COLLECTEE').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte('445710').id }),
        request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte('445710').id }),
        request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte('706100').id }),
        request(app).put('/api/comptabilite/regles/VENTE_ARTICLE').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte('706100').id }),
        request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  journal: 'VTE' }),
      ]);
      await Promise.all([
        request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte('706100').id }).then(r => assert.equal(r.status, 400)),
        request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  journal: 'X'.repeat(300) }).then(r => assert.equal(r.status, 400)),
      ]);
      const exportComptable = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportComptable.status, 200, exportComptable.text);
      assert.match(exportComptable.text, /JournalCode;EcritureDate/);
      assert.match(exportComptable.text, /706100/);
      const lignesPiece = exportComptable.text.split('\n').filter(ligne => ligne.includes(emission.body.numero));
      const montant = (ligne, index) => Number(ligne.split(';')[index].replace(/"/g, ''));
      assert.equal(lignesPiece.reduce((somme, ligne) => somme + montant(ligne, 6), 0).toFixed(2), lignesPiece.reduce((somme, ligne) => somme + montant(ligne, 7), 0).toFixed(2));
      assert.ok(exportComptable.text.split('\n').some(ligne => ligne.includes('445710')), 'une ligne de TVA doit être exportée');
      const journal = await prisma.regleComptable.findUnique({ where: { cle: 'JOURNAL_VENTES' } });
      await retirerRegleFixture('JOURNAL_VENTES');
      const exportIncomplet = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportIncomplet.status, 200);
      assert.equal(exportIncomplet.text, exportComptable.text, 'retirer le journal courant ne réécrit pas les pièces émises');
      await regleFixture('JOURNAL_VENTES', journal.journal);
      const mapping20 = (await request(app).get('/api/comptabilite').set('Authorization', `Bearer ${session}`)).body.reglesTva.find(r => r.taux === 20);
      assert.equal((await request(app).delete('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ confirmation: '20', expectedCompteId: mapping20.compteId, expectedUpdatedAt: mapping20.updatedAt, motif: 'Retrait après émission' })).status, 204);
      const exportSansTva = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportSansTva.status, 200); assert.equal(exportSansTva.text, exportComptable.text);
      assert.equal((await request(app).put('/api/comptabilite/tva/5.5').set('Authorization', `Bearer ${session}`).send({ ...(await versionTva(5.5)),  motif: 'Révision de règle comptable testée', compteId: compte('445710').id })).status, 200);
      const diagSansTva = await request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
      const tvaDecouverte = diagSansTva.body.controles.find((controle) => controle.cle === 'TVA');
      assert.equal(tvaDecouverte.pret, false, JSON.stringify(tvaDecouverte));
      assert.equal(tvaDecouverte.bloquant, true, 'Un taux historique sans compte signale un risque pour les nouvelles émissions de ce taux.');
      assert.match(tvaDecouverte.detail, /20 %/);
      assert.match(tvaDecouverte.detail, /émission.*refusée/i);
      assert.doesNotMatch(tvaDecouverte.detail, /export.*refusé/i);
      assert.equal(diagSansTva.body.pret, false, JSON.stringify(diagSansTva.body.controles));
      await retirerTvaFixture(5.5);
      await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ motif: "Création de règle de test",  compteId: compte('445710').id });
      const diagAvecTva = await request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
      const tvaCouverte = diagAvecTva.body.controles.find((controle) => controle.cle === 'TVA');
      assert.equal(tvaCouverte.pret, true, JSON.stringify(tvaCouverte)); assert.equal(tvaCouverte.bloquant, false);
      await prisma.client.update({ where: { id: clientId }, data: { raisonSociale: 'TEST Client contrat maintenance renommé' } });
      const exportFige = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportFige.status, 200); assert.match(exportFige.text, /TEST Client contrat maintenance/); assert.doesNotMatch(exportFige.text, /renommé/);
      await prisma.client.update({ where: { id: clientId }, data: { raisonSociale: 'TEST Client contrat maintenance' } });
      const piege = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '707999', libelle: '=1+1', nature: 'PRODUIT' }); assert.equal(piege.status, 201);
      const piegeRemappage = await request(app).put('/api/comptabilite/regles/VENTE_ARTICLE').set('Authorization', `Bearer ${session}`).send({ ...await versionRegle('VENTE_ARTICLE'), compteId: piege.body.id, motif: 'Vérification du CSV comptable' });
      assert.equal(piegeRemappage.status, 200, JSON.stringify(piegeRemappage.body));
      const article = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST article CSV', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const articleEmis = await request(app).post(`/api/factures/${article.body.id}/emettre`).set('Authorization', `Bearer ${session}`); const csvPiege = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(articleEmis.status, 200); assert.match(csvPiege.text, /;"'=1\+1";/);
    });

    test('fige les écritures à l’émission malgré un remappage puis inverse celles des avoirs', async () => {
      const exporter = () => request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      const creer = (designation) => request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST gel imputation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation, nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
      const emettre = id => request(app).post(`/api/factures/${id}/emettre`).set('Authorization', `Bearer ${session}`);
      const piece = (csv, numero) => csv.split('\n').filter(ligne => ligne.split(';')[2] === `"${numero}"`);
      const premier = await creer('TEST gel premier');
      assert.equal(premier.status, 201);
      const emis = await emettre(premier.body.id);
      assert.equal(emis.status, 200, JSON.stringify(emis.body));
      assert.equal(emis.body.ecrituresScellees, true, 'la réponse d’émission reflète le scellement commité');
      const numeroAvantRefus = await prisma.sequenceAvoir.findFirst({ orderBy: { annee: 'desc' } });
      const avoirNatureAbsente = await request(app).post(`/api/factures/${premier.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST article absent de la source', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(avoirNatureAbsente.status, 409, JSON.stringify(avoirNatureAbsente.body));
      assert.match(avoirNatureAbsente.body.error, /nature ou un taux absent de la facture d’origine.*VENTE_ARTICLE/i);
      assert.doesNotMatch(avoirNatureAbsente.body.error, /paramétrage comptable incomplet/i);
      assert.equal(await prisma.facture.count({ where: { factureOrigineId: premier.body.id } }), 0);
      assert.deepEqual(await prisma.sequenceAvoir.findFirst({ orderBy: { annee: 'desc' } }), numeroAvantRefus);
      const avant = piece((await exporter()).text, emis.body.numero);
      assert.equal(avant.length, 3);
      const nouveauCompte = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '706986', libelle: 'Nouveau compte de ventes', nature: 'PRODUIT' });
      assert.equal(nouveauCompte.status, 201);
      assert.equal((await request(app).put('/api/comptabilite/regles/VENTE_PRESTATION').set('Authorization', `Bearer ${session}`).send({ ...(await versionRegle('VENTE_PRESTATION')),  motif: 'Révision de règle comptable testée', compteId: nouveauCompte.body.id })).status, 200);
      const nouveauClient = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '411986', libelle: 'Nouveau compte client', nature: 'ACTIF' });
      const nouvelleTva = await request(app).post('/api/comptabilite/comptes').set('Authorization', `Bearer ${session}`).send({ code: '445986', libelle: 'Nouveau compte TVA', nature: 'TVA' });
      assert.equal(nouveauClient.status, 201);
      assert.equal(nouvelleTva.status, 201);
      assert.equal((await request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ ...(await versionRegle('CLIENT')),  motif: 'Révision de règle comptable testée', compteId: nouveauClient.body.id })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ ...(await versionTva(20)),  motif: 'Révision de règle comptable testée', compteId: nouvelleTva.body.id })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ ...(await versionRegle('JOURNAL_VENTES')),  motif: 'Révision de règle comptable testée', journal: 'NOUV' })).status, 200);
      const apres = piece((await exporter()).text, emis.body.numero);
      assert.deepEqual(apres, avant, 'les octets historiques ne dépendent plus des comptes client/vente/TVA ni du journal');
      const compteHistorique = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '706100' } });
      const patchHistorique = await request(app).patch(`/api/comptabilite/comptes/${compteHistorique.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Libellé changé après émission', motif: 'Rectification motivée', expectedUpdatedAt: compteHistorique.updatedAt.toISOString() });
      assert.equal(patchHistorique.status, 200, JSON.stringify(patchHistorique.body));
      try {
        assert.deepEqual(piece((await exporter()).text, emis.body.numero), avant, 'CompteLib est également figé');
      } finally {
        const restauration = await request(app).patch(`/api/comptabilite/comptes/${compteHistorique.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: compteHistorique.libelle, motif: 'Restauration du référentiel de test', expectedUpdatedAt: patchHistorique.body.updatedAt });
        assert.equal(restauration.status, 200, JSON.stringify(restauration.body));
      }
      const patchNouveau = await request(app).patch(`/api/comptabilite/comptes/${nouveauCompte.body.id}`).set('Authorization', `Bearer ${session}`).send({ libelle: 'Libellé neuf pour émissions futures', motif: 'Harmonisation du libellé', expectedUpdatedAt: nouveauCompte.body.updatedAt });
      assert.equal(patchNouveau.status, 200, JSON.stringify(patchNouveau.body));
      assert.deepEqual(piece((await exporter()).text, emis.body.numero), avant);
      const second = await creer('TEST gel second');
      const emisSecond = await emettre(second.body.id);
      assert.equal(emisSecond.status, 200, JSON.stringify(emisSecond.body));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).some(ligne => ligne.includes('706986')));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).some(ligne => ligne.includes('Libellé neuf pour émissions futures')));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).some(ligne => ligne.includes('411986')));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).some(ligne => ligne.includes('445986')));
      assert.ok(piece((await exporter()).text, emisSecond.body.numero).every(ligne => ligne.startsWith('"NOUV";')));
      const avoir = await request(app).post(`/api/factures/${premier.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST crédit', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 40, tauxTva: 20 }] });
      assert.equal(avoir.status, 201, JSON.stringify(avoir.body));
      assert.equal(avoir.body.ecrituresScellees, true, 'la réponse de l’avoir partiel reflète le scellement');
      const lignesAvoir = piece((await exporter()).text, avoir.body.numero);
      assert.equal(lignesAvoir.length, 3);
      assert.ok(lignesAvoir.some(ligne => ligne.includes('706100') && ligne.includes('"40.00"')));
      assert.ok(lignesAvoir.every(ligne => !ligne.includes('706986') && !ligne.includes('411986') && !ligne.includes('445986')));
      assert.ok(lignesAvoir.every(ligne => ligne.startsWith('"VTE";')));
      const originalClient = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '411000' } });
      const originalTva = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
      for (const [cle, id] of [['CLIENT', originalClient.id], ['VENTE_PRESTATION', compteHistorique.id]]) {
        assert.equal((await request(app).put(`/api/comptabilite/regles/${cle}`).set('Authorization', `Bearer ${session}`).send({ ...await versionRegle(cle),  motif: 'Révision de règle comptable testée', compteId: id })).status, 200);
      }
      assert.equal((await request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ ...(await versionTva(20)),  motif: 'Révision de règle comptable testée', compteId: originalTva.id })).status, 200);
      assert.equal((await request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ ...(await versionRegle('JOURNAL_VENTES')),  motif: 'Révision de règle comptable testée', journal: 'VTE' })).status, 200);
      const annulation = await request(app).post(`/api/factures/${second.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      assert.equal(annulation.body.avoir.ecrituresScellees, true, 'la réponse de l’avoir total reflète le scellement');
      const ecrituresSource = await prisma.ecritureFacture.findMany({ where: { factureId: second.body.id }, orderBy: { ordre: 'asc' } });
      const ecrituresAvoir = await prisma.ecritureFacture.findMany({ where: { factureId: annulation.body.avoir.id }, orderBy: { ordre: 'asc' } });
      assert.deepEqual(ecrituresAvoir.map(e => [e.journalCode, e.compteNum, e.compteLib, Number(e.debit), Number(e.credit)]),
        ecrituresSource.map(e => [e.journalCode, e.compteNum, e.compteLib, Number(e.credit), Number(e.debit)]));
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: annulation.body.avoir.id } })).ecrituresScellees, true);
    });

    test('sérialise émission et remappage du journal par verrou comptable commun', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST concurrence règles', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST verrou comptable', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201);
      const ancienJournal = (await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'JOURNAL_VENTES' } })).journal;
      const clientCompteId = (await prisma.regleComptable.findUniqueOrThrow({ where: { cle: 'CLIENT' } })).compteId;
      const tvaCompteId = (await prisma.regleTvaComptable.findUniqueOrThrow({ where: { taux: 20 } })).compteId;
      const [versionJournal, versionClient, versionTva20] = await Promise.all([versionRegle('JOURNAL_VENTES'), versionRegle('CLIENT'), versionTva(20)]);
      let course;
      try {
        await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(814086)::text`;
          const emission = request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`).then(r => r);
          const remappage = request(app).put('/api/comptabilite/regles/JOURNAL_VENTES').set('Authorization', `Bearer ${session}`).send({ ...versionJournal, motif: 'Révision de règle comptable testée', journal: 'NOUVEAU' }).then(r => r);
          const regleClient = request(app).put('/api/comptabilite/regles/CLIENT').set('Authorization', `Bearer ${session}`).send({ ...versionClient, motif: 'Révision de règle comptable testée', compteId: clientCompteId }).then(r => r);
          const regleTva = request(app).put('/api/comptabilite/tva/20').set('Authorization', `Bearer ${session}`).send({ ...versionTva20, motif: 'Révision de règle comptable testée', compteId: tvaCompteId }).then(r => r);
          course = Promise.all([emission, remappage, regleClient, regleTva]);
          const attendre = p => Promise.race([p.then(() => 'TERMINE'), new Promise(resolve => setTimeout(() => resolve('EN_ATTENTE'), 150))]);
          for (const operation of [emission, remappage, regleClient, regleTva]) assert.equal(await attendre(operation), 'EN_ATTENTE', 'toutes les mutations et l’émission attendent le verrou comptable');
        });
        const [emission, remappage, client, tva] = await course;
        assert.equal(client.status, 409, JSON.stringify(client.body));
        assert.equal(tva.status, 409, JSON.stringify(tva.body));
        assert.equal(emission.status, 200, JSON.stringify(emission.body));
        assert.equal(remappage.status, 200, JSON.stringify(remappage.body));
        const lignes = await prisma.ecritureFacture.findMany({ where: { factureId: brouillon.body.id } });
        assert.equal(new Set(lignes.map(e => e.journalCode)).size, 1);
        assert.ok(['VTE', 'NOUVEAU'].includes(lignes[0].journalCode));
      } finally {
        await regleFixture('JOURNAL_VENTES', ancienJournal);
      }
    });

    test('la base refuse un INSERT tardif et une pièce émise déséquilibrée ou vide', async () => {
      const compte = async (code, nature) => (await prisma.compteComptable.upsert({ where: { code }, create: { code, nature, libelle: `TEST ${code}` }, update: { actif: true } })).id;
      for (const [cle, code, nature] of [['CLIENT', '411000', 'ACTIF'], ['VENTE_PRESTATION', '706100', 'PRODUIT'], ['VENTE_ARTICLE', '706100', 'PRODUIT']]) {
        await regleFixture(cle, await compte(code, nature));
      }
      await regleFixture('JOURNAL_VENTES', 'VTE');
      await tvaFixture(20, await compte('445710', 'TVA'));
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST scellement SQL', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST scellement', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201);
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const original = await prisma.ecritureFacture.findFirstOrThrow({ where: { factureId: brouillon.body.id } });
      const vide = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST pièce sans écritures', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST vide', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(vide.status, 201);
      await assert.rejects(() => prisma.facture.update({ where: { id: vide.body.id }, data: { statut: 'EMISE', numero: `TEST-VIDE-${Date.now()}`, annee: 2026, ecrituresScellees: true } }), /absentes|déséquilibrées/i);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: vide.body.id } })).statut, 'BROUILLON');
      await assert.rejects(() => prisma.facture.update({ where: { id: brouillon.body.id }, data: { ecrituresScellees: false } }), /scellée : retour interdit/i);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: brouillon.body.id } })).ecrituresScellees, true);
      // 0/0 ne change pas l'équilibre : seul le trigger d'insertion interdit cette ligne parasite d'export.
      await assert.rejects(() => prisma.ecritureFacture.create({ data: { factureId: brouillon.body.id, ordre: 98, cle: 'CLIENT', journalCode: original.journalCode, compteNum: original.compteNum, compteLib: original.compteLib, debit: 0, credit: 0 } }), /scellée : insertion interdite/i);
      assert.equal(await prisma.ecritureFacture.count({ where: { factureId: brouillon.body.id } }), 3);
      await assert.rejects(() => prisma.ecritureFacture.create({ data: { factureId: brouillon.body.id, ordre: 99, cle: 'CLIENT', journalCode: original.journalCode, compteNum: original.compteNum, compteLib: original.compteLib, debit: 1, credit: 0 } }), /figée|scellée/i);
      await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" DISABLE TRIGGER "ecriture_facture_immutable"');
      try {
        await assert.rejects(() => prisma.$transaction(async tx => {
          await tx.ecritureFacture.delete({ where: { id: original.id } });
        }), /équilibr|scellée/i);
        assert.equal(await prisma.ecritureFacture.count({ where: { factureId: brouillon.body.id } }), 3);
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "EcritureFacture" ENABLE TRIGGER "ecriture_facture_immutable"');
      }
    });

    test('la base refuse UPDATE et DELETE des écritures émises, y compris après règlement', async () => {
      const facture = await prisma.facture.findFirst({ where: { type: 'FACTURE', statut: 'EMISE', avoirs: { none: {} }, affectationsReglement: { none: {} }, ecrituresComptables: { some: {} }, clientId }, select: { id: true, clientId: true, totalTtc: true, dateEmission: true } });
      assert.ok(facture);
      const ecriture = await prisma.ecritureFacture.findFirstOrThrow({ where: { factureId: facture.id } });
      await assert.rejects(() => prisma.ecritureFacture.update({ where: { id: ecriture.id }, data: { compteLib: 'Réécrit' } }));
      await assert.rejects(() => prisma.ecritureFacture.delete({ where: { id: ecriture.id } }));
      assert.deepEqual(await prisma.ecritureFacture.findUnique({ where: { id: ecriture.id } }), ecriture);
      const reglement = await reglerEnTotalite({ ...facture, totalTtc: Number(facture.totalTtc), dateEmission: facture.dateEmission.toISOString() });
      assert.equal(reglement.status, 201, JSON.stringify(reglement.body));
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: facture.id } })).statut, 'REGLEE');
      await assert.rejects(() => prisma.ecritureFacture.update({ where: { id: ecriture.id }, data: { credit: 1 } }));
    });

    test('émet et exporte une facture entièrement offerte sans écriture déséquilibrée', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST remise totale', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST offerte', quantite: 1, prixUnitaireHt: 0, tauxTva: 0 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const ecritures = await prisma.ecritureFacture.findMany({ where: { factureId: emission.body.id } });
      assert.ok(ecritures.length > 0);
      assert.equal(ecritures.reduce((somme, e) => somme + Number(e.debit) - Number(e.credit), 0), 0);
      assert.equal((await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`)).status, 200);
    });

    test('réserve traçabilité, journal et mentions légales à l’administration', async () => {
      const conducteur = await prisma.user.create({ data: { email: 'phase8bis.conducteur@iris.test', name: 'TEST Conducteur phase8bis', role: 'CONDUCTEUR_TRAVAUX' } });
      const token = jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET);
      const routes = [
        () => request(app).get('/api/factures/inexistante/tracabilite'), () => request(app).get('/api/factures/inexistante/journal'), () => request(app).get('/api/factures/inexistante/document.pdf'), () => request(app).get('/api/mentions-legales'),
        () => request(app).post('/api/mentions-legales').send({ mentions: 'TEST interdit', cgv: 'TEST interdit', penalites: 'TEST interdit' }), () => request(app).post('/api/mentions-legales/1/publier'),
      ];
      for (const route of routes) assert.equal((await route().set('Authorization', `Bearer ${token}`)).status, 403);
      assert.equal(await prisma.mentionsLegalesVersion.count({ where: { mentions: 'TEST interdit' } }), 0);
    });

    test('règle ou annule seulement une facture émise, conserve son contenu et trace la transition', async () => {
      const creerEtEmettre = async (motif) => {
        const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
          clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
          lignes: [{ designation: `TEST ${motif}`, quantite: 2, prixUnitaireHt: 125, tauxTva: 20 }],
        });
        assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
        const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(emission.status, 200, JSON.stringify(emission.body));
        return emission.body;
      };
      const reglee = await creerEtEmettre('règlement');
      const annulee = await creerEtEmettre('annulation');
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'refus statut', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST refus statut', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));

      const reglement = await reglerEnTotalite(reglee);
      assert.equal(reglement.status, 201, JSON.stringify(reglement.body));
      const apresReglement = (await request(app).get('/api/factures').set('Authorization', `Bearer ${session}`)).body.find((facture) => facture.id === reglee.id);
      assert.equal(apresReglement.statut, 'REGLEE');
      assert.deepEqual([apresReglement.totalHt, apresReglement.totalTva, apresReglement.totalTtc, apresReglement.lignes], [reglee.totalHt, reglee.totalTva, reglee.totalTtc, reglee.lignes]);
      const journalReglement = await request(app).get(`/api/factures/${reglee.id}/journal`).set('Authorization', `Bearer ${session}`);
      assert.equal(journalReglement.status, 200, JSON.stringify(journalReglement.body));
      // L'affectation et la transition s'écrivent dans la même transaction : l'ordre de deux
      // entrées au même instant n'est pas garanti, on cherche donc la transition par son action.
      const traceReglement = journalReglement.body.find((entree) => entree.action === 'REGLEMENT');
      assert.ok(traceReglement, JSON.stringify(journalReglement.body));
      assert.ok(traceReglement.acteurId, 'le règlement doit porter son acteur');
      assert.match(traceReglement.detail, /EMISE.*REGLEE/i);

      const annulation = await request(app).post(`/api/factures/${annulee.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      const avoirAnnulation = annulation.body.avoir;
      assert.ok(avoirAnnulation, 'une annulation crée un avoir total');
      assert.equal(avoirAnnulation.type, 'AVOIR');
      assert.equal(avoirAnnulation.factureOrigineId, annulee.id);
      assert.equal(annulation.body.statut, 'ANNULEE');
      assert.deepEqual([annulation.body.totalHt, annulation.body.totalTva, annulation.body.totalTtc, annulation.body.lignes], [annulee.totalHt, annulee.totalTva, annulee.totalTtc, annulee.lignes]);
      const journalAnnulation = await request(app).get(`/api/factures/${annulee.id}/journal`).set('Authorization', `Bearer ${session}`);
      const traceAnnulation = journalAnnulation.body.at(-1);
      assert.equal(traceAnnulation.action, 'ANNULATION');
      assert.ok(traceAnnulation.acteurId, 'l’annulation doit porter son acteur');
      assert.match(traceAnnulation.detail, /EMISE.*ANNULEE/i);
      // Le motif est épinglé : un rejet sans rapport ne doit pas valider le gel SQL.
      for (const id of [reglee.id, annulee.id]) await assert.rejects(() => prisma.facture.update({ where: { id }, data: { motifHorsAffaire: 'TEST modification interdite hors brouillon' } }), /immuables/);

      for (const [id, montant] of [[brouillon.body.id, 1], [reglee.id, 1]]) {
        const refus = await request(app).post('/api/reglements').set('Authorization', `Bearer ${session}`).send({ clientId, dateReglement: '08-09-2026', montant, moyen: 'VIREMENT', affectations: [{ factureId: id, montant }] });
        assert.equal(refus.status, 409, JSON.stringify(refus.body));
        assert.match(refus.body.error, /émise non soldée/i);
      }
      const refusAnnulation = await request(app).post(`/api/factures/${annulee.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(refusAnnulation.status, 409, JSON.stringify(refusAnnulation.body));
      assert.match(refusAnnulation.body.error, /émise/i);
      const documentReglee = await request(app).get(`/api/factures/${reglee.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      const documentAnnulee = await request(app).get(`/api/factures/${annulee.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(documentReglee.status, 200, documentReglee.text);
      assert.equal(documentAnnulee.status, 200, documentAnnulee.text);
      assert.ok(await prisma.facture.findUnique({ where: { id: annulee.id } }), 'une facture annulée demeure conservée');
      const texteDuPdf = async (reponse) => { const lecteur = new PDFParse({ data: reponse.body }); const contenu = await lecteur.getText(); await lecteur.destroy(); return contenu.text; };
      assert.match(await texteDuPdf(documentAnnulee), /FACTURE ANNULÉE/);
      assert.match(await texteDuPdf(documentReglee), /Facture réglée/);
      const pdfEmise = await request(app).get(`/api/factures/${(await creerEtEmettre('témoin émis')).id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.doesNotMatch(await texteDuPdf(pdfEmise), /ANNUL|réglée/i, 'une facture simplement émise ne porte aucune mention post-émission');

      const exportComptable = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportComptable.status, 200, exportComptable.text);
      assert.match(exportComptable.text, new RegExp(reglee.numero));
      const ecrituresFactureAnnulee = exportComptable.text.split('\n').filter((ligne) => ligne.includes(annulee.numero));
      assert.ok(ecrituresFactureAnnulee.some((ligne) => ligne.includes(`\"Facture ${annulee.numero}`)), 'les écritures d’origine restent exportées');
      assert.equal(ecrituresFactureAnnulee.filter((ligne) => ligne.includes(`Annulation facture ${annulee.numero}`)).length, 0, 'un avoir remplace la contre-passation legacy sans doublon');
      const ecrituresAnnulee = exportComptable.text.split('\n').filter((ligne) => ligne.includes(avoirAnnulation.numero));
      assert.ok(ecrituresAnnulee.some((ligne) => ligne.includes(`\"Avoir ${avoirAnnulation.numero}`)), 'l’avoir total est exporté en contre-passation');
      const colonne = (ligne, index) => Number(ligne.split(';')[index].replace(/\"/g, ''));
      const debit = ecrituresAnnulee.reduce((somme, ligne) => somme + colonne(ligne, 6), 0);
      const credit = ecrituresAnnulee.reduce((somme, ligne) => somme + colonne(ligne, 7), 0);
      assert.equal(debit.toFixed(2), credit.toFixed(2), 'un avoir est équilibré dans le journal des ventes');
      assert.ok(debit > 0, 'l’avoir comporte de vraies écritures');
    });

    test('un avoir ne consomme jamais un numéro de la séquence des factures', async () => {
      const emettre = async (motif) => {
        const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: motif, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: `TEST ${motif}`, quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
        assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
        const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(emission.status, 200, JSON.stringify(emission.body));
        return emission.body;
      };
      const annuler = async (facture) => {
        const annulation = await request(app).post(`/api/factures/${facture.id}/annuler`).set('Authorization', `Bearer ${session}`);
        assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
        return annulation.body.avoir;
      };
      const premiere = await emettre('séquence facture première');
      const avoirPremier = await annuler(premiere);
      const seconde = await emettre('séquence facture seconde');
      const avoirSecond = await annuler(seconde);
      try {
        const rang = (numero) => Number(numero.split('-')[1]);
        assert.equal(rang(seconde.numero), rang(premiere.numero) + 1, 'la séquence des factures ignore les avoirs');
        assert.equal(rang(avoirSecond.numero), rang(avoirPremier.numero) + 1, 'la séquence des avoirs progresse indépendamment');
      } finally {
        for (const id of [avoirPremier.id, avoirSecond.id, premiere.id, seconde.id]) {
          await prisma.journalFacture.deleteMany({ where: { factureId: id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: id } });
          await purgerEcrituresJetables(id);
          await prisma.facture.delete({ where: { id } });
        }
      }
    });

    test('deux avoirs partiels concurrents ne se répartissent pas deux fois le même reliquat', async () => {
      // La transaction témoin reproduit l'entrelacement critique sans une course aléatoire :
      // la vraie route est bloquée sur la facture source, puis relit les avoirs après commit.
      // Le numéro est indépendant de sequenceAvoir afin que ce test ne mesure pas un verrou
      // de séquence au lieu du verrou de la facture qui protège le plafond.
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'course deux avoirs', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST course deux avoirs', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const facture = emission.body;
      let reponseAvoir = null;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${facture.id} FOR UPDATE`;
          const concurrent = request(app).post(`/api/factures/${facture.id}/avoirs`).set('Authorization', `Bearer ${session}`)
            .send({ lignes: [{ designation: 'TEST second avoir concurrent', quantite: 1, prixUnitaireHt: 600, tauxTva: 20 }] })
            .then((reponse) => { reponseAvoir = reponse; })
            .catch((erreur) => { reponseAvoir = { status: 'ERREUR', body: { error: String(erreur) } }; });
          void concurrent;
          await new Promise((suite) => setTimeout(suite, 1000));
          const origineEcritures = await tx.ecritureFacture.findMany({ where: { factureId: facture.id }, orderBy: { ordre: 'asc' } });
          const avoirConcurrent = await tx.facture.create({ data: {
            type: 'AVOIR', estAvoirAnnulation: false, factureOrigineId: facture.id, numero: 'AVDOUBLE-COURSE-2026', annee: 2026,
            statut: 'EMISE', dateEmission: new Date('2026-09-08T00:00:00.000Z'), dateEcheance: new Date('2026-09-08T00:00:00.000Z'),
            clientId: facture.clientId, clientRaisonSociale: facture.clientRaisonSociale, clientAdresse: facture.clientAdresse,
            origine: facture.origine, motifHorsAffaire: facture.motifHorsAffaire, mentionsLegalesVersionId: facture.mentionsLegalesVersion.id,
            totalHt: 600, totalTva: 120, totalTtc: 720,
            lignes: { create: [{ ordre: 0, designation: 'TEST premier avoir concurrent', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 600, tauxTva: 20, totalHt: 600, totalTtc: 720 }] },
            ecrituresComptables: { create: origineEcritures.map(e => ({ ordre: e.ordre, cle: e.cle, tauxTva: e.tauxTva, journalCode: e.journalCode, compteNum: e.compteNum, compteLib: e.compteLib, debit: Number(e.credit) * 0.6, credit: Number(e.debit) * 0.6 })) },
          }, select: { id: true } });
          await tx.facture.update({ where: { id: avoirConcurrent.id }, data: { ecrituresScellees: true } });
        }, { timeout: 20000 });
        for (let attente = 0; attente < 60 && !reponseAvoir; attente += 1) await new Promise((suite) => setTimeout(suite, 250));
        assert.ok(reponseAvoir, 'POST /avoirs n’a pas répondu');
        assert.equal(reponseAvoir.status, 409, `le second avoir devait être refusé : ${JSON.stringify(reponseAvoir.body)}`);
        const credites = await prisma.facture.findMany({ where: { factureOrigineId: facture.id }, select: { totalHt: true } });
        assert.equal(credites.reduce((somme, avoir) => somme + Number(avoir.totalHt), 0), 600, 'un seul des deux avoirs de 600 € est retenu');
      } finally {
        const avoirs = await prisma.facture.findMany({ where: { factureOrigineId: facture.id }, select: { id: true } });
        for (const { id } of avoirs) {
          await prisma.journalFacture.deleteMany({ where: { factureId: id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: id } });
          await purgerEcrituresJetables(id);
          await prisma.facture.delete({ where: { id } });
        }
        await prisma.journalFacture.deleteMany({ where: { factureId: facture.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: facture.id } });
        await purgerEcrituresJetables(facture.id);
        await prisma.facture.deleteMany({ where: { id: facture.id } });
      }
    });

    test('une annulation concurrente ne passe pas par-dessus un avoir partiel', async () => {
      // Même entrelacement déterministe : /annuler doit attendre le verrou de la facture,
      // relire l'avoir partiel créé pendant son attente et expliquer son refus métier.
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'course avoir partiel', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST course avoir', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const facture = emission.body;
      let reponseAnnulation = null;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "Facture" WHERE "id" = ${facture.id} FOR UPDATE`;
          const concurrent = request(app).post(`/api/factures/${facture.id}/annuler`).set('Authorization', `Bearer ${session}`)
            .then((reponse) => { reponseAnnulation = reponse; })
            .catch((erreur) => { reponseAnnulation = { status: 'ERREUR', body: { error: String(erreur) } }; });
          void concurrent;
          await new Promise((suite) => setTimeout(suite, 1000));
          const origineEcritures = await tx.ecritureFacture.findMany({ where: { factureId: facture.id }, orderBy: { ordre: 'asc' } });
          const avoirConcurrent = await tx.facture.create({ data: {
            type: 'AVOIR', estAvoirAnnulation: false, factureOrigineId: facture.id, numero: 'AVCOURSE-PARTIEL-2026', annee: 2026,
            statut: 'EMISE', dateEmission: new Date('2026-09-08T00:00:00.000Z'), dateEcheance: new Date('2026-09-08T00:00:00.000Z'),
            clientId: facture.clientId, clientRaisonSociale: facture.clientRaisonSociale, clientAdresse: facture.clientAdresse,
            origine: facture.origine, motifHorsAffaire: facture.motifHorsAffaire, mentionsLegalesVersionId: facture.mentionsLegalesVersion.id,
            totalHt: 600, totalTva: 120, totalTtc: 720,
            lignes: { create: [{ ordre: 0, designation: 'TEST avoir partiel concurrent', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 600, tauxTva: 20, totalHt: 600, totalTtc: 720 }] },
            ecrituresComptables: { create: origineEcritures.map(e => ({ ordre: e.ordre, cle: e.cle, tauxTva: e.tauxTva, journalCode: e.journalCode, compteNum: e.compteNum, compteLib: e.compteLib, debit: Number(e.credit) * 0.6, credit: Number(e.debit) * 0.6 })) },
          } });
          await tx.facture.update({ where: { id: avoirConcurrent.id }, data: { ecrituresScellees: true } });
        }, { timeout: 20000 });
        for (let attente = 0; attente < 60 && !reponseAnnulation; attente += 1) await new Promise((suite) => setTimeout(suite, 250));
        assert.ok(reponseAnnulation, 'POST /annuler n’a pas répondu');
        assert.equal(reponseAnnulation.status, 409, `l’annulation devait être refusée : ${JSON.stringify(reponseAnnulation.body)}`);
        assert.match(reponseAnnulation.body.error, /avoirs partiels/i, 'le refus doit nommer sa vraie raison');
        const credites = await prisma.facture.findMany({ where: { factureOrigineId: facture.id }, select: { totalHt: true } });
        assert.equal(credites.reduce((somme, avoir) => somme + Number(avoir.totalHt), 0), 600, 'le plafond de 1 000 € n’est jamais dépassé');
      } finally {
        const avoirs = await prisma.facture.findMany({ where: { factureOrigineId: facture.id }, select: { id: true } });
        for (const { id } of avoirs) {
          await prisma.journalFacture.deleteMany({ where: { factureId: id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: id } });
          await purgerEcrituresJetables(id);
          await prisma.facture.delete({ where: { id } });
        }
        await prisma.journalFacture.deleteMany({ where: { factureId: facture.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: facture.id } });
        await purgerEcrituresJetables(facture.id);
        await prisma.facture.deleteMany({ where: { id: facture.id } });
      }
    });

    test('annule atomiquement une facture en créant un avoir total numéroté séparément', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Avoir total transactionnel', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [
          { designation: 'TEST avoir prestation', nature: 'PRESTATION', quantite: 2, prixUnitaireHt: 100, tauxTva: 20 },
          { designation: 'TEST avoir article', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 50, tauxTva: 20 },
        ],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const annulation = await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      assert.equal(annulation.body.statut, 'ANNULEE');
      assert.ok(annulation.body.avoir, 'l’annulation doit retourner l’avoir créé dans la même transaction');
      const avoir = annulation.body.avoir;
      assert.equal(avoir.type, 'AVOIR');
      assert.match(avoir.numero, /^A\d{4}-\d{4}$/);
      assert.equal(avoir.factureOrigineId, emission.body.id);
      assert.deepEqual([avoir.totalHt, avoir.totalTva, avoir.totalTtc], [emission.body.totalHt, emission.body.totalTva, emission.body.totalTtc], 'les montants d’un avoir sont stockés positifs');
      assert.deepEqual(avoir.lignes.map((ligne) => ({ designation: ligne.designation, nature: ligne.nature, quantite: ligne.quantite, prixUnitaireHt: ligne.prixUnitaireHt, tauxTva: ligne.tauxTva })), emission.body.lignes.map((ligne) => ({ designation: ligne.designation, nature: ligne.nature, quantite: ligne.quantite, prixUnitaireHt: ligne.prixUnitaireHt, tauxTva: ligne.tauxTva })));
      const journal = await request(app).get(`/api/factures/${emission.body.id}/journal`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body.at(-1).action, 'ANNULATION');
      assert.match(journal.body.at(-1).detail, new RegExp(avoir.numero));
      const documentAvoir = await request(app).get(`/api/factures/${avoir.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(documentAvoir.status, 200, documentAvoir.text);
      const lecteur = new PDFParse({ data: documentAvoir.body }); const contenu = await lecteur.getText(); await lecteur.destroy();
      assert.match(contenu.text, new RegExp(`AVOIR ${avoir.numero}`));
      assert.match(contenu.text, new RegExp(`Facture d’origine : ${emission.body.numero}`));
      const exportComptable = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportComptable.status, 200, exportComptable.text);
      const lignesAvoir = exportComptable.text.split('\n').filter((ligne) => ligne.includes(avoir.numero));
      assert.ok(lignesAvoir.length > 0, 'l’avoir est exporté');
      const montant = (ligne, index) => Number(ligne.split(';')[index].replace(/"/g, ''));
      assert.ok(lignesAvoir.some((ligne) => montant(ligne, 6) > 0 && /Vente|TVA/.test(ligne)), 'l’avoir contre-passe les produits et la TVA');
      assert.ok(lignesAvoir.some((ligne) => montant(ligne, 7) > 0 && /Clients/.test(ligne)), 'l’avoir crédite le client');
    });

    test('crée plusieurs avoirs partiels positifs, figés et plafonnés par taux de TVA', async () => {
      await configurerTva55();
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Avoirs partiels multi taux', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [
          { designation: 'TEST source vingt', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 },
          { designation: 'TEST source cinq', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 100, tauxTva: 5.5 },
        ],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const compteTva = await prisma.compteComptable.findUnique({ where: { code: '445710' } });
      assert.ok(compteTva, 'le compte TVA de test existe');
      await tvaFixture(5.5, compteTva.id);
      try {
      const creer = (lignes) => request(app).post(`/api/factures/${emission.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes });

      const premier = await creer([{ designation: 'TEST geste commercial 20', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 40, tauxTva: 20 }]);
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      assert.equal(premier.body.type, 'AVOIR'); assert.equal(premier.body.statut, 'EMISE');
      assert.equal(premier.body.factureOrigineId, emission.body.id); assert.equal(premier.body.estAvoirAnnulation, false);
      assert.deepEqual([premier.body.totalHt, premier.body.totalTva, premier.body.totalTtc], [40, 8, 48]);
      assert.match(premier.body.numero, /^A\d{4}-\d{4}$/);
      assert.equal(premier.body.clientRaisonSociale, emission.body.clientRaisonSociale);
      assert.equal(premier.body.clientAdresse, emission.body.clientAdresse);
      assert.equal(premier.body.mentionsLegalesVersion.id, emission.body.mentionsLegalesVersion.id);

      const tauxInconnu = await creer([{ designation: 'TEST taux interdit', quantite: 1, prixUnitaireHt: 1, tauxTva: 10 }]);
      assert.equal(tauxInconnu.status, 400, JSON.stringify(tauxInconnu.body));
      assert.match(tauxInconnu.body.error, /taux de TVA.*origine/i);
      const depassementTaux = await creer([{ designation: 'TEST dépassement vingt', quantite: 1, prixUnitaireHt: 61, tauxTva: 20 }]);
      assert.equal(depassementTaux.status, 409, JSON.stringify(depassementTaux.body));
      assert.match(depassementTaux.body.error, /plafond.*TVA|créditer/i);

      const second = await creer([{ designation: 'TEST reliquat vingt', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 60, tauxTva: 20 }]);
      assert.equal(second.status, 201, JSON.stringify(second.body)); assert.equal(second.body.totalTtc, 72);
      const depassementTotal = await creer([{ designation: 'TEST dépassement total', quantite: 1, prixUnitaireHt: 0.01, tauxTva: 20 }]);
      assert.equal(depassementTotal.status, 409, JSON.stringify(depassementTotal.body));

      const reglee = await reglerEnTotalite(emission.body, await resteDuFacture(emission.body.id));
      assert.equal(reglee.status, 201, JSON.stringify(reglee.body));
      const troisieme = await creer([{ designation: 'TEST avoir cinq', nature: 'ARTICLE', quantite: 1, prixUnitaireHt: 100, tauxTva: 5.5 }]);
      assert.equal(troisieme.status, 201, JSON.stringify(troisieme.body));
      assert.deepEqual([troisieme.body.totalHt, troisieme.body.totalTva, troisieme.body.totalTtc], [100, 5.5, 105.5]);

      const annulation = await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 409, JSON.stringify(annulation.body));
      // Un avoir partiel ne crédite que la facture source, émise ou réglée : créditer un
      // brouillon contournerait l'absence de numéro légal, créditer un avoir créerait une
      // chaîne d'avoirs sans document source légitime.
      const surAvoir = await request(app).post(`/api/factures/${premier.body.id}/avoirs`).set('Authorization', `Bearer ${session}`)
        .send({ lignes: [{ designation: 'TEST avoir sur avoir', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }] });
      assert.equal(surAvoir.status, 409, JSON.stringify(surAvoir.body));
      const jamaisEmise = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'brouillon non créditable', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST brouillon non créditable', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }],
      });
      assert.equal(jamaisEmise.status, 201, JSON.stringify(jamaisEmise.body));
      const surBrouillon = await request(app).post(`/api/factures/${jamaisEmise.body.id}/avoirs`).set('Authorization', `Bearer ${session}`)
        .send({ lignes: [{ designation: 'TEST avoir sur brouillon', quantite: 1, prixUnitaireHt: 1, tauxTva: 20 }] });
      assert.equal(surBrouillon.status, 409, JSON.stringify(surBrouillon.body));
      const pdf = await request(app).get(`/api/factures/${premier.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(pdf.status, 200, pdf.text);
      const lecteur = new PDFParse({ data: pdf.body }); const contenu = await lecteur.getText(); await lecteur.destroy();
      assert.match(contenu.text, new RegExp(`AVOIR ${premier.body.numero}`));
      assert.match(contenu.text, new RegExp(`Facture d’origine : ${emission.body.numero}`));
      const exportation = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportation.status, 200, exportation.text);
      assert.match(exportation.text, new RegExp(`Avoir ${premier.body.numero}`));
      } finally {
      await retirerTvaFixture(5.5);
      }
    });

    test('fige la TVA cumulée des avoirs fractionnés à 5,5 % dans le PDF et l’export', async () => {
      await configurerTva55();
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Arrondi cumulatif avoir 5,5', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [
          { designation: 'TEST source 5,5 premier', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 9, tauxTva: 5.5 },
          { designation: 'TEST source 5,5 second', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 9, tauxTva: 5.5 },
        ],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      assert.deepEqual([brouillon.body.totalHt, brouillon.body.totalTva, brouillon.body.totalTtc], [18, 0.99, 18.99]);
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const compteTva = await prisma.compteComptable.findUnique({ where: { code: '445710' } });
      assert.ok(compteTva, 'le compte TVA de test existe');
      await tvaFixture(5.5, compteTva.id);

      const creer = () => request(app).post(`/api/factures/${emission.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({
        lignes: [{ designation: 'TEST avoir fractionné 5,5', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 9, tauxTva: 5.5 }],
      });
      const premier = await creer();
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      assert.deepEqual([premier.body.totalHt, premier.body.totalTva, premier.body.totalTtc], [9, 0.5, 9.5]);
      assert.deepEqual(premier.body.ventilationTva.map(({ tauxTva, totalHt, totalTva, totalTtc }) => ({ tauxTva, totalHt, totalTva, totalTtc })), [{ tauxTva: 5.5, totalHt: 9, totalTva: 0.5, totalTtc: 9.5 }]);

      const second = await creer();
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.deepEqual([second.body.totalHt, second.body.totalTva, second.body.totalTtc], [9, 0.49, 9.49]);
      assert.deepEqual(second.body.ventilationTva.map(({ tauxTva, totalHt, totalTva, totalTtc }) => ({ tauxTva, totalHt, totalTva, totalTtc })), [{ tauxTva: 5.5, totalHt: 9, totalTva: 0.49, totalTtc: 9.49 }]);
      const ventilationFigee = await prisma.factureVentilationTva.findUniqueOrThrow({ where: { factureId_tauxTva: { factureId: second.body.id, tauxTva: 5.5 } } });
      await assert.rejects(() => prisma.factureVentilationTva.update({ where: { id: ventilationFigee.id }, data: { totalTva: 0.5 } }), /immuable/);
      const depassement = await request(app).post(`/api/factures/${emission.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({
        lignes: [{ designation: 'TEST dépassement fractionné', nature: 'PRESTATION', quantite: 1, prixUnitaireHt: 0.01, tauxTva: 5.5 }],
      });
      assert.equal(depassement.status, 409, JSON.stringify(depassement.body));

      const texteDuPdf = async (reponse) => { const lecteur = new PDFParse({ data: reponse.body }); const contenu = await lecteur.getText(); await lecteur.destroy(); return contenu.text; };
      const pdfSecond = await request(app).get(`/api/factures/${second.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(pdfSecond.status, 200, pdfSecond.text);
      assert.match(await texteDuPdf(pdfSecond), /TVA 5\.5 % sur 9,00 € : 0,49 €/);

      const exportation = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      assert.equal(exportation.status, 200, exportation.text);
      const lignesSecond = exportation.text.split('\n').filter((ligne) => ligne.includes(second.body.numero));
      const montant = (ligne, index) => Number(ligne.split(';')[index].replace(/\"/g, ''));
      assert.ok(lignesSecond.some((ligne) => /TVA/.test(ligne) && montant(ligne, 6) === 0.49), 'la TVA figée à 0,49 € est contre-passée');
      assert.equal(lignesSecond.reduce((somme, ligne) => somme + montant(ligne, 6), 0).toFixed(2), lignesSecond.reduce((somme, ligne) => somme + montant(ligne, 7), 0).toFixed(2), 'l’export du second avoir est équilibré');
    });

    test('une facture ne quitte pas sa fiche affaire en changeant de statut', async () => {
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Affaire suivie', client: 'TEST Client contrat maintenance', clientId, dateDebut: new Date('2026-09-01T00:00:00.000Z'), statut: 'EN_COURS', budgetGlobalVendu: 10000 } });
      const emettreSurAffaire = async (motif) => {
        const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: `TEST ${motif}`, quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] });
        assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
        const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(emission.status, 200, JSON.stringify(emission.body));
        return emission.body;
      };
      const fiche = async () => (await request(app).get(`/api/chantiers/${chantier.id}`).set('Authorization', `Bearer ${session}`)).body.facturation;
      const aRegler = await emettreSurAffaire('affaire réglée');
      const aAnnuler = await emettreSurAffaire('affaire annulée');
      assert.equal((await fiche()).totalFactureHt, 2000);
      assert.equal((await reglerEnTotalite(aRegler)).status, 201);
      const apresReglement = await fiche();
      assert.equal(apresReglement.totalFactureHt, 2000);
      assert.equal(apresReglement.resteAFacturerHt, 8000);
      assert.deepEqual(apresReglement.factures.map((facture) => facture.statut).sort(), ['EMISE', 'REGLEE']);
      assert.equal((await request(app).post(`/api/factures/${aAnnuler.id}/annuler`).set('Authorization', `Bearer ${session}`)).status, 200);
      const apresAnnulation = await fiche();
      assert.equal(apresAnnulation.totalFactureHt, 1000);
      assert.equal(apresAnnulation.resteAFacturerHt, 9000);
      assert.deepEqual(apresAnnulation.factures.map((facture) => [facture.type, facture.statut]).sort(), [['AVOIR', 'EMISE'], ['FACTURE', 'ANNULEE'], ['FACTURE', 'REGLEE']]);
      assert.ok(apresAnnulation.factures.every((facture) => facture.numero), 'chaque facture de la fiche porte son numéro légal');
    });

    test('le contrôle TVA des prérequis couvre les futures émissions sans bloquer l’export historique', async () => {
      await configurerTva55();
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'taux annulé non couvert', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST taux annulé', quantite: 1, prixUnitaireHt: 100, tauxTva: 5.5 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      assert.equal((await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`)).status, 200);
      await retirerTvaFixture(5.5);
      try {
        const exportation = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
        assert.equal(exportation.status, 200, exportation.text);
        const prerequis = await request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
        const tva = prerequis.body.controles.find((controle) => controle.cle === 'TVA');
        assert.equal(tva.pret, false);
        assert.equal(tva.bloquant, true);
        assert.match(tva.detail, /5\.5 %/);
      } finally {
        const avoir = await prisma.facture.findFirst({ where: { factureOrigineId: emission.body.id }, select: { id: true } });
        if (avoir) {
          await prisma.journalFacture.deleteMany({ where: { factureId: avoir.id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: avoir.id } });
          await purgerEcrituresJetables(avoir.id);
          await prisma.facture.delete({ where: { id: avoir.id } });
        }
        await prisma.journalFacture.deleteMany({ where: { factureId: emission.body.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: emission.body.id } });
        await purgerEcrituresJetables(emission.body.id);
        await prisma.facture.delete({ where: { id: emission.body.id } });
      }
    });

    // Le pendant du test suivant : une date-seule ne bouge JAMAIS, quel que soit le fuseau
    // de la société. Sans cette garde, relire `dateEmission` comme un instant passe
    // inaperçu — à l'ouest de Greenwich l'avoir s'exporterait la veille de son émission.
    test('l’export ne déplace jamais la date d’émission d’un avoir', async () => {
      const compteTva = await prisma.compteComptable.findUnique({ where: { code: '445710' } });
      assert.ok(compteTva, 'le compte TVA de test existe');
      // Le compte du taux 5,5 permet l'émission de la source ; son export ultérieur
      // ne dépend plus de cette règle vivante, contrairement aux futures émissions.
      await tvaFixture(5.5, compteTva.id);
      // La numérotation est chronologique : on émet au jour de la dernière facture numérotée
      // plutôt qu'à une date fixe, sinon ce test dépendrait de son rang dans la suite.
      const derniere = await prisma.facture.findFirst({ where: { numero: { not: null } }, orderBy: { dateEmission: 'desc' }, select: { dateEmission: true } });
      const jour = derniere ? derniere.dateEmission : new Date('2026-09-09T00:00:00.000Z');
      const jourFrancais = `${String(jour.getUTCDate()).padStart(2, '0')}-${String(jour.getUTCMonth() + 1).padStart(2, '0')}-${jour.getUTCFullYear()}`;
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'date-seule immobile', dateEmission: jourFrancais, dateEcheance: jourFrancais, lignes: [{ designation: 'TEST date-seule', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const annulation = await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      const avoir = annulation.body.avoir;
      const jourAttendu = avoir.dateEmission.slice(0, 10).replace(/-/g, '');
      const datesDeLAvoir = async () => {
        const csv = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
        assert.equal(csv.status, 200, csv.text);
        const lignes = csv.text.split('\n').filter((ligne) => ligne.includes(avoir.numero) && ligne.includes(`Avoir ${avoir.numero}`));
        assert.ok(lignes.length, 'aucune écriture d’avoir dans l’export');
        return [...new Set(lignes.map((ligne) => ligne.split(';')[1].replace(/"/g, '')))];
      };
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      try {
        // Nouméa (UTC+11) et Gambier (UTC−9) encadrent l'écart maximal des territoires
        // français : si la date-seule bougeait, l'un des deux la décalerait d'un jour.
        for (const fuseau of ['Europe/Paris', 'Pacific/Noumea', 'America/Martinique', 'Pacific/Gambier']) {
          assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseau })).status, 200);
          assert.deepEqual(await datesDeLAvoir(), [jourAttendu], `la date d’émission de l’avoir reste une date-seule en ${fuseau}`);
        }
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        await prisma.journalFacture.deleteMany({ where: { factureId: avoir.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: avoir.id } });
        await purgerEcrituresJetables(avoir.id);
        await prisma.facture.delete({ where: { id: avoir.id } });
        await prisma.journalFacture.deleteMany({ where: { factureId: emission.body.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: emission.body.id } });
        await purgerEcrituresJetables(emission.body.id);
        await prisma.facture.delete({ where: { id: emission.body.id } });
      }
    });

    test('l’export date la contre-passation legacy dans le fuseau de la société', async () => {
      const compteTva = await prisma.compteComptable.findUnique({ where: { code: '445710' } });
      assert.ok(compteTva, 'le compte TVA de test existe');
      await tvaFixture(5.5, compteTva.id);
      const derniereFacture = await prisma.facture.findFirst({ where: { type: 'FACTURE', numero: { not: null } }, orderBy: { dateEmission: 'desc' }, select: { dateEmission: true } });
      const datePiece = derniereFacture?.dateEmission || new Date('2026-09-09T00:00:00.000Z');
      const jourPiece = `${String(datePiece.getUTCDate()).padStart(2, '0')}-${String(datePiece.getUTCMonth() + 1).padStart(2, '0')}-${datePiece.getUTCFullYear()}`;
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'bascule de jour civil', dateEmission: jourPiece, dateEcheance: jourPiece, lignes: [{ designation: 'TEST bascule exercice', quantite: 1, prixUnitaireHt: 1000, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const annulation = await request(app).post(`/api/factures/${emission.body.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(annulation.status, 200, JSON.stringify(annulation.body));
      // Retire l'avoir pour exercer le chemin historique de contre-passation, pas son
      // remplacement moderne. L'instant est volontairement à cheval sur le nouvel an.
      const avoir = annulation.body.avoir;
      await prisma.journalFacture.deleteMany({ where: { factureId: avoir.id } });
      await prisma.factureLigne.deleteMany({ where: { factureId: avoir.id } });
      await purgerEcrituresJetables(avoir.id);
      await prisma.facture.delete({ where: { id: avoir.id } });
      await prisma.journalFacture.updateMany({ where: { factureId: emission.body.id, action: 'ANNULATION' }, data: { createdAt: new Date('2027-01-01T00:30:00.000Z') } });
      const jourComptable = async () => {
        const csv = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
        assert.equal(csv.status, 200, csv.text);
        const lignes = csv.text.split('\n').filter((ligne) => ligne.includes(emission.body.numero) && ligne.includes(`Annulation facture ${emission.body.numero}`));
        assert.ok(lignes.length, 'aucune contre-passation legacy dans l’export');
        return [...new Set(lignes.map((ligne) => ligne.split(';')[1].replace(/"/g, '')))];
      };
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      try {
        for (const [fuseau, jourAttendu] of [['Europe/Paris', '20270101'], ['Pacific/Noumea', '20270101'], ['America/Martinique', '20261231'], ['Pacific/Gambier', '20261231']]) {
          assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseau })).status, 200);
          assert.deepEqual(await jourComptable(), [jourAttendu], `la contre-passation suit l’instant dans ${fuseau}`);
        }
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        const avoir = await prisma.facture.findFirst({ where: { factureOrigineId: emission.body.id }, select: { id: true } });
        if (avoir) {
          await prisma.journalFacture.deleteMany({ where: { factureId: avoir.id } });
          await prisma.factureLigne.deleteMany({ where: { factureId: avoir.id } });
          await purgerEcrituresJetables(avoir.id);
          await prisma.facture.delete({ where: { id: avoir.id } });
        }
        await prisma.journalFacture.deleteMany({ where: { factureId: emission.body.id } });
        await prisma.factureLigne.deleteMany({ where: { factureId: emission.body.id } });
        await purgerEcrituresJetables(emission.body.id);
        await prisma.facture.delete({ where: { id: emission.body.id } });
      }
    });

    test('refuse une version légale incomplète', async () => {
      for (const corps of [{ cgv: 'TEST cgv', penalites: 'TEST pénalités' }, { mentions: '   ', cgv: 'TEST cgv', penalites: 'TEST pénalités' }]) {
        assert.equal((await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`).send(corps)).status, 400);
      }
    });

    test('n’émet pas sur une version légale restée en brouillon', async () => {
      const actives = await prisma.mentionsLegalesVersion.findMany({ where: { actif: true } });
      await prisma.mentionsLegalesVersion.updateMany({ where: { actif: true }, data: { actif: false } });
      const brouillon = await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`).send({ mentions: 'TEST brouillon', cgv: 'TEST brouillon', penalites: 'TEST brouillon' });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST brouillon légal', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST brouillon légal', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201); assert.equal((await request(app).post(`/api/factures/${facture.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 409);
      await prisma.mentionsLegalesVersion.delete({ where: { id: brouillon.body.id } });
      for (const active of actives) await prisma.mentionsLegalesVersion.update({ where: { id: active.id }, data: { actif: true } });
    });

    test('ne divulgue pas la facturation d’une affaire à qui ne voit pas la marge', async () => {
      const commercial = await prisma.user.create({ data: { email: 'phase8bis.commercial@iris.test', name: 'TEST Commercial phase8bis', role: 'COMMERCIAL' } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Affaire facturée', client: 'TEST Client contrat maintenance', clientId, dateDebut: new Date(), budgetGlobalVendu: 50000, commercialId: commercial.id } });
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: chantier.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST facturation affaire', quantite: 1, prixUnitaireHt: 12345.67, tauxTva: 20 }] });
      assert.equal((await request(app).post(`/api/factures/${facture.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const vueCommercial = await request(app).get(`/api/chantiers/${chantier.id}`).set('Authorization', `Bearer ${jwt.sign({ id: commercial.id }, process.env.JWT_SECRET)}`);
      assert.equal(vueCommercial.status, 200); assert.equal(vueCommercial.body.facturation, undefined); assert.equal(vueCommercial.body.factures, undefined);
      assert.equal(/12345\.67|14814\.8/.test(JSON.stringify(vueCommercial.body)), false);
    });

    test('répare le client d’une affaire héritée mais le fige après facturation', async () => {
      const orpheline = await prisma.chantier.create({ data: { nom: 'TEST Affaire héritée', client: 'TEST Libellé libre', dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const avantReparation = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: orpheline.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST affaire non rattachée', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(avantReparation.status, 404);
      assert.equal((await request(app).patch(`/api/chantiers/${orpheline.id}`).set('Authorization', `Bearer ${session}`).send({ clientId })).status, 200);
      // La réparation lie la fiche client sans réécrire le libellé historique.
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: orpheline.id } })).client, 'TEST Libellé libre');
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'CHANTIER', chantierId: orpheline.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST affaire réparée', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(facture.status, 201); assert.equal((await request(app).post(`/api/factures/${facture.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const autre = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client déplacement' });
      assert.equal((await request(app).patch(`/api/chantiers/${orpheline.id}`).set('Authorization', `Bearer ${session}`).send({ clientId: autre.body.id })).status, 409);
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: orpheline.id } })).client, 'TEST Libellé libre');
      // Le client renvoyé à l'identique n'est pas un changement : la fiche facturée reste modifiable.
      const identique = await request(app).patch(`/api/chantiers/${orpheline.id}`).set('Authorization', `Bearer ${session}`).send({ clientId, nom: 'TEST Affaire héritée renommée' });
      assert.equal(identique.status, 200, JSON.stringify(identique.body));
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: orpheline.id } })).nom, 'TEST Affaire héritée renommée');
    });

    test('une réaffectation reprend la raison sociale du nouveau client, et le SAV suit (décision du 16-10-2026)', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const ancien = await prisma.client.create({ data: { raisonSociale: 'TEST Libellé client ancien' } });
      const nouveau = await prisma.client.create({ data: { raisonSociale: 'TEST Libellé client nouveau' } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Libellé réaffectation', client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      // Avant : le SAV du nouveau client ne peut pas viser ce chantier, lié à l'ancien client.
      const avant = await request(app).post('/api/interventions').set(auth).send({ clientId: nouveau.id, chantierId: chantier.id, titre: 'TEST Libellé SAV avant réaffectation' });
      assert.equal(avant.status, 404, JSON.stringify(avant.body));
      const reaffectation = await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: nouveau.id });
      assert.equal(reaffectation.status, 200, JSON.stringify(reaffectation.body));
      assert.equal(reaffectation.body.client, nouveau.raisonSociale);
      assert.deepEqual(await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id }, select: { client: true, clientId: true } }), { client: nouveau.raisonSociale, clientId: nouveau.id });
      // Après : le SAV du nouveau client s'y rattache, celui de l'ancien plus.
      const apres = await request(app).post('/api/interventions').set(auth).send({ clientId: nouveau.id, chantierId: chantier.id, titre: 'TEST Libellé SAV après réaffectation' });
      assert.equal(apres.status, 201, JSON.stringify(apres.body));
      assert.equal(apres.body.chantierId, chantier.id);
      const ancienSav = await request(app).post('/api/interventions').set(auth).send({ clientId: ancien.id, chantierId: chantier.id, titre: 'TEST Libellé SAV ancien client' });
      assert.equal(ancienSav.status, 404, JSON.stringify(ancienSav.body));
      // Un client renvoyé à l'identique ne réécrit pas le libellé, même s'il diffère de la fiche.
      await prisma.chantier.update({ where: { id: chantier.id }, data: { client: 'TEST Libellé saisi à la main' } });
      const identique = await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: nouveau.id, nom: 'TEST Libellé réaffectation renommée' });
      assert.equal(identique.status, 200, JSON.stringify(identique.body));
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).client, 'TEST Libellé saisi à la main');
    });

    test('changement de client : refusé tant que des interventions SAV y sont rattachées, et tracé au journal (décisions du 16-10-2026)', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const admin = await prisma.user.findUniqueOrThrow({ where: { id: jwt.verify(session, process.env.JWT_SECRET).id }, select: { id: true, name: true } });
      const ancien = await prisma.client.create({ data: { raisonSociale: 'TEST Trace client ancien' } });
      const nouveau = await prisma.client.create({ data: { raisonSociale: 'TEST Trace client nouveau' } });
      const troisieme = await prisma.client.create({ data: { raisonSociale: 'TEST Trace client troisième' } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST Trace changement de client', client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const journal = async (id = chantier.id) => {
        const reponse = await request(app).get(`/api/chantiers/${id}/journal-saisies`).set(auth);
        assert.equal(reponse.status, 200, JSON.stringify(reponse.body));
        return reponse.body.filter(entree => entree.action === 'CHANGEMENT_CLIENT');
      };
      const enBase = async (id = chantier.id) => prisma.chantier.findUniqueOrThrow({ where: { id }, select: { nom: true, client: true, clientId: true } });

      // Sans intervention, le changement passe et s'écrit au journal : auteur, client avant et après.
      const changement = await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: nouveau.id });
      assert.equal(changement.status, 200, JSON.stringify(changement.body));
      const [trace, ...autres] = await journal();
      assert.equal(autres.length, 0);
      assert.equal(trace.cible, 'CHANTIER');
      assert.equal(trace.cibleId, chantier.id);
      assert.equal(trace.auteurId, admin.id);
      assert.equal(trace.auteurNom, admin.name);
      assert.equal(trace.motif, null);
      assert.deepEqual(trace.avant, { clientId: ancien.id, raisonSociale: ancien.raisonSociale, libelle: ancien.raisonSociale });
      assert.deepEqual(trace.apres, { clientId: nouveau.id, raisonSociale: nouveau.raisonSociale, libelle: nouveau.raisonSociale });

      // Le même client renvoyé, ou un champ client envoyé par le conducteur titulaire (ignoré), ne trace rien.
      assert.equal((await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: nouveau.id, nom: 'TEST Trace renommé' })).status, 200);
      const titulaire = await prisma.user.create({ data: { email: `trace.client.titulaire.${Date.now()}@iris.test`, name: 'TEST Trace conducteur titulaire', role: 'CONDUCTEUR_TRAVAUX' } });
      await prisma.chantier.update({ where: { id: chantier.id }, data: { responsableId: titulaire.id } });
      const parTitulaire = await request(app).patch(`/api/chantiers/${chantier.id}`).set('Authorization', `Bearer ${jwt.sign({ id: titulaire.id }, process.env.JWT_SECRET)}`).send({ clientId: troisieme.id });
      assert.equal(parTitulaire.status, 200, JSON.stringify(parTitulaire.body));
      assert.equal((await journal()).length, 1);
      assert.deepEqual(await enBase(), { nom: 'TEST Trace renommé', client: nouveau.raisonSociale, clientId: nouveau.id });

      // Une intervention SAV rattachée, même annulée, fige le client : refus, rien d'enregistré ni de tracé.
      const sav = await request(app).post('/api/interventions').set(auth).send({ clientId: nouveau.id, chantierId: chantier.id, titre: 'TEST Trace SAV rattaché' });
      assert.equal(sav.status, 201, JSON.stringify(sav.body));
      await prisma.intervention.update({ where: { id: sav.body.id }, data: { statut: 'ANNULEE' } });
      const refus = await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: troisieme.id, nom: 'TEST Trace modification refusée' });
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.equal(refus.body.error, 'Des interventions SAV sont rattachées à cette affaire : elle ne change pas de client.');
      assert.deepEqual(await enBase(), { nom: 'TEST Trace renommé', client: nouveau.raisonSociale, clientId: nouveau.id });
      assert.equal((await journal()).length, 1);
      // Le reste de la fiche, lui, s'enregistre toujours.
      assert.equal((await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: nouveau.id, nom: 'TEST Trace renommé encore' })).status, 200);
      assert.equal((await enBase()).nom, 'TEST Trace renommé encore');

      // Affaire liée portant une intervention d'un ancien client, rattachée avant #142 et #144 :
      // elle ne passe pas non plus à ce client, et rien n'est tracé.
      const liee = await prisma.chantier.create({ data: { nom: 'TEST Trace affaire liée', client: nouveau.raisonSociale, clientId: nouveau.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      await prisma.intervention.create({ data: { reference: `TEST-TRACE-LIEE-${Date.now()}`, titre: 'TEST Trace SAV de l’ancien client', clientId: ancien.id, chantierId: liee.id } });
      const versClientDuSav = await request(app).patch(`/api/chantiers/${liee.id}`).set(auth).send({ clientId: ancien.id });
      assert.equal(versClientDuSav.status, 409, JSON.stringify(versClientDuSav.body));
      assert.equal(versClientDuSav.body.error, 'Des interventions SAV sont rattachées à cette affaire : elle ne change pas de client.');
      assert.deepEqual(await enBase(liee.id), { nom: 'TEST Trace affaire liée', client: nouveau.raisonSociale, clientId: nouveau.id });
      assert.equal((await journal(liee.id)).length, 0);

      // Atomicité : si l'enregistrement échoue après l'écriture de la trace (ici, une contrainte
      // posée pour le test refuse le nouveau nom), ni le changement ni la trace ne restent.
      const atomique = await prisma.chantier.create({ data: { nom: 'TEST Trace atomicité', client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const contrainte = 'test_atomicite_changement_client';
      await prisma.$executeRawUnsafe(`ALTER TABLE "Chantier" DROP CONSTRAINT IF EXISTS "${contrainte}"`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "Chantier" ADD CONSTRAINT "${contrainte}" CHECK ("nom" <> 'TEST Trace nom refusé par la base') NOT VALID`);
      try {
        const echec = await request(app).patch(`/api/chantiers/${atomique.id}`).set(auth).send({ clientId: nouveau.id, nom: 'TEST Trace nom refusé par la base' });
        assert.equal(echec.status, 500, JSON.stringify(echec.body));
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE "Chantier" DROP CONSTRAINT IF EXISTS "${contrainte}"`);
      }
      assert.deepEqual(await enBase(atomique.id), { nom: 'TEST Trace atomicité', client: ancien.raisonSociale, clientId: ancien.id });
      assert.equal((await journal(atomique.id)).length, 0);

      // Affaire héritée sans fiche, portant une intervention d'avant #144 : elle se répare vers le
      // client de cette intervention, jamais vers un autre ; la trace garde le libellé historique.
      const heritee = await prisma.chantier.create({ data: { nom: 'TEST Trace affaire héritée', client: 'TEST Trace libellé historique', dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      await prisma.intervention.create({ data: { reference: `TEST-TRACE-${Date.now()}`, titre: 'TEST Trace SAV hérité', clientId: ancien.id, chantierId: heritee.id } });
      const versAutre = await request(app).patch(`/api/chantiers/${heritee.id}`).set(auth).send({ clientId: troisieme.id });
      assert.equal(versAutre.status, 409, JSON.stringify(versAutre.body));
      assert.equal(versAutre.body.error, 'Des interventions SAV d’un autre client sont rattachées à cette affaire : elle ne peut pas être rattachée à ce client.');
      assert.deepEqual(await enBase(heritee.id), { nom: 'TEST Trace affaire héritée', client: 'TEST Trace libellé historique', clientId: null });
      assert.equal((await journal(heritee.id)).length, 0);
      const reparation = await request(app).patch(`/api/chantiers/${heritee.id}`).set(auth).send({ clientId: ancien.id });
      assert.equal(reparation.status, 200, JSON.stringify(reparation.body));
      assert.deepEqual(await enBase(heritee.id), { nom: 'TEST Trace affaire héritée', client: 'TEST Trace libellé historique', clientId: ancien.id });
      const [traceReparation] = await journal(heritee.id);
      assert.deepEqual(traceReparation.avant, { clientId: null, raisonSociale: null, libelle: 'TEST Trace libellé historique' });
      assert.deepEqual(traceReparation.apres, { clientId: ancien.id, raisonSociale: ancien.raisonSociale, libelle: 'TEST Trace libellé historique' });

      // Le journal suit le périmètre de la fiche : lisible par le titulaire, pas par un autre conducteur.
      const autreConducteur = await prisma.user.create({ data: { email: `trace.client.autre.${Date.now()}@iris.test`, name: 'TEST Trace autre conducteur', role: 'CONDUCTEUR_TRAVAUX' } });
      const vueTitulaire = await request(app).get(`/api/chantiers/${chantier.id}/journal-saisies`).set('Authorization', `Bearer ${jwt.sign({ id: titulaire.id }, process.env.JWT_SECRET)}`);
      assert.equal(vueTitulaire.status, 200);
      assert.deepEqual(vueTitulaire.body.filter(entree => entree.action === 'CHANGEMENT_CLIENT').map(entree => entree.id), [trace.id]);
      assert.equal((await request(app).get(`/api/chantiers/${chantier.id}/journal-saisies`).set('Authorization', `Bearer ${jwt.sign({ id: autreConducteur.id }, process.env.JWT_SECRET)}`)).status, 404);
    });

    test('changement de client, création d’intervention ou de facture et annulation simultanés : l’un attend l’autre, sans rattachement incohérent ni trace', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const ancien = await prisma.client.create({ data: { raisonSociale: 'TEST Course client ancien' } });
      const nouveau = await prisma.client.create({ data: { raisonSociale: 'TEST Course client nouveau' } });
      const attendreVerrou = async (motif) => {
        for (let tour = 0; tour < 150; tour++) {
          const sessions = await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '${motif}'`);
          if (sessions.length) return true;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return false;
      };
      const tenirVerrou = (chantierId, verrou, puis) => {
        let liberer, pret;
        const attente = new Promise(resolve => { liberer = resolve; });
        const verrouPris = new Promise(resolve => { pret = resolve; });
        const transaction = prisma.$transaction(async tx => {
          await tx.$queryRawUnsafe(`SELECT "id" FROM "Chantier" WHERE "id" = $1 ${verrou}`, chantierId);
          pret();
          await attente;
          await puis(tx);
        }, { timeout: 15000 });
        return { verrouPris, liberer, transaction };
      };

      // 1. Un changement de client en cours (ligne verrouillée) : la création d'intervention pour
      //    l'ancien client attend sa fin, puis est refusée, faute de chantier lié à ce client.
      const premier = await prisma.chantier.create({ data: { nom: 'TEST Course création attend', client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const changement = tenirVerrou(premier.id, 'FOR UPDATE', tx => tx.chantier.update({ where: { id: premier.id }, data: { clientId: nouveau.id, client: nouveau.raisonSociale } }));
      await changement.verrouPris;
      let creation;
      try {
        creation = request(app).post('/api/interventions').set(auth).send({ clientId: ancien.id, chantierId: premier.id, titre: 'TEST Course SAV pendant changement' }).then(r => r);
        assert.equal(await attendreVerrou('%"Chantier"%FOR SHARE%'), true, 'la création doit attendre le changement de client');
      } finally {
        changement.liberer();
        await changement.transaction;
      }
      const refusCreation = await creation;
      assert.equal(refusCreation.status, 404, JSON.stringify(refusCreation.body));
      assert.equal(await prisma.intervention.count({ where: { chantierId: premier.id } }), 0);

      // 2. Une création d'intervention en cours (verrou partagé) : le changement de client attend sa
      //    fin, voit l'intervention et refuse, sans rien tracer.
      //    (Le verrou tenu est celui que prend la création : FOR SHARE.)
      const second = await prisma.chantier.create({ data: { nom: 'TEST Course changement attend', client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const creationEnCours = tenirVerrou(second.id, 'FOR SHARE', tx => tx.intervention.create({ data: { reference: `TEST-COURSE-${Date.now()}`, titre: 'TEST Course SAV créé', clientId: ancien.id, chantierId: second.id } }));
      await creationEnCours.verrouPris;
      let modification;
      try {
        modification = request(app).patch(`/api/chantiers/${second.id}`).set(auth).send({ clientId: nouveau.id }).then(r => r);
        assert.equal(await attendreVerrou('%"Chantier"%FOR UPDATE%'), true, 'le changement de client doit attendre la création');
      } finally {
        creationEnCours.liberer();
        await creationEnCours.transaction;
      }
      const refusModification = await modification;
      assert.equal(refusModification.status, 409, JSON.stringify(refusModification.body));
      assert.deepEqual(await prisma.chantier.findUniqueOrThrow({ where: { id: second.id }, select: { client: true, clientId: true } }), { client: ancien.raisonSociale, clientId: ancien.id });
      assert.equal(await prisma.journalSaisieChantier.count({ where: { chantierId: second.id } }), 0);

      // 3. Le même changement fait deux fois en même temps : le second attend le premier, ne trouve
      //    plus rien à changer, et ne réécrit ni le libellé ni le journal.
      const troisiemeChantier = await prisma.chantier.create({ data: { nom: 'TEST Course changement en double', client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const premierChangement = tenirVerrou(troisiemeChantier.id, 'FOR UPDATE', tx => tx.chantier.update({ where: { id: troisiemeChantier.id }, data: { clientId: nouveau.id, client: 'TEST Course libellé du premier changement' } }));
      await premierChangement.verrouPris;
      let doublon;
      try {
        doublon = request(app).patch(`/api/chantiers/${troisiemeChantier.id}`).set(auth).send({ clientId: nouveau.id }).then(r => r);
        assert.equal(await attendreVerrou('%"Chantier"%FOR UPDATE%'), true, 'le second changement doit attendre le premier');
      } finally {
        premierChangement.liberer();
        await premierChangement.transaction;
      }
      const reponseDoublon = await doublon;
      assert.equal(reponseDoublon.status, 200, JSON.stringify(reponseDoublon.body));
      assert.deepEqual(await prisma.chantier.findUniqueOrThrow({ where: { id: troisiemeChantier.id }, select: { client: true, clientId: true } }), { client: 'TEST Course libellé du premier changement', clientId: nouveau.id });
      assert.equal(await prisma.journalSaisieChantier.count({ where: { chantierId: troisiemeChantier.id } }), 0);

      // 4. Une facture d'affaire créée pendant un changement de client attend sa fin, puis est
      //    refusée pour l'ancien client : l'affaire n'est plus la sienne.
      const quatrieme = await prisma.chantier.create({ data: { nom: 'TEST Course facture attend', client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const changementAvantFacture = tenirVerrou(quatrieme.id, 'FOR UPDATE', tx => tx.chantier.update({ where: { id: quatrieme.id }, data: { clientId: nouveau.id, client: nouveau.raisonSociale } }));
      await changementAvantFacture.verrouPris;
      let facturation;
      try {
        facturation = request(app).post('/api/factures').set(auth).send({ clientId: ancien.id, origine: 'CHANTIER', chantierId: quatrieme.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST Course facture', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] }).then(r => r);
        assert.equal(await attendreVerrou('%"Chantier"%FOR SHARE%'), true, 'la facture doit attendre le changement de client');
      } finally {
        changementAvantFacture.liberer();
        await changementAvantFacture.transaction;
      }
      const refusFacture = await facturation;
      assert.equal(refusFacture.status, 404, JSON.stringify(refusFacture.body));
      assert.equal(await prisma.facture.count({ where: { chantierId: quatrieme.id } }), 0);

      // 5. Une annulation de l'affaire enregistrée pendant le changement : relue sous verrou, elle
      //    fait refuser le changement, sans trace.
      const cinquieme = await prisma.chantier.create({ data: { nom: 'TEST Course annulation', client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      const annulation = tenirVerrou(cinquieme.id, 'FOR UPDATE', tx => tx.chantier.update({ where: { id: cinquieme.id }, data: { statut: 'ANNULE', annuleLe: new Date() } }));
      await annulation.verrouPris;
      let pendantAnnulation;
      try {
        pendantAnnulation = request(app).patch(`/api/chantiers/${cinquieme.id}`).set(auth).send({ clientId: nouveau.id }).then(r => r);
        assert.equal(await attendreVerrou('%"Chantier"%FOR UPDATE%'), true, 'le changement doit attendre l’annulation');
      } finally {
        annulation.liberer();
        await annulation.transaction;
      }
      const refusAnnulee = await pendantAnnulation;
      assert.equal(refusAnnulee.status, 409, JSON.stringify(refusAnnulee.body));
      assert.equal(refusAnnulee.body.error, 'Cette affaire est annulée : elle n’est plus modifiable.');
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: cinquieme.id } })).clientId, ancien.id);
      assert.equal(await prisma.journalSaisieChantier.count({ where: { chantierId: cinquieme.id } }), 0);

      // 6. Une annulation en cours (verrou d'une mise à jour ordinaire, FOR NO KEY UPDATE) : la
      //    création d'une intervention ou d'une facture d'affaire l'attend, puis est refusée.
      for (const creation of ['intervention', 'facture']) {
        const sixieme = await prisma.chantier.create({ data: { nom: `TEST Course ${creation} pendant annulation`, client: ancien.raisonSociale, clientId: ancien.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
        const annulationEnCours = tenirVerrou(sixieme.id, 'FOR NO KEY UPDATE', tx => tx.chantier.update({ where: { id: sixieme.id }, data: { statut: 'ANNULE', annuleLe: new Date() } }));
        await annulationEnCours.verrouPris;
        let pendant;
        try {
          pendant = (creation === 'intervention'
            ? request(app).post('/api/interventions').set(auth).send({ clientId: ancien.id, chantierId: sixieme.id, titre: 'TEST Course SAV pendant annulation' })
            : request(app).post('/api/factures').set(auth).send({ clientId: ancien.id, origine: 'CHANTIER', chantierId: sixieme.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST Course facture pendant annulation', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] })
          ).then(r => r);
          assert.equal(await attendreVerrou('%"Chantier"%FOR SHARE%'), true, `la création (${creation}) doit attendre l’annulation`);
        } finally {
          annulationEnCours.liberer();
          await annulationEnCours.transaction;
        }
        const refusPendant = await pendant;
        assert.equal(refusPendant.status, creation === 'intervention' ? 404 : 409, JSON.stringify(refusPendant.body));
        assert.equal(await prisma.intervention.count({ where: { chantierId: sixieme.id } }), 0);
        assert.equal(await prisma.facture.count({ where: { chantierId: sixieme.id } }), 0);
      }
    });

    test('#111 : un client désactivé depuis ne bloque pas la fiche, mais ne se choisit plus', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const desactive = await prisma.client.create({ data: { raisonSociale: 'TEST 111 client désactivé depuis' } });
      const actif = await prisma.client.create({ data: { raisonSociale: 'TEST 111 client actif de remplacement' } });
      const chantier = await prisma.chantier.create({ data: { nom: 'TEST 111 fiche client désactivé', client: desactive.raisonSociale, clientId: desactive.id, dateDebut: new Date(), budgetGlobalVendu: 1000 } });
      await prisma.client.update({ where: { id: desactive.id }, data: { actif: false } });
      // Le même client renvoyé tel quel n'est pas un changement : le reste de la fiche s'enregistre.
      const identique = await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: desactive.id, nom: 'TEST 111 fiche renommée' });
      assert.equal(identique.status, 200, JSON.stringify(identique.body));
      const apres = await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } });
      assert.equal(apres.nom, 'TEST 111 fiche renommée');
      assert.equal(apres.clientId, desactive.id);
      // Un nouveau client doit être actif ; revenir à un client désactivé est refusé aussi.
      const remplacement = await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: actif.id });
      assert.equal(remplacement.status, 200, JSON.stringify(remplacement.body));
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).clientId, actif.id);
      const retour = await request(app).patch(`/api/chantiers/${chantier.id}`).set(auth).send({ clientId: desactive.id });
      assert.equal(retour.status, 404, JSON.stringify(retour.body));
      assert.equal((await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } })).clientId, actif.id);
      // Le conducteur titulaire modifie sa fiche, jamais son client : le champ est ignoré.
      const titulaire = await prisma.user.create({ data: { email: 'fiche111.titulaire@iris.test', name: 'TEST 111 conducteur titulaire', role: 'CONDUCTEUR_TRAVAUX' } });
      await prisma.chantier.update({ where: { id: chantier.id }, data: { responsableId: titulaire.id } });
      const parTitulaire = await request(app).patch(`/api/chantiers/${chantier.id}`).set('Authorization', `Bearer ${jwt.sign({ id: titulaire.id }, process.env.JWT_SECRET)}`).send({ clientId: desactive.id, nom: 'TEST 111 renommée par le titulaire' });
      assert.equal(parTitulaire.status, 200, JSON.stringify(parTitulaire.body));
      const parTitulaireEnBase = await prisma.chantier.findUniqueOrThrow({ where: { id: chantier.id } });
      assert.equal(parTitulaireEnBase.nom, 'TEST 111 renommée par le titulaire');
      assert.equal(parTitulaireEnBase.clientId, actif.id);
      assert.equal(parTitulaireEnBase.client, actif.raisonSociale);
    });

    test('refuse le document PDF d’une facture brouillon', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST document brouillon', dateEmission: '09-09-2026', dateEcheance: '09-10-2026', lignes: [{ designation: 'TEST document brouillon', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 409, JSON.stringify(document.body));
      assert.match(document.body.error, /facture émise/i);
    });

    test('refuse d’émettre une facture antérieure à la dernière déjà numérotée', async () => {
      const brouillon = (dateEmission, dateEcheance) => request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission, dateEcheance, lignes: [{ designation: 'TEST chronologie', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const emettre = (id) => request(app).post(`/api/factures/${id}/emettre`).set('Authorization', `Bearer ${session}`);
      const reference = await emettre((await brouillon('08-09-2026', '08-10-2026')).body.id);
      assert.equal(reference.status, 200, JSON.stringify(reference.body));
      assert.equal((await emettre((await brouillon('08-09-2026', '08-10-2026')).body.id)).status, 200);
      const ancienne = await brouillon('02-01-2026', '31-12-2026');
      const refus = await emettre(ancienne.body.id);
      assert.equal(refus.status, 409, JSON.stringify(refus.body)); assert.match(refus.body.error, /chronologique/i); assert.match(refus.body.error, /08-09-2026/);
      assert.equal((await prisma.facture.findUnique({ where: { id: ancienne.body.id } })).numero, null);
    });

    test('génère un document PDF pour une facture émise', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST document émis', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST document émis', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`).send();
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const legalFige = emission.body.mentionsLegalesVersion;
      assert.ok(legalFige, JSON.stringify(emission.body));
      await prisma.companySettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', raisonSociale: 'TEST Société vivante', siret: 'TEST-SIRET-VIVANT', couleurPrimaire: '#123456' }, update: { raisonSociale: 'TEST Société vivante', siret: 'TEST-SIRET-VIVANT', couleurPrimaire: '#123456' } });
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 200, document.text);
      assert.match(document.headers['content-type'] || '', /application\/pdf/);
      assert.ok(document.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
      const lecteurPdf = new PDFParse({ data: document.body });
      const contenuPdf = await lecteurPdf.getText();
      await lecteurPdf.destroy();
      assert.match(contenuPdf.text, /TEST document émis/);
      assert.match(contenuPdf.text, new RegExp(legalFige.mentions));
      assert.match(contenuPdf.text, new RegExp(`version ${legalFige.version}`));
      assert.doesNotMatch(contenuPdf.text, /TEST Société vivante|TEST-SIRET-VIVANT/);
      const zlib = await import('node:zlib'); const tailles = new Set();
      for (let curseur = 0; ;) { const debut = document.body.indexOf('stream', curseur); if (debut < 0) break; const fin = document.body.indexOf('endstream', debut); if (fin < 0) break; let corps = debut + 6; while (document.body[corps] === 13 || document.body[corps] === 10) corps += 1; try { for (const trouve of zlib.inflateSync(document.body.subarray(corps, fin)).toString('latin1').matchAll(/\/F\d+\s+([\d.]+)\s+Tf/g)) tailles.add(trouve[1]); } catch {} curseur = fin + 9; }
      assert.ok(tailles.size >= 4, `Hiérarchie typographique absente : ${[...tailles].join(', ')}`);
      assert.match(contenuPdf.text, /Mentions légales et CGV/);
    });

    test('régénère le PDF historique avec le client et les mentions figés', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST gel PDF', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST gel PDF', quantite: 1, prixUnitaireHt: 30, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const nomClientFige = emission.body.clientRaisonSociale;
      const ancienneVersion = await prisma.mentionsLegalesVersion.findFirst({ where: { actif: true }, select: { version: true, mentions: true } });
      assert.ok(ancienneVersion);
      await prisma.client.update({ where: { id: clientId }, data: { raisonSociale: 'TEST Client renommé après émission' } });
      const nouvelleVersion = await request(app).post('/api/mentions-legales').set('Authorization', `Bearer ${session}`).send({ mentions: 'TEST Nouvelles mentions', cgv: 'TEST Nouvelles CGV', penalites: 'TEST Nouvelles pénalités' });
      assert.equal(nouvelleVersion.status, 201, JSON.stringify(nouvelleVersion.body));
      assert.equal((await request(app).post(`/api/mentions-legales/${nouvelleVersion.body.version}/publier`).set('Authorization', `Bearer ${session}`)).status, 200);
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 200, document.text);
      const lecteurPdf = new PDFParse({ data: document.body }); const contenuPdf = await lecteurPdf.getText(); await lecteurPdf.destroy();
      assert.ok(contenuPdf.text.includes(nomClientFige));
      assert.doesNotMatch(contenuPdf.text, /TEST Client renommé après émission/);
      assert.match(contenuPdf.text, new RegExp(ancienneVersion.mentions));
      assert.doesNotMatch(contenuPdf.text, /TEST Nouvelles mentions/);
    });

    test('ventile la TVA par taux dans le document PDF', async () => {
      const compteTva = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
      await tvaFixture(10, compteTva.id);
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST TVA PDF', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST TVA 20', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }, { designation: 'TEST TVA 10', quantite: 1, prixUnitaireHt: 100, tauxTva: 10 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 200, document.text);
      assert.match(document.headers['content-type'] || '', /application\/pdf/);
      assert.ok(document.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
      const lecteurPdf = new PDFParse({ data: document.body });
      const contenuPdf = await lecteurPdf.getText();
      await lecteurPdf.destroy();
      assert.match(contenuPdf.text, /TVA 10 %/);
      assert.match(contenuPdf.text, /TVA 20 %/);
      assert.match(contenuPdf.text, /20,00 €/);
    });

    test('imprime les montants à quatre chiffres et les désignations longues sans les altérer', async () => {
      const designation = 'TEST Remplacement de la centrale incendie type 4 du bâtiment B, câblage et mise en service comprise';
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST rendu montants', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation, quantite: 1, prixUnitaireHt: 1234.56, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body)); assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`); const lecteurPdf = new PDFParse({ data: document.body }); const contenuPdf = await lecteurPdf.getText(); await lecteurPdf.destroy();
      assert.match(contenuPdf.text, /1 234,56 €/); assert.match(contenuPdf.text, /Total TTC : 1 481,47 €/); assert.doesNotMatch(contenuPdf.text, /\d \/\d/);
      for (const mot of designation.split(' ')) assert.ok(contenuPdf.text.includes(mot), `Désignation tronquée : ${mot}`);
      const million = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST colonnes larges', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST lot unique', quantite: 1, prixUnitaireHt: 1234567.89, tauxTva: 20 }] });
      assert.equal(million.status, 201, JSON.stringify(million.body)); assert.equal((await request(app).post(`/api/factures/${million.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const docMillion = await request(app).get(`/api/factures/${million.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`); assert.equal(docMillion.status, 200, docMillion.text);
      const lecteurMillion = new PDFParse({ data: docMillion.body }); const contenuMillion = await lecteurMillion.getText(); await lecteurMillion.destroy();
      assert.match(contenuMillion.text, /TEST lot unique 1 1 234 567,89 € 20 % 1 234 567,89 €/); assert.doesNotMatch(contenuMillion.text, /11 234 567,89 €/);
    });

    test('refuse le document PDF d’une facture antérieure au gel de l’adresse', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST adresse héritée', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST adresse héritée', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const mentions = await prisma.mentionsLegalesVersion.findFirst({ where: { actif: true, publieeLe: { not: null } }, select: { id: true } }); assert.ok(mentions);
      await prisma.$transaction(async tx => {
        await tx.facture.update({ where: { id: brouillon.body.id }, data: { statut: 'EMISE', annee: 2026, numero: `TEST-HERITEE-${Date.now()}`, emisLe: new Date(), mentionsLegalesVersionId: mentions.id } });
        const regles = await tx.regleComptable.findMany({ include: { compte: true } });
        const tva = await tx.regleTvaComptable.findUniqueOrThrow({ where: { taux: 20 }, include: { compte: true } });
        const parCle = new Map(regles.map(r => [r.cle, r]));
        const journalCode = parCle.get('JOURNAL_VENTES').journal;
        const ecritures = [['CLIENT', parCle.get('CLIENT').compte, 12, 0], ['VENTE_PRESTATION', parCle.get('VENTE_PRESTATION').compte, 0, 10], ['TVA:20', tva.compte, 0, 2]];
        await tx.ecritureFacture.createMany({ data: ecritures.map(([cle, compte, debit, credit], ordre) => ({ factureId: brouillon.body.id, ordre, cle, tauxTva: cle === 'TVA:20' ? 20 : null, journalCode, compteNum: compte.code, compteLib: compte.libelle, debit, credit })) });
        await tx.facture.update({ where: { id: brouillon.body.id }, data: { ecrituresScellees: true } });
      });
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`); assert.equal(document.status, 409, document.text); assert.match(document.body.error, /adresse de facturation/i);
    });

    test('fige l’adresse de facturation du client dans le document PDF', async () => {
      const clientAdresse = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client adresse facture' });
      assert.equal(clientAdresse.status, 201, JSON.stringify(clientAdresse.body));
      const creerSite = corps => request(app).post(`/api/clients/${clientAdresse.body.id}/sites`).set('Authorization', `Bearer ${session}`).send(corps);
      assert.equal((await creerSite({ nom: 'A Site de chantier', adresse: '1 rue Ignorée', codePostal: '13001', ville: 'Marseille', estSiteIntervention: true })).status, 201);
      const facturation = await creerSite({ nom: 'Z Adresse de facturation', adresse: '7 quai de la Facturation', complementAdresse: 'Bâtiment C', codePostal: '69002', ville: 'Lyon', estSiteFacturation: true });
      assert.equal(facturation.status, 201, JSON.stringify(facturation.body));
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: clientAdresse.body.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST adresse obligatoire', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST adresse obligatoire', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      assert.equal(emission.body.clientAdresse, '7 quai de la Facturation\nBâtiment C\n69002 Lyon');
      await prisma.clientSite.update({ where: { id: facturation.body.id }, data: { adresse: '99 avenue du Déménagement', complementAdresse: null, codePostal: '75009', ville: 'Paris' } });
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      const lecteurPdf = new PDFParse({ data: document.body }); const contenuPdf = await lecteurPdf.getText(); await lecteurPdf.destroy();
      assert.equal(document.status, 200, document.text); assert.match(contenuPdf.text, /7 quai de la Facturation/); assert.match(contenuPdf.text, /Bâtiment C/); assert.match(contenuPdf.text, /69002 Lyon/);
      assert.doesNotMatch(contenuPdf.text, /1 rue Ignorée|99 avenue du Déménagement/);
      await assert.rejects(() => prisma.facture.update({ where: { id: brouillon.body.id }, data: { clientAdresse: '99 avenue du Déménagement' } }));
      await assert.rejects(() => prisma.facture.update({ where: { id: brouillon.body.id }, data: { clientRaisonSociale: 'TEST Client réécrit' } }));
    });

    test('refuse le document d’une facture émise sans mentions figées', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST document sans mentions', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST document sans mentions', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      await prisma.facture.update({ where: { id: brouillon.body.id }, data: { mentionsLegalesVersionId: null } });
      const document = await request(app).get(`/api/factures/${brouillon.body.id}/document.pdf`).set('Authorization', `Bearer ${session}`);
      assert.equal(document.status, 409, JSON.stringify(document.body)); assert.match(document.body.error, /mentions légales/i);
    });

    test('refuse d’émettre une facture pour un client sans adresse de facturation', async () => {
      const clientSansSite = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client sans site' });
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: clientSansSite.body.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST adresse absente', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST adresse absente', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body)); assert.match(refus.body.error, /adresse de facturation/i);
      const enBase = await prisma.facture.findUnique({ where: { id: brouillon.body.id } }); assert.equal(enBase.numero, null); assert.equal(enBase.statut, 'BROUILLON');
    });

    test('protège l’autoliquidation BTP et signale les clients sans site sans barrage', async () => {
      const diagnostic = () => request(app).get('/api/facturation/prete-a-facturer').set('Authorization', `Bearer ${session}`);
      const controle = (corps, cle) => corps.controles.find((item) => item.cle === cle);
      const avant = await diagnostic();
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST client sans site diagnostic' });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const apres = await diagnostic();
      assert.equal(controle(apres.body, 'ADRESSES_CLIENTS').pret, false);
      assert.equal(controle(apres.body, 'ADRESSES_CLIENTS').bloquant, false);
      assert.equal(apres.body.pret, avant.body.pret);
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: client.body.id, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST autoliquidation', dateEmission: '10-09-2026', dateEcheance: '10-10-2026', lignes: [{ designation: 'TEST sous-traitance', quantite: 1, prixUnitaireHt: 5000, tauxTva: 0 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const refus = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      await request(app).post(`/api/clients/${client.body.id}/sites`).set('Authorization', `Bearer ${session}`).send({ nom: 'TEST site', adresse: '1 rue du Test', codePostal: '14000', ville: 'Caen', estSiteFacturation: true });
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
      const compteTva = await prisma.compteComptable.findFirst({ where: { nature: 'TVA', actif: true } });
      assert.ok(compteTva);
      const exportAvant = await request(app).get('/api/factures/export-comptable.csv').set('Authorization', `Bearer ${session}`);
      const aCouvrir = exportAvant.status === 409 ? (exportAvant.body.tauxManquants || []) : [];
      for (const taux of aCouvrir) assert.equal((await request(app).put(`/api/comptabilite/tva/${taux}`).set('Authorization', `Bearer ${session}`).send({ motif: 'Révision de règle comptable testée', compteId: compteTva.id })).status, 200);
      const diagCouvert = await diagnostic();
      const tva = controle(diagCouvert.body, 'TVA');
      assert.equal(tva.bloquant, false); assert.doesNotMatch(tva.detail, /0 %.*facturé/i);
      assert.equal(controle(diagCouvert.body, 'PREFIXE_FACTURE').pret, false);
      assert.equal(diagCouvert.body.pret, true, JSON.stringify(diagCouvert.body.controles));
      for (const taux of aCouvrir) await retirerTvaFixture(taux);
    });

    test('calcule la TVA sur la base HT cumulée par taux', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: Array.from({ length: 100 }, (_, index) => ({ designation: `TEST arrondi ${index}`, quantite: 1, prixUnitaireHt: 1.99, tauxTva: 20 })) });
      assert.equal(facture.status, 201, JSON.stringify(facture.body)); assert.equal(facture.body.totalHt, 199); assert.equal(facture.body.totalTva, 39.8); assert.equal(facture.body.totalTtc, 238.8);
    });

    test('arrondit commercialement les lignes facture et agrège les taux 20, 10 et 5,5', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Arrondi commercial multi-taux', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [20, 10, 5.5].map((tauxTva) => ({ designation: `TEST demi-centime ${tauxTva}`, quantite: '0.5', prixUnitaireHt: '4.27', tauxTva })),
      });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.deepEqual(facture.body.lignes.map((ligne) => ligne.totalHt), [2.14, 2.14, 2.14]);
      assert.deepEqual([facture.body.totalHt, facture.body.totalTva, facture.body.totalTtc], [6.42, 0.76, 7.18]);
      assert.equal(Math.round((facture.body.totalHt + facture.body.totalTva) * 100) / 100, facture.body.totalTtc);
    });

    test('arrondit au demi-centime le TTC de ligne et la TVA agrégée', async () => {
      // 9,00 € à 5,5 % ne distingue pas les formules ; 21,35 € à 10 % produit 2,135 €.
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TVA sur demi-centime', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST TVA agrégée', quantite: '1', prixUnitaireHt: '21.35', tauxTva: 10 }],
      });
      assert.equal(facture.status, 201, JSON.stringify(facture.body));
      assert.equal(facture.body.totalTva, 2.14);
      assert.equal(facture.body.lignes[0].totalTtc, 23.49);
      assert.equal(facture.body.totalTtc, facture.body.lignes[0].totalTtc);

      // Deuxième témoin, nécessaire en plus du premier : 21,35 € à 10 % ne tient que la
      // TVA agrégée. Son TTC flottant remonte à 23,49 par chance. À 9,00 € et 5,5 %, le
      // flottant descend à 9,49 : ce cas tient seul le TTC de la route POST /api/factures.
      const ttcSurDemiCentime = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TTC de ligne sur demi-centime', dateEmission: '08-09-2026', dateEcheance: '08-10-2026',
        lignes: [{ designation: 'TEST TTC de ligne', quantite: '1', prixUnitaireHt: '9.00', tauxTva: 5.5 }],
      });
      assert.equal(ttcSurDemiCentime.status, 201, JSON.stringify(ttcSurDemiCentime.body));
      assert.equal(ttcSurDemiCentime.body.lignes[0].totalTtc, 9.5, 'le TTC de ligne monte la demi-tranche');
      assert.equal(ttcSurDemiCentime.body.totalTtc, ttcSurDemiCentime.body.lignes[0].totalTtc, 'la ligne et le pied disent la même chose');
    });

    test('applique le même arrondi positif aux avoirs partiels et leur plafond', async () => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({
        clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Plafond avoir demi-centime', dateEmission: '11-09-2026', dateEcheance: '11-10-2026',
        lignes: [{ designation: 'TEST source demi-centime', quantite: '1', prixUnitaireHt: '9.00', tauxTva: 5.5 }, { designation: 'TEST source HT demi-centime', quantite: '0.5', prixUnitaireHt: '4.27', tauxTva: 20 }],
      });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      const creer = (lignes) => request(app).post(`/api/factures/${emission.body.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes });
      const avoir = await creer([{ designation: 'TEST avoir demi-centime', quantite: '1', prixUnitaireHt: '9.00', tauxTva: 5.5 }, { designation: 'TEST avoir HT demi-centime', quantite: '0.5', prixUnitaireHt: '4.27', tauxTva: 20 }]);
      assert.equal(avoir.status, 201, JSON.stringify(avoir.body));
      assert.deepEqual([avoir.body.totalHt, avoir.body.totalTva, avoir.body.totalTtc], [11.14, 0.93, 12.07]);
      assert.equal(avoir.body.lignes[0].totalTtc, 9.5);
      assert.equal(avoir.body.lignes[1].totalHt, 2.14);
      assert.ok(avoir.body.totalHt > 0 && avoir.body.totalTva > 0 && avoir.body.totalTtc > 0, 'les avoirs sont stockés positifs');
      const depassement = await creer([{ designation: 'TEST avoir dépassement', quantite: 1, prixUnitaireHt: '0.01', tauxTva: 5.5 }]);
      assert.equal(depassement.status, 409, JSON.stringify(depassement.body));
    });

    test('refuse les factures incompatibles avec les contraintes métier', async () => {
      const creer = (corps) => request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', ...corps });
      assert.equal((await creer({ lignes: [] })).status, 400);
      assert.equal((await creer({ dateEcheance: '07-09-2026', lignes: [{ designation: 'TEST échéance', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] })).status, 400);
      const inactif = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale: 'TEST Client facture inactif' }); await prisma.client.update({ where: { id: inactif.body.id }, data: { actif: false } });
      assert.equal((await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: inactif.body.id, dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST inactif', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] })).status, 404);
      const excedent = await creer({ lignes: [{ designation: 'TEST dépassement', quantite: 999999999, prixUnitaireHt: 9999999999, tauxTva: 20 }] });
      assert.equal(excedent.status, 400, JSON.stringify(excedent.body)); assert.equal(/prisma|invocation|\/server\//i.test(excedent.body.error), false, excedent.body.error);
    });

    test('accepte les lignes offertes, l’exonération et les quantités à trois décimales', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [{ designation: 'TEST autoliquidation', quantite: 1, prixUnitaireHt: 1000, tauxTva: 0 }, { designation: 'TEST geste commercial', quantite: 1, prixUnitaireHt: 0, tauxTva: 20 }, { designation: 'TEST heures', quantite: 1.125, prixUnitaireHt: 80, tauxTva: 20, nature: 'ARTICLE' }] });
      assert.equal(facture.status, 201, JSON.stringify(facture.body)); assert.equal(facture.body.totalHt, 1090); assert.equal(facture.body.totalTva, 18); assert.equal(facture.body.totalTtc, 1108);
    });

    test('conserve le TTC propre à chaque ligne', async () => {
      const facture = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'Test de facturation', dateEmission: '08-09-2026', dateEcheance: '08-10-2026', lignes: [1, 2, 3].map(rang => ({ designation: `TEST ligne ${rang}`, quantite: 1, prixUnitaireHt: 100, tauxTva: 20 })) });
      assert.equal(facture.status, 201, JSON.stringify(facture.body)); for (const ligne of facture.body.lignes) assert.equal(ligne.totalTtc, 120); assert.equal(facture.body.totalTtc, 360);
    });

    test('génère une seule intervention prévisionnelle par échéance de contrat', async () => {
      const premier = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      assert.equal(premier.body.statut, 'A_PLANIFIER');
      assert.equal(premier.body.client.id, clientId);
      assert.equal(premier.body.site.id, siteId);
      const second = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.id, premier.body.id);
    });

    test('ne retourne jamais une intervention d’échéance antérieure après un P2002 de génération', async () => {
      const contrat = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST P2002 fallback', periodiciteMois: 12, dureePrevisionnelleMinutes: 60, dateDebut: '01-01-2025',
      });
      assert.equal(contrat.status, 201, JSON.stringify(contrat.body));
      const echeanceCourante = new Date('2026-01-01T00:00:00.000Z');
      await prisma.contratMaintenance.update({ where: { id: contrat.body.id }, data: { prochaineEcheance: echeanceCourante } });
      const interventionAnterieure = await prisma.intervention.create({ data: {
        reference: `TEST-I-P2002-ANTERIEURE-${Date.now()}`, clientId, siteId, contratMaintenanceId: contrat.body.id,
        echeanceContrat: new Date('2025-01-01T00:00:00.000Z'), dateDemande: new Date('2025-01-01T00:00:00.000Z'), titre: 'TEST Intervention échéance antérieure',
      } });
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "test_forcer_p2002_generation_contrat"()
        RETURNS TRIGGER AS $$
        BEGIN
          IF NEW."titre" = 'Maintenance préventive — TEST P2002 fallback' THEN
            RAISE EXCEPTION 'collision de test' USING ERRCODE = 'unique_violation';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_forcer_p2002_generation_contrat"
        BEFORE INSERT ON "Intervention"
        FOR EACH ROW EXECUTE FUNCTION "test_forcer_p2002_generation_contrat"();`);
      try {
        const generation = await request(app).post(`/api/contrats-maintenance/${contrat.body.id}/generer-intervention`).set('Authorization', `Bearer ${session}`);
        assert.equal(generation.status, 500, JSON.stringify(generation.body));
        assert.notEqual(generation.body.id, interventionAnterieure.id, 'le fallback ne doit pas divulguer l’intervention de l’échéance antérieure');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_forcer_p2002_generation_contrat" ON "Intervention";');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "test_forcer_p2002_generation_contrat"();');
      }
    });

    test('clôture une échéance avant de préparer la suivante', async () => {
      const intervention = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(intervention.status, 200, JSON.stringify(intervention.body));
      // L'échéance ne bouge pas tant que son intervention n'est pas effectivement terminée.
      const avancementPremature = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(avancementPremature.status, 409, JSON.stringify(avancementPremature.body));
      const tracesInitiales = await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: contratId } });
      for (const statut of ['PLANIFIEE', 'EN_COURS', 'TERMINEE']) {
        const transition = await request(app).patch(`/api/interventions/${intervention.body.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut });
        assert.equal(transition.status, 200, JSON.stringify(transition.body));
      }
      const avance = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(avance.status, 200, JSON.stringify(avance.body));
      assert.equal(new Date(avance.body.prochaineEcheance).toISOString().slice(0, 10), '2027-03-08');
      const journal = await request(app).get(`/api/contrats-maintenance/${contratId}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200);
      assert.equal(journal.body.length, tracesInitiales + 1, 'une seule trace créée dans la même transaction');
      const trace = journal.body.find((ligne) => ligne.action === 'AVANCEMENT_ECHEANCE');
      assert.ok(trace, 'l’avancement est journalisé');
      assert.equal(trace.cible, 'CONTRAT');
      assert.equal(trace.cibleId, contratId);
      assert.equal(trace.contratMaintenanceId, contratId);
      assert.ok(trace.auteurId);
      assert.ok(trace.auteurNom);
      assert.match(trace.motif, new RegExp(intervention.body.reference));
      // Dates du motif au format JJ-MM-AAAA (lot (h)), et non en AAAA-MM-JJ.
      const echeanceFr = intervention.body.echeanceContrat.slice(0, 10).split('-').reverse().join('-');
      assert.ok(trace.motif.endsWith(`échéance du ${echeanceFr} au 08-03-2027.`), trace.motif);
      assert.equal(trace.avant.prochaineEcheance, intervention.body.echeanceContrat);
      assert.equal(trace.apres.prochaineEcheance, avance.body.prochaineEcheance);
      const secondeTentative = await request(app).post(`/api/contrats-maintenance/${contratId}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(secondeTentative.status, 409, JSON.stringify(secondeTentative.body));
      assert.equal(await prisma.journalSaisieChantier.count({ where: { contratMaintenanceId: contratId } }), tracesInitiales + 1, 'aucune trace de refus');
    });

    test('conserve le jour contractuel après un mois court', async () => {
      const contrat31 = await request(app).post('/api/contrats-maintenance').set('Authorization', `Bearer ${session}`).send({
        clientId, siteId, titre: 'TEST Maintenance au 31', periodiciteMois: 1, dureePrevisionnelleMinutes: 60, dateDebut: '31-01-2027',
      });
      assert.equal(contrat31.status, 201, JSON.stringify(contrat31.body));
      const echeanceFevrier = new Date('2027-02-28T00:00:00.000Z');
      await prisma.contratMaintenance.update({ where: { id: contrat31.body.id }, data: { prochaineEcheance: echeanceFevrier } });
      await prisma.intervention.create({ data: {
        reference: `TEST-I-31-${Date.now()}`, clientId, siteId, contratMaintenanceId: contrat31.body.id, echeanceContrat: echeanceFevrier,
        titre: 'TEST Intervention échéance courte', statut: 'TERMINEE', dateSouhaitee: echeanceFevrier, dateDemande: echeanceFevrier,
      } });
      const avance = await request(app).post(`/api/contrats-maintenance/${contrat31.body.id}/avancer-echeance`).set('Authorization', `Bearer ${session}`);
      assert.equal(avance.status, 200, JSON.stringify(avance.body));
      assert.equal(new Date(avance.body.prochaineEcheance).toISOString().slice(0, 10), '2027-03-31');
    });

    test('suspend le contrat et bloque la génération tant qu’il n’est pas réactivé', async () => {
      const suspension = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'SUSPENDU', motif: 'Client indisponible pendant travaux' });
      assert.equal(suspension.status, 200, JSON.stringify(suspension.body));
      assert.equal(suspension.body.statut, 'SUSPENDU');
      const journal = await request(app).get(`/api/contrats-maintenance/${contratId}/journal-saisies`).set('Authorization', `Bearer ${session}`);
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
      assert.equal(journal.body[0].action, 'SUSPENSION');
      assert.equal(journal.body[0].motif, 'Client indisponible pendant travaux');
      assert.ok(journal.body[0].auteurNom);
      assert.ok(journal.body[0].createdAt);
      const sansMotif = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE' });
      assert.equal(sansMotif.status, 400, JSON.stringify(sansMotif.body));
      const generationRefusee = await request(app).post(`/api/contrats-maintenance/${contratId}/generer-intervention`).set('Authorization', `Bearer ${session}`);
      assert.equal(generationRefusee.status, 404, JSON.stringify(generationRefusee.body));
      const reactivation = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF', motif: 'Reprise après travaux' });
      assert.equal(reactivation.status, 200, JSON.stringify(reactivation.body));
      assert.equal(reactivation.body.statut, 'ACTIF');
      const cloture = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE', motif: 'Fin contractuelle confirmée' });
      assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
      const repriseInterdite = await request(app).patch(`/api/contrats-maintenance/${contratId}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'ACTIF', motif: 'Contrat terminé définitivement' });
      assert.equal(repriseInterdite.status, 409, JSON.stringify(repriseInterdite.body));
    });

    // --- Règlements clients (pilote, décision A3 du 16-10-2026) ---
    // Factures émises le 11-09-2026, la date la plus tardive des tests de facturation, pour ne
    // pas bloquer la chronologie des numéros ; règlements datés du 12-09-2026.
    const clientReglement = async (raisonSociale) => {
      const client = await request(app).post('/api/clients').set('Authorization', `Bearer ${session}`).send({ raisonSociale });
      assert.equal(client.status, 201, JSON.stringify(client.body));
      const site = await request(app).post(`/api/clients/${client.body.id}/sites`).set('Authorization', `Bearer ${session}`)
        .send({ nom: 'TEST Site facturation', adresse: '2 rue des Règlements', codePostal: '75002', ville: 'Paris', estSiteFacturation: true });
      assert.equal(site.status, 201, JSON.stringify(site.body));
      return client.body.id;
    };
    const emettrePourReglement = async (client, designation, prixUnitaireHt) => {
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: client, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST règlements', dateEmission: '11-09-2026', dateEcheance: '11-10-2026', lignes: [{ designation: `TEST ${designation}`, quantite: 1, prixUnitaireHt, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
      assert.equal(emission.status, 200, JSON.stringify(emission.body));
      return emission.body;
    };
    const enregistrerReglement = (corps) => request(app).post('/api/reglements').set('Authorization', `Bearer ${session}`).send({ dateReglement: '12-09-2026', moyen: 'VIREMENT', ...corps });
    const contrepasser = (id, motif = 'TEST saisie erronée') => request(app).post(`/api/reglements/${id}/contrepasser`).set('Authorization', `Bearer ${session}`).send({ motif });
    const factureLue = async (id) => (await request(app).get('/api/factures').set('Authorization', `Bearer ${session}`)).body.find((facture) => facture.id === id);
    const journalDe = async (id) => (await request(app).get(`/api/factures/${id}/journal`).set('Authorization', `Bearer ${session}`)).body;
    const totalAffecte = async (factureId) => Number((await prisma.affectationReglement.aggregate({ where: { factureId, reglement: { statut: 'ENREGISTRE' } }, _sum: { montant: true } }))._sum.montant || 0);
    // Tient le verrou de ligne de la facture le temps que `n` requêtes concurrentes l'attendent,
    // puis le relâche : l'ordre d'arrivée n'influence plus le résultat, seule la règle le fait.
    const sousVerrouFacture = async (factureId, lancer, n = 2) => {
      let liberer, pret;
      const attente = new Promise(resolve => { liberer = resolve; });
      const verrouPris = new Promise(resolve => { pret = resolve; });
      const verrou = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Facture" WHERE "id" = ${factureId} FOR UPDATE`;
        pret();
        await attente;
      }, { timeout: 15000 });
      await verrouPris;
      let requetes;
      try {
        requetes = lancer().map(requete => requete.then(resultat => resultat));
        let bloquees = 0;
        for (let tour = 0; tour < 200 && bloquees < n; tour++) {
          [{ bloquees }] = await prisma.$queryRaw`SELECT count(*)::int AS bloquees FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Facture"%FOR UPDATE%'`;
          if (bloquees < n) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(bloquees, n, 'chaque requête doit attendre le verrou de la facture');
      } finally {
        liberer();
        await verrou;
      }
      return Promise.all(requetes);
    };

    test('règlements : réservés à l’administration, comptable compris', async () => {
      const comptable = await prisma.user.create({ data: { email: 'reglement.comptable@iris.test', name: 'TEST Comptable règlements', role: 'COMPTABLE' } });
      try {
        const token = jwt.sign({ id: comptable.id }, process.env.JWT_SECRET);
        const avant = await prisma.reglement.count();
        for (const route of [() => request(app).get('/api/reglements'), () => request(app).get('/api/factures/a-regler'), () => request(app).post('/api/reglements').send({}), () => request(app).post('/api/reglements/inexistant/contrepasser').send({ motif: 'TEST interdit' })]) {
          assert.equal((await route().set('Authorization', `Bearer ${token}`)).status, 403);
        }
        assert.equal(await prisma.reglement.count(), avant);
      } finally { await prisma.user.delete({ where: { id: comptable.id } }); }
    });

    test('règlements : partiel puis réparti sur deux factures, statut déduit, journal et contre-passation', async () => {
      const client = await clientReglement('TEST Client règlements cycle');
      const f1 = await emettrePourReglement(client, 'règlement un', 100);
      const f2 = await emettrePourReglement(client, 'règlement deux', 200);
      assert.deepEqual([f1.totalTtc, f2.totalTtc], [120, 240]);
      const aRegler = (await request(app).get('/api/factures/a-regler').set('Authorization', `Bearer ${session}`)).body.factures.filter((facture) => facture.client.id === client);
      assert.deepEqual(aRegler.map((facture) => [facture.numero, facture.resteDu, facture.montantRegle]).sort(), [[f1.numero, 120, 0], [f2.numero, 240, 0]].sort());

      const partiel = await enregistrerReglement({ clientId: client, montant: '50,00', moyen: 'CHEQUE', reference: '  CHQ 1234567 ', affectations: [{ factureId: f1.id, montant: '50' }] });
      assert.equal(partiel.status, 201, JSON.stringify(partiel.body));
      assert.deepEqual([partiel.body.statut, partiel.body.montant, partiel.body.moyen, partiel.body.reference, partiel.body.dateReglement], ['ENREGISTRE', 50, 'CHEQUE', 'CHQ 1234567', '2026-09-12T00:00:00.000Z']);
      assert.ok(partiel.body.createdBy?.id, 'le règlement porte son auteur');
      assert.deepEqual(partiel.body.affectations.map((affectation) => [affectation.facture.numero, affectation.montant]), [[f1.numero, 50]]);
      let lu = await factureLue(f1.id);
      assert.deepEqual([lu.statut, lu.montantRegle, lu.resteDu, lu.totalTtc], ['EMISE', 50, 70, 120]);

      const reparti = await enregistrerReglement({ clientId: client, montant: 310, affectations: [{ factureId: f2.id, montant: 240 }, { factureId: f1.id, montant: 70 }] });
      assert.equal(reparti.status, 201, JSON.stringify(reparti.body));
      for (const [facture, regle] of [[f1, 120], [f2, 240]]) {
        lu = await factureLue(facture.id);
        assert.deepEqual([lu.statut, lu.montantRegle, lu.resteDu, lu.totalTtc, lu.lignes.length], ['REGLEE', regle, 0, facture.totalTtc, 1]);
      }
      assert.equal((await request(app).get('/api/factures/a-regler').set('Authorization', `Bearer ${session}`)).body.factures.filter((facture) => facture.client.id === client).length, 0);
      let journal = await journalDe(f1.id);
      const affectes = journal.filter((entree) => entree.action === 'REGLEMENT_AFFECTE');
      assert.equal(affectes.length, 2);
      assert.ok(affectes.every((entree) => entree.acteurId));
      assert.ok(affectes.some((entree) => /12-09-2026 \(chèque, réf\. CHQ 1234567\) : 50,00 € affectés ; reste dû 70,00 €/.test(entree.detail)), JSON.stringify(affectes));
      assert.equal(journal.filter((entree) => entree.action === 'REGLEMENT' && /EMISE → REGLEE/.test(entree.detail)).length, 1);

      const sansMotif = await contrepasser(partiel.body.id, ' a ');
      assert.equal(sansMotif.status, 400, JSON.stringify(sansMotif.body));
      const contrepasse = await contrepasser(partiel.body.id, 'Chèque refusé par la banque');
      assert.equal(contrepasse.status, 200, JSON.stringify(contrepasse.body));
      assert.deepEqual([contrepasse.body.statut, contrepasse.body.motifContrepassation, contrepasse.body.montant], ['CONTREPASSE', 'Chèque refusé par la banque', 50]);
      assert.ok(contrepasse.body.contrepassePar?.id && contrepasse.body.contrepasseLe);
      lu = await factureLue(f1.id);
      assert.deepEqual([lu.statut, lu.montantRegle, lu.resteDu], ['EMISE', 70, 50]);
      assert.equal((await factureLue(f2.id)).statut, 'REGLEE');
      journal = await journalDe(f1.id);
      assert.ok(journal.some((entree) => entree.action === 'REGLEMENT_CONTREPASSE' && /Chèque refusé par la banque.*50,00 € retirés ; reste dû 50,00 €/.test(entree.detail)), JSON.stringify(journal));
      assert.ok(journal.some((entree) => entree.action === 'RETOUR_EMISE' && /REGLEE → EMISE/.test(entree.detail) && entree.acteurId));
      assert.equal((await contrepasser(partiel.body.id)).status, 409);
      assert.equal((await contrepasser('inexistant')).status, 404);

      const parFacture = await request(app).get(`/api/reglements?factureId=${f1.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(parFacture.status, 200, JSON.stringify(parFacture.body));
      assert.deepEqual(parFacture.body.items.map((reglement) => [reglement.id, reglement.statut]).sort(), [[partiel.body.id, 'CONTREPASSE'], [reparti.body.id, 'ENREGISTRE']].sort());
      assert.equal((await request(app).get(`/api/reglements?clientId=${client}&pageSize=1`).set('Authorization', `Bearer ${session}`)).body.total, 2);
      assert.equal((await request(app).get('/api/reglements?pageSize=101').set('Authorization', `Bearer ${session}`)).status, 400);
      assert.equal((await request(app).get(`/api/reglements?clientId=${client}&clientId=${client}`).set('Authorization', `Bearer ${session}`)).status, 400, 'un filtre répété ne liste pas tout');
      // Le reste dû rouvert se règle à nouveau ; les montants de la facture n'ont jamais bougé.
      // Daté du jour même de la société : accepté (seul un jour postérieur est refusé).
      const aujourdHui = jourCivilEntreprise(new Date(), (await prisma.companySettings.findUnique({ where: { id: 'singleton' } }))?.fuseauHoraire || 'Europe/Paris');
      const duJour = await enregistrerReglement({ clientId: client, montant: 50, moyen: 'ESPECES', dateReglement: aujourdHui, affectations: [{ factureId: f1.id, montant: 50 }] });
      assert.equal(duJour.status, 201, JSON.stringify(duJour.body));
      assert.equal(duJour.body.dateReglement, `${aujourdHui}T00:00:00.000Z`);
      assert.equal((await factureLue(f1.id)).statut, 'REGLEE');
      assert.deepEqual(Object.values(await prisma.facture.findUniqueOrThrow({ where: { id: f1.id }, select: { totalHt: true, totalTva: true, totalTtc: true } })).map(Number), [100, 20, 120]);
    });

    test('règlements : chaque refus laisse la base intacte', async () => {
      const client = await clientReglement('TEST Client règlements refus');
      const autre = await clientReglement('TEST Client règlements autre');
      const facture = await emettrePourReglement(client, 'refus', 100);
      const factureAutre = await emettrePourReglement(autre, 'refus autre client', 100);
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: client, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST règlements', dateEmission: '11-09-2026', dateEcheance: '11-10-2026', lignes: [{ designation: 'TEST brouillon', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const creditee = await emettrePourReglement(client, 'créditée', 100);
      const avoir = await request(app).post(`/api/factures/${creditee.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST avoir', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(avoir.status, 201, JSON.stringify(avoir.body));
      const annulee = await emettrePourReglement(client, 'annulée', 100);
      assert.equal((await request(app).post(`/api/factures/${annulee.id}/annuler`).set('Authorization', `Bearer ${session}`)).status, 200);
      const part = (factureId, montant = 10) => ({ clientId: client, montant, affectations: [{ factureId, montant }] });
      const cas = [
        [{ clientId: client, montant: 120, affectations: [{ factureId: facture.id, montant: 100 }] }, 400, /entièrement affecté/],
        [part(factureAutre.id), 409, /autre client/],
        [part(brouillon.body.id), 409, /émise non soldée/],
        [part(avoir.body.id), 409, /émise non soldée/],
        [part(annulee.id), 409, /émise non soldée/],
        [{ ...part(facture.id), dateReglement: '01-01-2099' }, 400, /postérieure/],
        [{ ...part(facture.id), dateReglement: '10-09-2026' }, 409, /précéder l’émission/],
        [{ ...part(facture.id), dateReglement: '31-02-2026' }, 400, /JJ-MM-AAAA/],
        [{ ...part(facture.id), moyen: 'CRYPTO' }, 400, /moyen/],
        [part(facture.id, 0), 400, /montant/i],
        [part(facture.id, -5), 400, /montant/i],
        [part(facture.id, '10.001'), 400, /montant/i],
        [part(facture.id, '1e1'), 400, /montant/i],
        [{ clientId: client, montant: 10, affectations: [] }, 400, /au moins une facture/],
        [{ clientId: client, montant: 20, affectations: [{ factureId: facture.id, montant: 10 }, { factureId: facture.id, montant: 10 }] }, 400, /qu’une fois/],
        [{ ...part(facture.id), clientId: 'inconnu' }, 404, /Client introuvable/],
        [{ ...part('inconnue'), clientId: client }, 404, /Facture introuvable/],
        [{ ...part(facture.id), reference: 'x'.repeat(201) }, 400, /référence/],
        [{ ...part(facture.id), reference: 'CHQ\u0007' }, 400, /référence/],
        [{ ...part(facture.id), clientId: '' }, 400, /client/],
      ];
      const avant = [await prisma.reglement.count(), await prisma.affectationReglement.count(), await prisma.journalFacture.count({ where: { facture: { clientId: client } } })];
      for (const [corps, statut, message] of cas) {
        const reponse = await enregistrerReglement(corps);
        assert.equal(reponse.status, statut, `${JSON.stringify(corps)} → ${JSON.stringify(reponse.body)}`);
        assert.match(reponse.body.error, message);
      }
      assert.deepEqual([await prisma.reglement.count(), await prisma.affectationReglement.count(), await prisma.journalFacture.count({ where: { facture: { clientId: client } } })], avant);
      assert.deepEqual((await prisma.facture.findMany({ where: { id: { in: [facture.id, creditee.id] } }, select: { statut: true } })).map((ligne) => ligne.statut), ['EMISE', 'EMISE']);

      // L'ancienne action « marquer comme réglée » répond sans rien changer.
      const manuel = await request(app).post(`/api/factures/${facture.id}/regler`).set('Authorization', `Bearer ${session}`);
      assert.equal(manuel.status, 410, JSON.stringify(manuel.body));
      assert.match(manuel.body.error, /enregistrez le règlement/);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: facture.id } })).statut, 'EMISE');

      // Centimes exacts : 0,1 + 0,2 vaut bien 0,3 ; le reste dû d'une facture créditée tient compte de l'avoir.
      const exacte = await enregistrerReglement({ clientId: client, montant: 0.3, affectations: [{ factureId: facture.id, montant: 0.1 }, { factureId: creditee.id, montant: 0.2 }] });
      assert.equal(exacte.status, 201, JSON.stringify(exacte.body));
      assert.deepEqual([(await factureLue(creditee.id)).montantAvoirs, (await factureLue(creditee.id)).resteDu], [12, 107.8]);
      assert.equal((await enregistrerReglement(part(creditee.id, 107.8))).status, 201);
      assert.equal((await factureLue(creditee.id)).statut, 'REGLEE');
      assert.equal((await enregistrerReglement(part(creditee.id, 0.01))).status, 409, 'une facture soldée ne reçoit plus de règlement');
    });

    test('règlement supérieur au reste dû : la facture est réglée et le surplus devient un trop-perçu', async () => {
      // Décision de Nelson du 17-10-2026 : réglée dès que le montant enregistré atteint ou dépasse le dû.
      const client = await clientReglement('TEST Client règlements surplus');
      const facture = await emettrePourReglement(client, 'surplus', 100);
      const autre = await emettrePourReglement(client, 'surplus partagé', 100);
      const surplus = await enregistrerReglement({ clientId: client, montant: 130, moyen: 'CHEQUE', affectations: [{ factureId: facture.id, montant: 130 }] });
      assert.equal(surplus.status, 201, JSON.stringify(surplus.body));
      let lue = await factureLue(facture.id);
      assert.deepEqual([lue.statut, lue.montantRegle, lue.resteDu], ['REGLEE', 130, -10]);
      assert.ok((await journalDe(facture.id)).some((entree) => entree.action === 'REGLEMENT_AFFECTE' && /130,00 € affectés ; trop-perçu 10,00 €/.test(entree.detail)), 'le journal annonce le trop-perçu');
      assert.equal((await enregistrerReglement({ clientId: client, montant: 1, affectations: [{ factureId: facture.id, montant: 1 }] })).status, 409, 'une facture réglée ne reçoit plus de règlement');
      // Une seule facture visée : le surplus y reste.
      const seule = await enregistrerReglement({ clientId: client, montant: 125, affectations: [{ factureId: autre.id, montant: 125 }] });
      assert.equal(seule.status, 201, JSON.stringify(seule.body));
      assert.equal((await factureLue(autre.id)).resteDu, -5);
      // Plusieurs factures : un surplus n'est admis que si les autres factures du règlement sont couvertes.
      const g = await emettrePourReglement(client, 'surplus g', 100);
      const h = await emettrePourReglement(client, 'surplus h', 100);
      const desequilibre = await enregistrerReglement({ clientId: client, montant: 250, affectations: [{ factureId: g.id, montant: 100 }, { factureId: h.id, montant: 150 }] });
      assert.equal(desequilibre.status, 409, JSON.stringify(desequilibre.body));
      assert.match(desequilibre.body.error, /surplus ne peut aller sur la facture .* tant que la facture .* reste due/);
      const couvert = await enregistrerReglement({ clientId: client, montant: 250, affectations: [{ factureId: g.id, montant: 120 }, { factureId: h.id, montant: 130 }] });
      assert.equal(couvert.status, 201, JSON.stringify(couvert.body));
      assert.deepEqual([(await factureLue(g.id)).resteDu, (await factureLue(h.id)).resteDu, (await factureLue(h.id)).statut], [0, -10, 'REGLEE']);
      assert.ok((await journalDe(h.id)).some((entree) => entree.action === 'REGLEMENT' && /trop-perçu 10,00 €/.test(entree.detail)), 'la transition écrit aussi le trop-perçu');
      // Une facture soldée par son seul avoir ne reçoit plus de règlement.
      const creditee = await emettrePourReglement(client, 'surplus créditée', 100);
      assert.equal((await request(app).post(`/api/factures/${creditee.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST avoir total partiel', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] })).status, 201);
      const surCreditee = await enregistrerReglement({ clientId: client, montant: 50, affectations: [{ factureId: creditee.id, montant: 50 }] });
      assert.equal(surCreditee.status, 409, JSON.stringify(surCreditee.body));
      assert.match(surCreditee.body.error, /déjà soldée/);
      assert.equal((await factureLue(creditee.id)).statut, 'EMISE');
      // La contre-passation rouvre le reste dû entier.
      assert.equal((await contrepasser(surplus.body.id)).status, 200);
      lue = await factureLue(facture.id);
      assert.deepEqual([lue.statut, lue.montantRegle, lue.resteDu], ['EMISE', 0, 120]);
      assert.ok((await journalDe(facture.id)).some((entree) => entree.action === 'REGLEMENT_CONTREPASSE' && /130,00 € retirés ; reste dû 120,00 €/.test(entree.detail)));
    });

    test('règlements : pas d’annulation totale après encaissement ; un avoir après règlement crée un trop-perçu', async () => {
      const client = await clientReglement('TEST Client règlements annulation');
      const facture = await emettrePourReglement(client, 'annulation encaissée', 100);
      const acompte = await enregistrerReglement({ clientId: client, montant: 50, affectations: [{ factureId: facture.id, montant: 50 }] });
      assert.equal(acompte.status, 201, JSON.stringify(acompte.body));
      const refus = await request(app).post(`/api/factures/${facture.id}/annuler`).set('Authorization', `Bearer ${session}`);
      assert.equal(refus.status, 409, JSON.stringify(refus.body));
      assert.match(refus.body.error, /a reçu un règlement/);
      assert.equal(await prisma.facture.count({ where: { factureOrigineId: facture.id } }), 0, 'aucun avoir total n’est créé');
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: facture.id } })).statut, 'EMISE');
      assert.equal((await contrepasser(acompte.body.id)).status, 200);
      assert.equal((await request(app).post(`/api/factures/${facture.id}/annuler`).set('Authorization', `Bearer ${session}`)).status, 200);

      const soldee = await emettrePourReglement(client, 'trop-perçu', 100);
      assert.equal((await enregistrerReglement({ clientId: client, montant: 120, affectations: [{ factureId: soldee.id, montant: 120 }] })).status, 201);
      const avoir = await request(app).post(`/api/factures/${soldee.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST geste commercial', quantite: 1, prixUnitaireHt: 10, tauxTva: 20 }] });
      assert.equal(avoir.status, 201, JSON.stringify(avoir.body));
      const lue = await factureLue(soldee.id);
      assert.deepEqual([lue.statut, lue.montantRegle, lue.montantAvoirs, lue.resteDu], ['REGLEE', 120, 12, -12]);
    });

    test('statut « réglée » : même résultat quel que soit l’ordre des règlements, avoirs et contre-passations', async () => {
      const client = await clientReglement('TEST Client règlements ordre');
      const avoir = (facture, prixUnitaireHt) => request(app).post(`/api/factures/${facture.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST avoir ordre', quantite: 1, prixUnitaireHt, tauxTva: 20 }] });
      const etat = async (facture) => { const lue = await factureLue(facture.id); return [lue.statut, lue.montantRegle, lue.montantAvoirs, lue.resteDu]; };
      // A : un règlement, puis un avoir qui solde la facture.
      const a = await emettrePourReglement(client, 'ordre A', 100);
      assert.equal((await enregistrerReglement({ clientId: client, montant: 60, affectations: [{ factureId: a.id, montant: 60 }] })).status, 201);
      assert.equal((await avoir(a, 50)).status, 201);
      assert.deepEqual(await etat(a), ['REGLEE', 60, 60, 0]);
      assert.ok((await journalDe(a.id)).some((entree) => entree.action === 'REGLEMENT' && /EMISE → REGLEE \(avoir partiel /.test(entree.detail) && entree.acteurId), 'la transition par l’avoir est journalisée');
      // B : l'avoir d'abord, le règlement ensuite : même état final.
      const b = await emettrePourReglement(client, 'ordre B', 100);
      assert.equal((await avoir(b, 50)).status, 201);
      assert.deepEqual(await etat(b), ['EMISE', 0, 60, 60]);
      assert.equal((await enregistrerReglement({ clientId: client, montant: 60, affectations: [{ factureId: b.id, montant: 60 }] })).status, 201);
      assert.deepEqual(await etat(b), ['REGLEE', 60, 60, 0]);
      // C : soldée, créditée en totalité, puis règlement contre-passé : sans règlement, elle redevient émise.
      const c = await emettrePourReglement(client, 'ordre C', 100);
      const integral = await enregistrerReglement({ clientId: client, montant: 120, affectations: [{ factureId: c.id, montant: 120 }] });
      assert.equal(integral.status, 201, JSON.stringify(integral.body));
      assert.equal((await avoir(c, 100)).status, 201);
      assert.deepEqual(await etat(c), ['REGLEE', 120, 120, -120]);
      assert.equal((await contrepasser(integral.body.id)).status, 200);
      assert.deepEqual(await etat(c), ['EMISE', 0, 120, 0]);
      assert.ok((await journalDe(c.id)).some((entree) => entree.action === 'RETOUR_EMISE' && /REGLEE → EMISE \(contre-passation du règlement /.test(entree.detail)));
      // D : partiellement réglée, puis un avoir plus grand que le reste dû : réglée, avec un trop-perçu.
      const d = await emettrePourReglement(client, 'ordre D', 100);
      assert.equal((await enregistrerReglement({ clientId: client, montant: 50, affectations: [{ factureId: d.id, montant: 50 }] })).status, 201);
      assert.equal((await avoir(d, 100)).status, 201);
      assert.deepEqual(await etat(d), ['REGLEE', 50, 120, -50]);
    });

    test('règlements : le compte qui a saisi un règlement ne se supprime pas, il se désactive', async () => {
      const client = await clientReglement('TEST Client règlements auteur');
      const facture = await emettrePourReglement(client, 'auteur', 100);
      const auteur = await prisma.user.create({ data: { email: `reglement.auteur.${Date.now()}@iris.test`, name: 'TEST Auteur règlement', role: 'ADMIN' } });
      const saisie = await request(app).post('/api/reglements').set('Authorization', `Bearer ${jwt.sign({ id: auteur.id }, process.env.JWT_SECRET)}`)
        .send({ clientId: client, dateReglement: '12-09-2026', montant: 10, moyen: 'VIREMENT', affectations: [{ factureId: facture.id, montant: 10 }] });
      assert.equal(saisie.status, 201, JSON.stringify(saisie.body));
      assert.equal(saisie.body.createdBy.id, auteur.id);
      const suppression = await request(app).delete(`/api/users/${auteur.id}`).set('Authorization', `Bearer ${session}`);
      assert.equal(suppression.status, 409, JSON.stringify(suppression.body));
      assert.match(suppression.body.error, /auteur de données tracées/);
      assert.ok(await prisma.user.findUnique({ where: { id: auteur.id } }));
    });

    test('base : règlements immuables, entièrement affectés, dans le reste dû et le client de la facture', async () => {
      const client = await clientReglement('TEST Client règlements base');
      const autre = await clientReglement('TEST Client règlements base autre');
      const facture = await emettrePourReglement(client, 'garde SQL', 100);
      const factureAutre = await emettrePourReglement(autre, 'garde SQL autre', 100);
      const premier = await enregistrerReglement({ clientId: client, montant: 20, affectations: [{ factureId: facture.id, montant: 20 }] });
      assert.equal(premier.status, 201, JSON.stringify(premier.body));
      const auteur = premier.body.createdById;
      const affectation = await prisma.affectationReglement.findFirstOrThrow({ where: { reglementId: premier.body.id } });
      const brut = (champs) => ({ clientId: client, dateReglement: new Date('2026-09-12T00:00:00.000Z'), montant: 5, moyen: 'VIREMENT', createdById: auteur, ...champs });

      // Le client, le numéro, les dates et les montants d'une facture émise sont figés en base.
      for (const data of [{ clientId: autre }, { totalTtc: 1 }, { numero: `TEST-REECRIT-${Date.now()}` }, { dateEcheance: new Date('2030-01-01T00:00:00.000Z') }]) {
        await assert.rejects(() => prisma.facture.update({ where: { id: facture.id }, data }), /client, numéro, type, dates et montants sont immuables/, JSON.stringify(data));
      }
      // Une facture ne naît jamais « réglée », même écrite directement en base.
      await assert.rejects(() => prisma.facture.create({ data: { clientId: client, clientRaisonSociale: 'TEST Client règlements base', type: 'FACTURE', statut: 'REGLEE', numero: `TEST-NEE-REGLEE-${Date.now()}`, dateEmission: new Date('2026-09-11T00:00:00.000Z'), dateEcheance: new Date('2026-09-11T00:00:00.000Z'), totalHt: 10, totalTva: 2, totalTtc: 12, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST garde' } }), /jamais créée « réglée »/);
      await assert.rejects(() => prisma.reglement.update({ where: { id: premier.body.id }, data: { montant: 10 } }), /Règlement figé/);
      await assert.rejects(() => prisma.reglement.update({ where: { id: premier.body.id }, data: { reference: 'réécrite' } }), /Règlement figé/);
      await assert.rejects(() => prisma.reglement.delete({ where: { id: premier.body.id } }), /Règlement figé/);
      await assert.rejects(() => prisma.affectationReglement.update({ where: { id: affectation.id }, data: { montant: 1 } }), /Affectation de règlement figée/);
      await assert.rejects(() => prisma.affectationReglement.delete({ where: { id: affectation.id } }), /Affectation de règlement figée/);
      await assert.rejects(() => prisma.reglement.update({ where: { id: premier.body.id }, data: { statut: 'CONTREPASSE' } }), /Reglement_contrepassation_check/);
      // Prisma résout une transaction interactive même si son COMMIT échoue : la garde différée
      // est donc vérifiée explicitement, comme le fait l'API, puis par une écriture simple.
      await assert.rejects(() => prisma.$transaction(async tx => { await tx.reglement.create({ data: brut({}) }); await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; }), /affectations totalisent 0/);
      await assert.rejects(() => prisma.reglement.create({ data: brut({}) }), /affectations totalisent 0/);
      await assert.rejects(() => prisma.reglement.create({ data: brut({ montant: 10, affectations: { create: [{ factureId: facture.id, montant: 5 }] } }) }), /affectations totalisent 5/);
      await assert.rejects(() => prisma.reglement.create({ data: brut({ affectations: { create: [{ factureId: factureAutre.id, montant: 5 }] } }) }), /son client/);
      await assert.rejects(() => prisma.reglement.create({ data: brut({ statut: 'CONTREPASSE', motifContrepassation: 'TEST direct', contrepasseLe: new Date(), contrepasseParId: auteur, affectations: { create: [{ factureId: facture.id, montant: 5 }] } }) }), /créé enregistré/);
      await assert.rejects(() => prisma.reglement.create({ data: brut({ dateReglement: new Date('2026-09-12T10:00:00.000Z'), affectations: { create: [{ factureId: facture.id, montant: 5 }] } }) }), /Reglement_date_check/);
      await assert.rejects(() => prisma.reglement.create({ data: brut({ moyen: 'TROC', affectations: { create: [{ factureId: facture.id, montant: 5 }] } }) }), /Reglement_moyen_check/);
      await assert.rejects(() => prisma.facture.update({ where: { id: facture.id }, data: { statut: 'REGLEE' } }), /soldée par ses règlements/);
      await assert.rejects(() => prisma.facture.update({ where: { id: facture.id }, data: { statut: 'ANNULEE' } }), /reçu un règlement/);
      assert.equal(await prisma.reglement.count({ where: { clientId: client } }), 1);

      const solde = await enregistrerReglement({ clientId: client, montant: 100, affectations: [{ factureId: facture.id, montant: 100 }] });
      assert.equal(solde.status, 201, JSON.stringify(solde.body));
      await assert.rejects(() => prisma.facture.update({ where: { id: facture.id }, data: { statut: 'EMISE' } }), /reste « réglée »/);
      // Soldée par son seul avoir, une facture ne reçoit plus d'affectation, même écrite en base.
      const soldeeParAvoir = await emettrePourReglement(client, 'garde SQL soldée par avoir', 100);
      assert.equal((await request(app).post(`/api/factures/${soldeeParAvoir.id}/avoirs`).set('Authorization', `Bearer ${session}`).send({ lignes: [{ designation: 'TEST avoir garde', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] })).status, 201);
      await assert.rejects(() => prisma.reglement.create({ data: brut({ affectations: { create: [{ factureId: soldeeParAvoir.id, montant: 5 }] } }) }), /est soldée/);
      // Réglée, elle ne reçoit plus d'affectation, même écrite directement en base.
      await assert.rejects(() => prisma.reglement.create({ data: brut({ affectations: { create: [{ factureId: facture.id, montant: 5 }] } }) }), /émise non soldée/);
      assert.equal((await contrepasser(premier.body.id)).status, 200);
      await assert.rejects(() => prisma.reglement.update({ where: { id: premier.body.id }, data: { statut: 'ENREGISTRE', motifContrepassation: null, contrepasseLe: null, contrepasseParId: null } }), /Règlement figé/);
      assert.equal(await totalAffecte(facture.id), 100);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: facture.id } })).statut, 'EMISE');
    });

    test('base : le statut « réglée » reste cohérent avec les règlements au COMMIT, même par écriture directe', async () => {
      const client = await clientReglement('TEST Client statut différé');
      const facture = await emettrePourReglement(client, 'statut différé', 100);
      const regle = await enregistrerReglement({ clientId: client, montant: 120, affectations: [{ factureId: facture.id, montant: 120 }] });
      assert.equal(regle.status, 201, JSON.stringify(regle.body));
      // Contre-passation écrite directement : la facture resterait « réglée » sans règlement.
      await assert.rejects(() => prisma.$executeRaw`UPDATE "Reglement" SET "statut" = 'CONTREPASSE', "motifContrepassation" = 'TEST direct', "contrepasseLe" = now(), "contrepasseParId" = ${regle.body.createdById} WHERE "id" = ${regle.body.id}`, /incohérent avec ses règlements/);
      assert.equal((await prisma.reglement.findUniqueOrThrow({ where: { id: regle.body.id } })).statut, 'ENREGISTRE');
      // Affectation directe qui solde une facture sans la passer « réglée ».
      const autre = await emettrePourReglement(client, 'statut différé solde', 100);
      await assert.rejects(() => prisma.reglement.create({ data: { clientId: client, dateReglement: new Date('2026-09-12T00:00:00.000Z'), montant: 120, moyen: 'VIREMENT', createdById: regle.body.createdById, affectations: { create: [{ factureId: autre.id, montant: 120 }] } } }), /incohérent avec ses règlements/);
      assert.equal(await prisma.reglement.count({ where: { clientId: client } }), 1);
      // Par l'API, la même affectation passe : le statut est synchronisé avant le COMMIT.
      assert.equal((await enregistrerReglement({ clientId: client, montant: 120, affectations: [{ factureId: autre.id, montant: 120 }] })).status, 201);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: autre.id } })).statut, 'REGLEE');
    });

    test('transactions : une contrainte différée violée fait échouer la route, sans faux succès ni écriture', async () => {
      // Prisma résout une transaction interactive même si son COMMIT échoue : un trigger différé de
      // test, toujours en échec, prouve que chaque route vérifie ses contraintes avant de répondre.
      const client = await clientReglement('TEST Client transactions différées');
      const brouillon = await request(app).post('/api/factures').set('Authorization', `Bearer ${session}`).send({ clientId: client, origine: 'HORS_AFFAIRE', motifHorsAffaire: 'TEST différé', dateEmission: '11-09-2026', dateEcheance: '11-10-2026', lignes: [{ designation: 'TEST différé', quantite: 1, prixUnitaireHt: 100, tauxTva: 20 }] });
      assert.equal(brouillon.status, 201, JSON.stringify(brouillon.body));
      const emise = await emettrePourReglement(client, 'différé émise', 100);
      const compteTva = await prisma.compteComptable.findUniqueOrThrow({ where: { code: '445710' } });
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_echec_differe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST échec différé'; END $$`);
      try {
        await prisma.$executeRawUnsafe('CREATE CONSTRAINT TRIGGER test_echec_differe_facture AFTER INSERT ON "JournalFacture" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_echec_differe()');
        await prisma.$executeRawUnsafe('CREATE CONSTRAINT TRIGGER test_echec_differe_regle AFTER INSERT ON "JournalRegleComptable" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_echec_differe()');
        const emission = await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`);
        assert.equal(emission.status, 500, JSON.stringify(emission.body));
        const relue = await prisma.facture.findUniqueOrThrow({ where: { id: brouillon.body.id } });
        assert.deepEqual([relue.statut, relue.numero], ['BROUILLON', null]);
        const reglement = await enregistrerReglement({ clientId: client, montant: 120, affectations: [{ factureId: emise.id, montant: 120 }] });
        assert.equal(reglement.status, 500, JSON.stringify(reglement.body));
        assert.equal(await prisma.reglement.count({ where: { clientId: client } }), 0);
        const annulation = await request(app).post(`/api/factures/${emise.id}/annuler`).set('Authorization', `Bearer ${session}`);
        assert.equal(annulation.status, 500, JSON.stringify(annulation.body));
        assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: emise.id } })).statut, 'EMISE');
        const tva = await request(app).put('/api/comptabilite/tva/3.3').set('Authorization', `Bearer ${session}`).send({ compteId: compteTva.id, motif: 'TEST différé' });
        assert.equal(tva.status, 500, JSON.stringify(tva.body));
        assert.equal((await prisma.regleTvaComptable.findMany()).filter((regle) => Number(regle.taux) === 3.3).length, 0, 'taux inutilisé ailleurs dans les tests');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_echec_differe_facture ON "JournalFacture"');
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_echec_differe_regle ON "JournalRegleComptable"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_echec_differe()');
      }
      // Sans le trigger de test, la même émission réussit : l'échec venait bien de lui.
      assert.equal((await request(app).post(`/api/factures/${brouillon.body.id}/emettre`).set('Authorization', `Bearer ${session}`)).status, 200);
    });

    test('courses : un seul règlement du reste dû, jamais règlement et annulation ensemble, une seule contre-passation, sans interblocage', async () => {
      const client = await clientReglement('TEST Client règlements courses');
      const disputee = await emettrePourReglement(client, 'course reste dû', 100);
      const tout = () => enregistrerReglement({ clientId: client, montant: 120, affectations: [{ factureId: disputee.id, montant: 120 }] });
      const doubles = await sousVerrouFacture(disputee.id, () => [tout(), tout()]);
      assert.deepEqual(doubles.map((reponse) => reponse.status).sort(), [201, 409], JSON.stringify(doubles.map((reponse) => reponse.body)));
      assert.equal(await totalAffecte(disputee.id), 120);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: disputee.id } })).statut, 'REGLEE');

      const annulable = await emettrePourReglement(client, 'course annulation', 100);
      const [annulation, paiement] = await sousVerrouFacture(annulable.id, () => [
        request(app).post(`/api/factures/${annulable.id}/annuler`).set('Authorization', `Bearer ${session}`),
        enregistrerReglement({ clientId: client, montant: 50, affectations: [{ factureId: annulable.id, montant: 50 }] }),
      ]);
      assert.deepEqual([annulation.status, paiement.status].filter((statut) => statut < 300).length, 1, JSON.stringify([annulation.body, paiement.body]));
      const etat = await prisma.facture.findUniqueOrThrow({ where: { id: annulable.id }, select: { statut: true, avoirs: { select: { id: true } } } });
      if (annulation.status === 200) assert.deepEqual([etat.statut, etat.avoirs.length, await totalAffecte(annulable.id)], ['ANNULEE', 1, 0]);
      else assert.deepEqual([etat.statut, etat.avoirs.length, await totalAffecte(annulable.id)], ['EMISE', 0, 50]);

      const contestee = await emettrePourReglement(client, 'course contre-passation', 100);
      const saisie = await enregistrerReglement({ clientId: client, montant: 120, affectations: [{ factureId: contestee.id, montant: 120 }] });
      assert.equal(saisie.status, 201, JSON.stringify(saisie.body));
      const contrepassations = await sousVerrouFacture(contestee.id, () => [contrepasser(saisie.body.id), contrepasser(saisie.body.id)]);
      assert.deepEqual(contrepassations.map((reponse) => reponse.status).sort(), [200, 409]);
      assert.equal((await journalDe(contestee.id)).filter((entree) => entree.action === 'REGLEMENT_CONTREPASSE').length, 1);
      assert.equal((await prisma.facture.findUniqueOrThrow({ where: { id: contestee.id } })).statut, 'EMISE');

      // Deux règlements qui citent les mêmes factures dans l'ordre inverse : verrous pris par
      // identifiant croissant, ils s'attendent et réussissent tous les deux.
      const a = await emettrePourReglement(client, 'ordre a', 100);
      const b = await emettrePourReglement(client, 'ordre b', 100);
      const premiere = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1))[0];
      const croises = await sousVerrouFacture(premiere.id, () => [
        enregistrerReglement({ clientId: client, montant: 20, affectations: [{ factureId: a.id, montant: 10 }, { factureId: b.id, montant: 10 }] }),
        enregistrerReglement({ clientId: client, montant: 20, affectations: [{ factureId: b.id, montant: 10 }, { factureId: a.id, montant: 10 }] }),
      ]);
      assert.deepEqual(croises.map((reponse) => reponse.status), [201, 201], JSON.stringify(croises.map((reponse) => reponse.body)));
      assert.deepEqual([await totalAffecte(a.id), await totalAffecte(b.id)], [20, 20]);
    });
  });

  describe('Identité de la société', () => {
    let session = '';
    before(async () => {
      const res = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      session = res.body.token;
    });

    test('refuse une couleur qui n’est pas un hexadécimal', async () => {
      const res = await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ couleurPrimaire: 'rouge' });
      assert.equal(res.status, 400);
    });

    test('enregistre et relit l’identité', async () => {
      const maj = await request(app).put('/api/company')
        .set('Authorization', `Bearer ${session}`)
        .send({ raisonSociale: 'TEST Société', couleurPrimaire: '#1E3A8A' });
      assert.equal(maj.status, 200);
      assert.equal(maj.body.couleurPrimaire, '#1e3a8a');

      const lecture = await request(app).get('/api/company').set('Authorization', `Bearer ${session}`);
      assert.equal(lecture.body.raisonSociale, 'TEST Société');
    });

    test('lit weekStart et weekEnd dans le fuseau société pour une référence instant', async () => {
      // Le dimanche 1er mars UTC est déjà lundi 2 mars à Wallis : l’API ne doit pas
      // répondre avec la semaine UTC précédente.
      const maj = await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Wallis' });
      assert.equal(maj.status, 200, JSON.stringify(maj.body));
      const res = await request(app)
        .get('/api/stats/conducteurs/assiduite')
        .query({ week: '2026-03-01T12:30:00.000Z' })
        .set('Authorization', `Bearer ${session}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.weekStart, '2026-03-02');
      assert.equal(res.body.weekEnd, '2026-03-06');
    });

    test('date la clôture d’un chantier au jour civil de la société, à minuit', async () => {
      const { aujourdHuiEntreprise } = await import('../dist/index.js');
      const jourUtc = new Date().toISOString().slice(0, 10);
      // On retient le fuseau dont le jour civil diffère d'UTC : Wallis (+12) le fait à
      // partir de 12:00 UTC, Tahiti (-10) jusqu'à 09:59. Fixer Wallis seule laisserait
      // le test aveugle douze heures par jour. Entre 10:00 et 11:59 UTC, aucun fuseau
      // français autorisé ne diffère d'UTC : cette fenêtre de deux heures est irréductible.
      const fuseau = aujourdHuiEntreprise('Pacific/Wallis') !== jourUtc ? 'Pacific/Wallis' : 'Pacific/Tahiti';
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      const chantier = await prisma.chantier.create({
        data: { nom: 'TEST clôture fuseau', client: 'TEST', dateDebut: new Date(Date.UTC(2026, 8, 1)), budgetGlobalVendu: 1000, statut: 'EN_COURS' },
      });
      try {
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseau })).status, 200);
        const cloture = await request(app).patch(`/api/chantiers/${chantier.id}/statut`).set('Authorization', `Bearer ${session}`).send({ statut: 'TERMINE' });
        assert.equal(cloture.status, 200, JSON.stringify(cloture.body));
        const relu = await prisma.chantier.findUnique({ where: { id: chantier.id }, select: { dateFin: true } });
        assert.equal(relu.dateFin.toISOString(), `${aujourdHuiEntreprise(fuseau)}T00:00:00.000Z`,
          `la clôture doit porter le jour civil de la société en ${fuseau}, à minuit`);
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        await prisma.chantier.delete({ where: { id: chantier.id } });
      }
    });

    test('range une saisie d’heures au jour et à l’heure de la société, pas d’UTC', async () => {
      // Mardi 09:00 à Wallis est lundi 21:00 UTC : cet instant sépare le jour et l'heure.
      // À 06:00 UTC, Wallis est aussi mardi : une route lisant le jour UTC passerait.
      const instantSaisie = new Date('2026-03-02T21:00:00.000Z');
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      const conducteur = await prisma.user.create({ data: { email: 'assiduite.fuseau@iris.test', name: 'TEST Conducteur assiduité', role: 'CONDUCTEUR_TRAVAUX' } });
      const chantier = await prisma.chantier.create({
        data: { nom: 'TEST assiduité fuseau', client: 'TEST', dateDebut: new Date(Date.UTC(2026, 2, 1)), budgetGlobalVendu: 1000, responsableId: conducteur.id },
      });
      const intervenant = await prisma.intervenant.create({ data: { nom: 'TEST Intervenant assiduité', role: 'TECHNICIEN', tauxHoraireCharge: 30 } });
      const pointage = await prisma.pointageHeure.create({
        data: { date: new Date(Date.UTC(2026, 2, 3)), intervenantId: intervenant.id, chantierId: chantier.id, nbrHeures: 7, tauxHoraireApplique: 30, createdAt: instantSaisie, createdById: conducteur.id, updatedById: conducteur.id },
      });
      try {
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Wallis' })).status, 200);
        const res = await request(app).get('/api/stats/conducteurs/assiduite').query({ week: '2026-03-02' }).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const ligne = res.body.conducteurs.find((c) => c.id === conducteur.id);
        assert.ok(ligne, 'le conducteur de test est absent de la réponse');
        assert.equal(ligne.days[1].nbSaisies, 1, 'la saisie appartient au mardi de Wallis');
        assert.equal(ligne.days[0].nbSaisies, 0, 'une arithmétique UTC la rangerait au lundi');
        assert.equal(ligne.heurePic, 9, 'l’heure de pic est 9h à Wallis, pas 21h UTC');
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        await prisma.pointageHeure.delete({ where: { id: pointage.id } });
        await prisma.chantier.delete({ where: { id: chantier.id } });
        await prisma.intervenant.delete({ where: { id: intervenant.id } });
        await prisma.user.delete({ where: { id: conducteur.id } });
      }
    });

    // Lot (h) : la modale d'affectation saisit ses dates en JJ-MM-AAAA. Le serveur les lit comme les
    // autres dates métier (dateIsoStricte) : JJ-MM-AAAA ou AAAA-MM-JJ, sans débordement ni suffixe.
    test('les dates d’une affectation se saisissent en JJ-MM-AAAA, et sont lues strictement', async () => {
      const auth = { Authorization: `Bearer ${session}` };
      const intervenant = await request(app).post('/api/intervenants').set(auth).send({ nom: `TEST Format planning ${Date.now()}`, role: 'Technicien', tauxHoraireCharge: 40 });
      assert.equal(intervenant.status, 200, JSON.stringify(intervenant.body));
      const creees = [];
      const creer = (dates) => request(app).post('/api/planning/events').set(auth).send({ categorie: 'HORS_CHANTIER', titre: 'TEST Format planning', intervenantIds: [intervenant.body.id], ...dates });
      try {
        for (const [dates, attendu] of [
          [{ dateDebut: '20-10-2026', dateFin: '21-10-2026' }, ['2026-10-20', '2026-10-21']],
          [{ dateDebut: '2026-10-20', dateFin: '2026-10-21' }, ['2026-10-20', '2026-10-21']],
          [{ dateDebut: '20-10-2026' }, ['2026-10-20', '2026-10-20']],
        ]) {
          const reponse = await creer(dates);
          assert.equal(reponse.status, 201, `${JSON.stringify(dates)} : ${JSON.stringify(reponse.body)}`);
          creees.push(reponse.body.id);
          assert.deepEqual([reponse.body.dateDebut, reponse.body.dateFin], attendu.map((jour) => `${jour}T00:00:00.000Z`));
        }
        // Auparavant : le 30 février enregistré au 2 mars, un suffixe quelconque ignoré, JJ-MM-AAAA refusé.
        for (const dateDebut of ['2026-02-30', '30-02-2026', '2026-10-20xyz', '20/10/2026', '2026-10-20 10:00']) {
          const refuse = await creer({ dateDebut });
          if (refuse.status === 201) creees.push(refuse.body.id);
          assert.equal(refuse.status, 400, `${dateDebut} : ${JSON.stringify(refuse.body)}`);
        }
        const finInvalide = await creer({ dateDebut: '20-10-2026', dateFin: '31-11-2026' });
        if (finInvalide.status === 201) creees.push(finInvalide.body.id);
        assert.equal(finInvalide.status, 400, JSON.stringify(finInvalide.body));
      } finally {
        for (const id of creees) await request(app).delete(`/api/planning/events/${id}`).set(auth);
        await request(app).delete(`/api/intervenants/${intervenant.body.id}`).set(auth);
      }
    });

    // Décision de Nelson (14-10-2026) : toutes les dates suivent la société, où que se trouve le
    // lecteur. La page publique n'a pas de session : le serveur lui donne le jour, la semaine et
    // le fuseau de la société. L'horloge est figée au dernier dimanche 21 h UTC passé : Wallis est
    // déjà au lundi, si bien que son jour et sa semaine diffèrent de ceux d'UTC.
    test('le planning public donne le jour, la semaine et le fuseau de la société', async () => {
      const jourDans = (fuseau) => new Intl.DateTimeFormat('en-CA', { timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const fuseau = 'Pacific/Wallis';
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      const partageInitial = await prisma.planningPublicShare.findUnique({ where: { id: 'singleton' } });
      const token = `test-planning-public-${Date.now()}`;
      try {
        figerHorlogeA21hUtc({ dimanche: true });
        assert.notEqual(jourDans(fuseau), jourDans('UTC'), 'le jour de la société diffère de celui d’UTC');
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseau })).status, 200);
        await prisma.planningPublicShare.upsert({ where: { id: 'singleton' }, update: { token, active: true }, create: { id: 'singleton', token, active: true } });
        const aujourdhui = jourDans(fuseau);
        const jourSemaine = new Date(`${aujourdhui}T00:00:00Z`).getUTCDay();
        const lundi = new Date(Date.parse(`${aujourdhui}T00:00:00Z`) + (jourSemaine === 0 ? -6 : 1 - jourSemaine) * 86400000).toISOString().slice(0, 10);
        const dimanche = new Date(Date.parse(`${lundi}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
        // Semaine UTC (lundi du jour UTC) : différente de celle de la société, sans quoi un lundi
        // calculé depuis le jour UTC passerait inaperçu.
        const jourUtc = jourDans('UTC');
        const lundiUtc = new Date(Date.parse(`${jourUtc}T00:00:00Z`) - ((new Date(`${jourUtc}T00:00:00Z`).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
        assert.notEqual(lundi, lundiUtc, 'la semaine de la société diffère de la semaine UTC');

        const semaine = await request(app).get(`/api/planning/public/${token}`);
        assert.equal(semaine.status, 200, JSON.stringify(semaine.body));
        assert.equal(semaine.body.fuseauHoraire, fuseau);
        assert.equal(semaine.body.aujourdhui, aujourdhui, 'le jour de la société, et non celui d’UTC');
        assert.deepEqual([semaine.body.debut, semaine.body.fin], [lundi, dimanche], 'sans plage, la semaine du jour de la société');

        const plage = await request(app).get(`/api/planning/public/${token}`).query({ start: '2026-03-02', end: '2026-03-08' });
        assert.equal(plage.status, 200, JSON.stringify(plage.body));
        assert.deepEqual([plage.body.debut, plage.body.fin, plage.body.aujourdhui], ['2026-03-02', '2026-03-08', aujourdhui]);
        assert.equal((await request(app).get(`/api/planning/public/${token}`).query({ start: '2026-03-02' })).status, 400, 'une plage incomplète reste refusée');

        // Dimanche de la société : horloge figée au dernier samedi 13 h UTC passé, déjà dimanche
        // 01:00 à Wallis. La semaine servie est celle du lundi précédent, et non la suivante.
        mock.timers.reset();
        const maintenant = new Date();
        let samedi = Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate(), 13);
        if (samedi > maintenant.getTime()) samedi -= 86_400_000;
        while (new Date(samedi).getUTCDay() !== 6) samedi -= 86_400_000;
        mock.timers.enable({ apis: ['Date'], now: samedi });
        const dimancheSociete = jourDans(fuseau);
        assert.equal(new Date(`${dimancheSociete}T00:00:00Z`).getUTCDay(), 0, 'la société est au dimanche');
        const lundiPrecedent = new Date(Date.parse(`${dimancheSociete}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
        const semaineDimanche = await request(app).get(`/api/planning/public/${token}`);
        assert.equal(semaineDimanche.status, 200, JSON.stringify(semaineDimanche.body));
        assert.deepEqual([semaineDimanche.body.aujourdhui, semaineDimanche.body.debut, semaineDimanche.body.fin], [dimancheSociete, lundiPrecedent, dimancheSociete], 'un dimanche appartient à la semaine de son lundi');
      } finally {
        mock.timers.reset();
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        if (partageInitial) await prisma.planningPublicShare.update({ where: { id: 'singleton' }, data: { token: partageInitial.token, active: partageInitial.active } });
        else await prisma.planningPublicShare.deleteMany({ where: { id: 'singleton' } });
      }
    });

    // Un chantier converti avant #130 commence à un instant, les autres à une date-seule : chacun
    // compte au jour civil de la société, et non au jour UTC.
    test('les statistiques par type comptent un chantier au jour civil de son début dans la société', async () => {
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      const compter = async (ref) => {
        const res = await request(app).get('/api/stats/types-chantiers').query({ period: 'month', ref }).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return Object.fromEntries(res.body.types.map((t) => [t.type, t.count]));
      };
      const chantiers = [];
      try {
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Europe/Paris' })).status, 200);
        const avant = { octobre: await compter('2026-10-15'), novembre: await compter('2026-11-15') };
        const vente = { client: 'TEST Client types', budgetGlobalVendu: 0 };
        // 31-10 à 23:30 UTC : le 1er novembre à Paris.
        chantiers.push(await prisma.chantier.create({ data: { ...vente, nom: 'TEST Types début instant', dateDebut: new Date('2026-10-31T23:30:00.000Z'), types: ['Vidéo'] } }));
        // Date-seule du 30-11 : novembre, lue telle quelle.
        chantiers.push(await prisma.chantier.create({ data: { ...vente, nom: 'TEST Types début date-seule', dateDebut: new Date('2026-11-30T00:00:00.000Z'), types: ['Alarme'] } }));
        // 30-11 à 23:30 UTC : le 1er décembre à Paris.
        chantiers.push(await prisma.chantier.create({ data: { ...vente, nom: 'TEST Types début décembre', dateDebut: new Date('2026-11-30T23:30:00.000Z'), types: ['Interphonie'] } }));
        const apres = { octobre: await compter('2026-10-15'), novembre: await compter('2026-11-15') };
        assert.equal(apres.novembre['Vidéo'] - avant.novembre['Vidéo'], 1, 'le 1er novembre à Paris compte en novembre');
        assert.equal(apres.octobre['Vidéo'] - avant.octobre['Vidéo'], 0, 'et non en octobre (jour UTC)');
        assert.equal(apres.novembre['Alarme'] - avant.novembre['Alarme'], 1, 'une date-seule compte à son jour');
        assert.equal(apres.novembre['Interphonie'] - avant.novembre['Interphonie'], 0, 'le 1er décembre à Paris ne compte pas en novembre');

        // Société à l'ouest d'UTC (Tahiti, UTC−10) : un début au 01-12 à 05:00 UTC est encore le
        // 30-11 dans la société, une date-seule du 01-12 reste le 01-12.
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Tahiti' })).status, 200);
        const avantTahiti = { novembre: await compter('2026-11-15'), decembre: await compter('2026-12-15') };
        chantiers.push(await prisma.chantier.create({ data: { ...vente, nom: 'TEST Types début Tahiti', dateDebut: new Date('2026-12-01T05:00:00.000Z'), types: ["Contrôle d'accès"] } }));
        chantiers.push(await prisma.chantier.create({ data: { ...vente, nom: 'TEST Types date-seule Tahiti', dateDebut: new Date('2026-12-01T00:00:00.000Z'), types: ['Câblage réseau'] } }));
        const apresTahiti = { novembre: await compter('2026-11-15'), decembre: await compter('2026-12-15') };
        assert.equal(apresTahiti.novembre["Contrôle d'accès"] - avantTahiti.novembre["Contrôle d'accès"], 1, 'le 30-11 à Tahiti compte en novembre');
        assert.equal(apresTahiti.decembre["Contrôle d'accès"] - avantTahiti.decembre["Contrôle d'accès"], 0, 'et non en décembre (jour UTC)');
        assert.equal(apresTahiti.decembre['Câblage réseau'] - avantTahiti.decembre['Câblage réseau'], 1, 'une date-seule du 01-12 compte en décembre');
        assert.equal(apresTahiti.novembre['Câblage réseau'] - avantTahiti.novembre['Câblage réseau'], 0, 'et non en novembre');
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
        await prisma.chantier.deleteMany({ where: { id: { in: chantiers.map((c) => c.id) } } });
      }
    });

    test('borne la période du tableau de bord dans le fuseau société', async () => {
      // À 13:00 UTC, Paris (le repli) est encore en février, Wallis déjà en mars. À
      // 23:30 UTC ils seraient tous deux en mars : le test passerait sans réglage société.
      const fuseauInitial = (await request(app).get('/api/company').set('Authorization', `Bearer ${session}`)).body.fuseauHoraire;
      try {
        assert.equal((await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Wallis' })).status, 200);
        const res = await request(app).get('/api/stats/global').query({ period: 'month', ref: '2026-02-28T13:00:00.000Z' }).set('Authorization', `Bearer ${session}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.periodStart, '2026-03-01', 'la période suit le jour civil de la société');
        assert.equal(res.body.periodEnd, '2026-03-31');
      } finally {
        await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: fuseauInitial || 'Europe/Paris' });
      }
    });

    test('n’accepte que les fuseaux horaires français et expose le réglage', async () => {
      const invalide = await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Europe/London' });
      assert.equal(invalide.status, 400, JSON.stringify(invalide.body));
      const maj = await request(app).put('/api/company').set('Authorization', `Bearer ${session}`).send({ fuseauHoraire: 'Pacific/Noumea' });
      assert.equal(maj.status, 200, JSON.stringify(maj.body));
      assert.equal(maj.body.fuseauHoraire, 'Pacific/Noumea');
      const lecture = await request(app).get('/api/company').set('Authorization', `Bearer ${session}`);
      assert.equal(lecture.body.fuseauHoraire, 'Pacific/Noumea');
    });
  });

  // Lot (a), décision de Nelson du 13-10-2026 : tout changement de réglage et de droits d'un compte
  // est journalisé (qui, quoi, avant, après), consultable et exportable par les seuls
  // administrateurs ; un simple administrateur ne voit ni les entrées qui concernent un compte
  // super administrateur, ni l'historique des clés d'intégration (précisions du 14-10-2026).
  describe('Journal des paramètres et des droits', () => {
    let superAuth;
    let adminAuth;
    let admin;
    let conducteurAuth;
    const suffixe = Date.now();
    // Préfixe propre à ce bloc et à cette exécution : le nettoyage ne touche aucun compte créé
    // ailleurs (d'autres tests créent par exemple journal.regle.auteur@iris.test, auteur protégé
    // d'une entrée comptable).
    const prefixe = `jadm.${suffixe}.`;
    const email = (qui) => `${prefixe}${qui}@iris.test`;
    const journal = (auth, query = {}) => request(app).get('/api/journal-administration').query(query).set(auth);
    // Entrées d'une cible, telles que la route les montre à ce compte, de la plus ancienne à la plus
    // récente (la route les renvoie de la plus récente). Le filtre par cible garde le test juste
    // sur une base conservée, quel que soit le nombre d'entrées accumulées.
    const entreesDe = async (cibleId, auth = superAuth) => {
      const res = await journal(auth, { cible: cibleId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.total <= res.body.parPage, 'une seule page par cible');
      return res.body.entrees.reverse();
    };
    const derniere = async (type, auth = superAuth) => (await journal(auth, { type })).body.entrees[0];

    before(async () => {
      const login = await request(app).post('/api/auth/secours').send({ token: process.env.BREAK_GLASS_TOKEN });
      assert.equal(login.status, 200);
      superAuth = { Authorization: `Bearer ${login.body.token}` };
      admin = await prisma.user.create({ data: { email: email('admin'), name: `TEST Journal admin ${suffixe}`, role: 'ADMIN' } });
      adminAuth = { Authorization: `Bearer ${jwt.sign({ id: admin.id }, process.env.JWT_SECRET)}` };
      const conducteur = await prisma.user.create({ data: { email: email('conducteur'), name: 'TEST Journal conducteur', role: 'CONDUCTEUR_TRAVAUX' } });
      conducteurAuth = { Authorization: `Bearer ${jwt.sign({ id: conducteur.id }, process.env.JWT_SECRET)}` };
    });

    after(async () => {
      await prisma.user.deleteMany({ where: { email: { startsWith: prefixe } } });
    });

    test('chaque changement de droits d’un compte est journalisé, avec son auteur, avant et après', async () => {
      const responsable = await prisma.user.create({ data: { email: email('resp'), name: `TEST Journal responsable ${suffixe}`, role: 'RESPONSABLE' } });
      const creation = await request(app).post('/api/users').set(superAuth).send({ email: email('cible'), name: 'TEST Journal cible', role: 'CONDUCTEUR_TRAVAUX' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const id = creation.body.id;
      const etapes = [
        () => request(app).patch(`/api/users/${id}/role`).set(superAuth).send({ role: 'ADMIN' }),
        () => request(app).patch(`/api/users/${id}/est-commercial`).set(superAuth).send({ estCommercial: true }),
        () => request(app).put(`/api/users/${id}/permissions`).set(superAuth).send({ permissions: ['clients:read'] }),
        () => request(app).patch(`/api/users/${id}/acces-finance`).set(superAuth).send({ accesFinance: true }),
        () => request(app).patch(`/api/users/${id}/responsable-hierarchique`).set(superAuth).send({ responsableHierarchiqueId: responsable.id }),
        () => request(app).patch(`/api/users/${id}/actif`).set(superAuth).send({ actif: false }),
        // Même valeur : rien ne change, rien n'est journalisé.
        () => request(app).patch(`/api/users/${id}/actif`).set(superAuth).send({ actif: false }),
        () => request(app).delete(`/api/users/${id}`).set(superAuth),
      ];
      for (const etape of etapes) {
        const res = await etape();
        assert.equal(res.status, 200, JSON.stringify(res.body));
      }
      const entrees = await entreesDe(id);
      assert.deepEqual(entrees.map((e) => e.action), ['CREATION', 'TYPE_COMPTE', 'AUSSI_COMMERCIAL', 'PERMISSIONS', 'ACCES_FINANCE', 'RATTACHEMENT', 'DESACTIVATION', 'SUPPRESSION']);
      assert.ok(entrees.every((e) => e.domaine === 'DROITS' && e.type === 'COMPTE' && e.cibleLibelle === `TEST Journal cible (${email('cible')})`));
      const secours = await prisma.user.findUnique({ where: { email: 'secours@iris.test' } });
      assert.ok(entrees.every((e) => e.auteurId === secours.id && e.auteurNom === secours.name));
      const [cree, typeCompte, commercial, permissions, finance, rattachement, desactivation, suppression] = entrees;
      assert.equal(cree.avant, null);
      assert.deepEqual(cree.apres, { role: 'CONDUCTEUR_TRAVAUX', estCommercial: false, accesFinance: false, permissions: [], actif: true });
      assert.deepEqual([typeCompte.avant, typeCompte.apres], [{ role: 'CONDUCTEUR_TRAVAUX' }, { role: 'ADMIN' }]);
      assert.deepEqual([commercial.avant, commercial.apres], [{ estCommercial: false }, { estCommercial: true }]);
      assert.deepEqual([permissions.avant, permissions.apres], [{ permissions: [] }, { permissions: ['clients:read'] }]);
      assert.deepEqual([finance.avant, finance.apres], [{ accesFinance: false }, { accesFinance: true }]);
      assert.deepEqual([rattachement.avant, rattachement.apres], [{ responsableHierarchique: null }, { responsableHierarchique: responsable.name }]);
      assert.deepEqual([desactivation.avant, desactivation.apres], [{ actif: true }, { actif: false }]);
      assert.equal(suppression.apres, null);
      assert.equal(suppression.avant.role, 'ADMIN');
      // Le responsable est nommé, jamais identifié, comme au rattachement.
      assert.equal(suppression.avant.responsableHierarchique, responsable.name);
      assert.ok(!JSON.stringify(suppression).includes(responsable.id));
    });

    test('chaque réglage est journalisé sans secret, et un enregistrement sans changement n’écrit rien', async () => {
      const parametres = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      const company = await prisma.companySettings.findUnique({ where: { id: 'singleton' } });
      const remuneration = (await request(app).get('/api/parametres/remuneration').set(superAuth)).body;
      const partage = await prisma.planningPublicShare.findUnique({ where: { id: 'singleton' } });
      const nouveauxJours = parametres.joursSansSaisie === 21 ? 22 : 21;
      try {
        assert.equal((await request(app).put('/api/parametres').set(adminAuth).send({ joursSansSaisie: nouveauxJours })).status, 200);
        const reglage = await derniere('PARAMETRES');
        assert.deepEqual([reglage.avant, reglage.apres, reglage.auteurId], [{ joursSansSaisie: parametres.joursSansSaisie }, { joursSansSaisie: nouveauxJours }, admin.id]);
        assert.equal((await request(app).put('/api/parametres').set(adminAuth).send({ joursSansSaisie: nouveauxJours })).status, 200);
        assert.equal((await derniere('PARAMETRES')).id, reglage.id, 'aucune entrée sans changement');

        assert.equal((await request(app).put('/api/modules').set(superAuth).send({ planningActif: !parametres.planningActif })).status, 200);
        const module = await derniere('MODULES');
        assert.deepEqual([module.avant, module.apres], [{ planningActif: parametres.planningActif }, { planningActif: !parametres.planningActif }]);

        const prime = Number(remuneration.primeSuiviAdministratif) + 7;
        const majRemuneration = await request(app).put('/api/parametres/remuneration').set(superAuth).send({ ...remuneration, primeSuiviAdministratif: prime });
        assert.equal(majRemuneration.status, 200, JSON.stringify(majRemuneration.body));
        assert.deepEqual((await derniere('REMUNERATION')).apres, { primeSuiviAdministratif: prime });

        const telephone = `01 02 03 ${String(suffixe).slice(-4, -2)} ${String(suffixe).slice(-2)}`;
        assert.equal((await request(app).put('/api/company').set(superAuth).send({ telephone })).status, 200);
        const societe = await derniere('SOCIETE');
        assert.deepEqual([societe.avant, societe.apres], [{ telephone: company?.telephone ?? null }, { telephone }]);

        const commercial = await prisma.user.create({ data: { email: email('commercial'), name: 'TEST Journal commercial', role: 'COMMERCIAL' } });
        assert.equal((await request(app).put(`/api/commerciaux/${commercial.id}/prime-mensuelle`).set(adminAuth).send({ periode: '2026-09', suiviAdministratif: true })).status, 200);
        const primeMensuelle = await derniere('PRIME_COMMERCIAL');
        assert.deepEqual([primeMensuelle.cibleId, primeMensuelle.detail, primeMensuelle.avant, primeMensuelle.apres], [commercial.id, 'Période 09-2026', { suiviAdministratif: false }, { suiviAdministratif: true }]);

        const cle = await request(app).post('/api/admin/api-keys').set(superAuth).send({ nom: `TEST journal ${suffixe}`, scopes: ['clients:read'] });
        assert.equal(cle.status, 201, JSON.stringify(cle.body));
        assert.equal((await request(app).post(`/api/admin/api-keys/${cle.body.key.id}/revoke`).set(superAuth)).status, 200);
        const [creationCle, revocation] = await entreesDe(cle.body.key.id);
        assert.deepEqual([creationCle.action, revocation.action], ['CREATION', 'REVOCATION']);
        const empreinte = (await prisma.apiAccessKey.findUnique({ where: { id: cle.body.key.id } })).secretHash;
        for (const texte of [JSON.stringify(creationCle), JSON.stringify(revocation)]) {
          assert.ok(!texte.includes(cle.body.apiKey) && !texte.includes(empreinte), 'ni la clé ni son empreinte au journal');
        }
        assert.deepEqual(revocation.apres.actif, false);

        const publication = await request(app).post('/api/planning/share').set(superAuth);
        assert.equal(publication.status, 200, JSON.stringify(publication.body));
        const lien = await derniere('PARTAGE_PLANNING');
        assert.ok(['PUBLICATION', 'NOUVEAU_LIEN'].includes(lien.action));
        assert.ok(!JSON.stringify(lien).includes(publication.body.token), 'le jeton du lien n’est pas journalisé');
        assert.equal((await request(app).patch('/api/planning/share').set(superAuth).send({ active: false })).status, 200);
        const coupure = await derniere('PARTAGE_PLANNING');
        assert.deepEqual([coupure.action, coupure.avant, coupure.apres], ['DESACTIVATION', { actif: true }, { actif: false }]);
      } finally {
        await request(app).put('/api/parametres').set(superAuth).send({ joursSansSaisie: parametres.joursSansSaisie });
        await request(app).put('/api/modules').set(superAuth).send({ planningActif: parametres.planningActif });
        await request(app).put('/api/parametres/remuneration').set(superAuth).send(remuneration);
        await request(app).put('/api/company').set(superAuth).send({ telephone: company?.telephone ?? '' });
        if (partage) await prisma.planningPublicShare.update({ where: { id: 'singleton' }, data: { token: partage.token, active: partage.active } });
        else await prisma.planningPublicShare.deleteMany({});
        await prisma.primeMensuelleCommercial.deleteMany({ where: { commercial: { email: email('commercial') } } });
      }
    });

    test('un simple administrateur ne voit ni les entrées d’un compte super administrateur, ni les clés d’intégration', async () => {
      const promu = await prisma.user.create({ data: { email: email('promu'), name: 'TEST Journal promu', role: 'CONDUCTEUR_TRAVAUX' } });
      assert.equal((await request(app).patch(`/api/users/${promu.id}/role`).set(superAuth).send({ role: 'SUPERADMIN' })).status, 200);
      const cle = await request(app).post('/api/admin/api-keys').set(superAuth).send({ nom: `TEST journal visibilité ${suffixe}`, scopes: ['clients:read'] });
      assert.equal(cle.status, 201);
      assert.deepEqual((await entreesDe(promu.id)).map((e) => e.action), ['TYPE_COMPTE'], 'le super administrateur voit l’entrée');
      assert.equal((await entreesDe(cle.body.key.id)).length, 1);
      assert.deepEqual(await entreesDe(promu.id, adminAuth), [], 'l’administrateur ne voit pas l’entrée du compte promu');
      assert.deepEqual(await entreesDe(cle.body.key.id, adminAuth), []);
      const parType = await journal(adminAuth, { type: 'CLE_INTEGRATION' });
      assert.deepEqual([parType.status, parType.body.total], [200, 0]);
      // Le compte promu ne peut plus être rétrogradé par l'administrateur, et l'entrée de sa
      // rétrogradation par le super administrateur lui reste fermée.
      assert.equal((await request(app).patch(`/api/users/${promu.id}/role`).set(superAuth).send({ role: 'CONDUCTEUR_TRAVAUX' })).status, 200);
      assert.deepEqual(await entreesDe(promu.id, adminAuth), []);
      const auteurs = (await journal(adminAuth)).body.auteurs.map((a) => a.nom);
      assert.ok(!auteurs.includes('Iris (démarrage, SUPERADMIN_EMAILS)'), 'les auteurs des seules entrées fermées ne sont pas proposés');
      assert.equal((await journal(conducteurAuth)).status, 403);
      assert.equal((await request(app).get('/api/journal-administration/export.csv').set(conducteurAuth)).status, 403);
      assert.equal((await request(app).put('/api/journal-administration/conservation').set(adminAuth).send({ jours: 30 })).status, 403);
      await request(app).post(`/api/admin/api-keys/${cle.body.key.id}/revoke`).set(superAuth);
    });

    // Cas limites relevés par l'audit de #133 : aucune entrée qui touche un super administrateur ne
    // doit atteindre un simple administrateur, ni par la liste, ni par l'export.
    test('cas limites de visibilité : responsable, collaborateurs, suppression, prime et démarrage', async () => {
      const compte = async (qui, role, data = {}) => prisma.user.create({ data: { email: email(qui), name: `TEST Journal ${qui} ${suffixe}`, role, ...data } });
      const s1 = await compte('s1', 'SUPERADMIN');
      const s2 = await compte('s2', 'SUPERADMIN', { estCommercial: true });
      const conducteur = await compte('rattache', 'CONDUCTEUR_TRAVAUX');
      const chef = await compte('chef', 'RESPONSABLE');
      const collaborateur = await compte('collab', 'CONDUCTEUR_TRAVAUX');
      // Rattachement à un super administrateur, puis suppression du compte rattaché par l'administrateur.
      assert.equal((await request(app).patch(`/api/users/${conducteur.id}/responsable-hierarchique`).set(superAuth).send({ responsableHierarchiqueId: s1.id })).status, 200);
      assert.equal((await request(app).delete(`/api/users/${conducteur.id}`).set(adminAuth)).status, 200);
      assert.deepEqual((await entreesDe(conducteur.id)).map((e) => e.action), ['RATTACHEMENT', 'SUPPRESSION']);
      assert.equal((await entreesDe(conducteur.id)).at(-1).avant.responsableHierarchique, s1.name);
      assert.deepEqual(await entreesDe(conducteur.id, adminAuth), [], 'ni le rattachement ni la suppression ne nomment le super administrateur à l’administrateur');
      // Suppression d'un responsable : chaque collaborateur détaché a son entrée, fermée si c'est un super administrateur.
      for (const id of [collaborateur.id, s2.id]) {
        assert.equal((await request(app).patch(`/api/users/${id}/responsable-hierarchique`).set(superAuth).send({ responsableHierarchiqueId: chef.id })).status, 200);
      }
      assert.equal((await request(app).delete(`/api/users/${chef.id}`).set(adminAuth)).status, 200);
      const detache = (await entreesDe(collaborateur.id, adminAuth)).at(-1);
      assert.deepEqual([detache.action, detache.avant, detache.apres, detache.detail], ['RATTACHEMENT', { responsableHierarchique: chef.name }, { responsableHierarchique: null }, 'Responsable hiérarchique supprimé.']);
      assert.deepEqual((await entreesDe(s2.id)).map((e) => e.action), ['RATTACHEMENT', 'RATTACHEMENT']);
      assert.deepEqual(await entreesDe(s2.id, adminAuth), []);
      // Prime d'un super administrateur aussi commercial : fermée.
      assert.equal((await request(app).put(`/api/commerciaux/${s2.id}/prime-mensuelle`).set(adminAuth).send({ periode: '2026-08', suiviAdministratif: true })).status, 200);
      assert.equal((await entreesDe(s2.id)).at(-1).type, 'PRIME_COMMERCIAL');
      assert.deepEqual(await entreesDe(s2.id, adminAuth), []);
      // Suppression d'un super administrateur par un super administrateur : fermée.
      assert.equal((await request(app).delete(`/api/users/${s1.id}`).set(superAuth)).status, 200);
      assert.equal((await entreesDe(s1.id)).at(-1).action, 'SUPPRESSION');
      assert.deepEqual(await entreesDe(s1.id, adminAuth), []);
      // Promotion au démarrage (SUPERADMIN_EMAILS) : journalisée sans auteur, fermée.
      const promu = await compte('demarrage', 'CONDUCTEUR_TRAVAUX');
      const emails = process.env.SUPERADMIN_EMAILS;
      process.env.SUPERADMIN_EMAILS = `${emails},${promu.email}`;
      try {
        await ensureSuperAdmins();
      } finally {
        process.env.SUPERADMIN_EMAILS = emails;
      }
      const promotion = (await entreesDe(promu.id)).at(-1);
      assert.deepEqual([promotion.action, promotion.auteurId, promotion.auteurNom, promotion.avant, promotion.apres], ['TYPE_COMPTE', null, 'Iris (démarrage, SUPERADMIN_EMAILS)', { role: 'CONDUCTEUR_TRAVAUX' }, { role: 'SUPERADMIN' }]);
      assert.deepEqual(await entreesDe(promu.id, adminAuth), []);
      // L'export complet de l'administrateur ne contient aucune de ces entrées, ni aucune clé.
      const csv = await request(app).get('/api/journal-administration/export.csv').set(adminAuth).buffer(true).parse((res, fin) => {
        let texte = ''; res.setEncoding('utf8'); res.on('data', (morceau) => { texte += morceau; }); res.on('end', () => fin(null, texte));
      });
      assert.equal(csv.status, 200);
      for (const cache of [s1.name, s2.name, conducteur.email, promu.email, s1.id, '"CLE_INTEGRATION"']) assert.ok(!csv.body.includes(cache), cache);
      assert.ok(csv.body.includes(collaborateur.email), 'l’entrée du collaborateur non super administrateur reste exportée');
      await prisma.primeMensuelleCommercial.deleteMany({ where: { commercialId: s2.id } });
    });

    test('enregistrements simultanés : un seul changement journalisé, et une clé révoquée ne l’est qu’une fois', async () => {
      const commercial = await prisma.user.create({ data: { email: email('simultane'), name: 'TEST Journal simultané', role: 'COMMERCIAL' } });
      const reponses = await Promise.all(Array.from({ length: 5 }, () => request(app).put(`/api/commerciaux/${commercial.id}/prime-mensuelle`).set(adminAuth).send({ periode: '2026-07', suiviAdministratif: true })));
      assert.deepEqual(reponses.map((r) => r.status), [200, 200, 200, 200, 200]);
      assert.equal((await entreesDe(commercial.id)).length, 1, 'un seul passage de non à oui');
      const cle = await request(app).post('/api/admin/api-keys').set(superAuth).send({ nom: `TEST journal révocation ${suffixe}`, scopes: ['clients:read'] });
      const premiere = await request(app).post(`/api/admin/api-keys/${cle.body.key.id}/revoke`).set(superAuth);
      const seconde = await request(app).post(`/api/admin/api-keys/${cle.body.key.id}/revoke`).set(superAuth);
      assert.deepEqual([premiere.status, seconde.status], [200, 200]);
      assert.equal(seconde.body.revoqueLe, premiere.body.revoqueLe, 'la date de révocation n’est pas réécrite');
      assert.deepEqual((await entreesDe(cle.body.key.id)).map((e) => e.action), ['CREATION', 'REVOCATION']);
      assert.equal((await request(app).post('/api/admin/api-keys/inconnue/revoke').set(superAuth)).status, 404);
      await prisma.primeMensuelleCommercial.deleteMany({ where: { commercialId: commercial.id } });
    });

    test('filtres par date, type et auteur, et export CSV', async () => {
      const nom = `=HYPERLINK("http://exemple.test") ${suffixe}`;
      const creation = await request(app).post('/api/users').set(adminAuth).send({ email: email('csv'), name: nom, role: 'CONDUCTEUR_TRAVAUX' });
      assert.equal(creation.status, 201, JSON.stringify(creation.body));
      const fuseau = (await prisma.companySettings.findUnique({ where: { id: 'singleton' } }))?.fuseauHoraire || 'Europe/Paris';
      const aujourdhui = jourCivilEntreprise(new Date(), fuseau).split('-').reverse().join('-');
      const demain = jourCivilEntreprise(new Date(Date.now() + 86400000), fuseau).split('-').reverse().join('-');
      const parAuteur = await journal(adminAuth, { auteur: admin.id, type: 'COMPTE', du: aujourdhui, au: aujourdhui });
      assert.equal(parAuteur.status, 200, JSON.stringify(parAuteur.body));
      assert.ok(parAuteur.body.entrees.some((e) => e.cibleId === creation.body.id));
      assert.ok(parAuteur.body.entrees.every((e) => e.auteurId === admin.id && e.type === 'COMPTE'));
      assert.equal((await journal(adminAuth, { du: demain })).body.total, 0, 'aucune entrée demain');
      for (const query of [{ du: '31-02-2026' }, { au: '2026-13-01' }, { du: demain, au: aujourdhui }, { type: 'INCONNU' }]) {
        assert.equal((await journal(adminAuth, query)).status, 400, JSON.stringify(query));
      }
      const csv = await request(app).get('/api/journal-administration/export.csv').query({ auteur: admin.id, type: 'COMPTE' }).set(adminAuth).buffer(true).parse((res, fin) => {
        let texte = ''; res.setEncoding('utf8'); res.on('data', (morceau) => { texte += morceau; }); res.on('end', () => fin(null, texte));
      });
      assert.equal(csv.status, 200);
      assert.match(csv.headers['content-type'], /^text\/csv; charset=utf-8/);
      assert.match(csv.headers['content-disposition'], /^attachment; filename="journal-parametres-droits-\d{2}-\d{2}-\d{4}\.csv"$/);
      assert.ok(csv.body.startsWith('﻿Date;Heure;Auteur;Domaine;Type;Action;Cible;Avant;Après;Détail\n'));
      const ligne = csv.body.split('\n').find((l) => l.includes(email('csv')));
      assert.ok(ligne, csv.body.slice(0, 500));
      assert.ok(ligne.startsWith(`"${aujourdhui}";"`), ligne);
      // Protection contre l'injection de formule dans un tableur : la cellule commence par une apostrophe.
      assert.ok(ligne.includes(`"'=HYPERLINK(""http://exemple.test"") ${suffixe} (${email('csv')})"`), ligne);
      // Valeurs « champ : valeur », séparées par « ; » (l'ordre des champs suit le stockage JSONB).
      for (const valeur of ['role : CONDUCTEUR_TRAVAUX', 'estCommercial : false', 'permissions : []', 'actif : true']) assert.ok(ligne.includes(valeur), `${valeur} : ${ligne}`);
    });

    test('le journal est en ajout seul, et purgé au-delà de la durée de conservation', async () => {
      const entree = await prisma.journalAdministration.findFirst({ orderBy: { createdAt: 'desc' } });
      await assert.rejects(prisma.$executeRaw`UPDATE "JournalAdministration" SET "auteurNom" = 'falsifié' WHERE "id" = ${entree.id}`, /immuable/);
      await assert.rejects(prisma.$executeRaw`DELETE FROM "JournalAdministration" WHERE "id" = ${entree.id}`, /durée de conservation/);
      await assert.rejects(prisma.$executeRawUnsafe('TRUNCATE "JournalAdministration"'), /vidage interdit/);
      // Une entrée ne peut pas être antidatée pour être supprimée aussitôt.
      const antidatee = await prisma.journalAdministration.create({ data: { domaine: 'REGLAGES', type: 'PARAMETRES', action: 'MODIFICATION', auteurNom: 'TEST antidatée', reserveSuperAdmin: true, createdAt: new Date('2020-01-01T00:00:00Z') } });
      assert.ok(Math.abs(Date.now() - antidatee.createdAt.getTime()) < 60000, 'horodatage de l’écriture');
      // Session PostgreSQL dans un autre fuseau : l'horodatage reste l'instant UTC de l'écriture, et
      // l'entrée, récente, ne se supprime pas.
      const autreFuseau = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
        return tx.journalAdministration.create({ data: { domaine: 'REGLAGES', type: 'PARAMETRES', action: 'MODIFICATION', auteurNom: 'TEST fuseau de session', reserveSuperAdmin: true } });
      });
      assert.ok(Math.abs(Date.now() - autreFuseau.createdAt.getTime()) < 60000, `heure UTC de l’écriture : ${autreFuseau.createdAt.toISOString()}`);
      for (const fuseau of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        await assert.rejects(prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${fuseau}'`);
          await tx.$executeRaw`DELETE FROM "JournalAdministration" WHERE "id" = ${autreFuseau.id}`;
        }), /durée de conservation/, fuseau);
      }

      for (const jours of [0, 91, 'abc', 1.5]) {
        assert.equal((await request(app).put('/api/journal-administration/conservation').set(superAuth).send({ jours })).status, 400, String(jours));
      }
      // Entrées anciennes insérées pour le test, horodatage forcé désactivé le temps de l'insertion.
      const vieille = (jours) => ({ domaine: 'REGLAGES', type: 'PARAMETRES', action: 'MODIFICATION', auteurNom: `TEST âgée de ${jours} jours`, reserveSuperAdmin: true, createdAt: new Date(Date.now() - jours * 86400000) });
      await prisma.$executeRawUnsafe('ALTER TABLE "JournalAdministration" DISABLE TRIGGER "journal_administration_horodatage"');
      let a100; let a40;
      try {
        a100 = await prisma.journalAdministration.create({ data: vieille(100) });
        a40 = await prisma.journalAdministration.create({ data: vieille(40) });
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "JournalAdministration" ENABLE TRIGGER "journal_administration_horodatage"');
      }
      try {
        assert.equal((await journal(superAuth)).status, 200);
        assert.equal(await prisma.journalAdministration.count({ where: { id: a100.id } }), 0, 'au-delà de 90 jours, purgée à la consultation');
        assert.equal(await prisma.journalAdministration.count({ where: { id: a40.id } }), 1, 'en deçà, conservée');
        const reglage = await request(app).put('/api/journal-administration/conservation').set(superAuth).send({ jours: 30 });
        assert.deepEqual([reglage.status, reglage.body], [200, { conservationJours: 30 }]);
        assert.equal(await prisma.journalAdministration.count({ where: { id: a40.id } }), 0, 'la réduction purge aussitôt');
        const conservation = await derniere('CONSERVATION_JOURNAL', adminAuth);
        assert.deepEqual([conservation.avant, conservation.apres], [{ journalConservationJours: 90 }, { journalConservationJours: 30 }]);
        assert.equal((await journal(adminAuth)).body.conservationJours, 30);
      } finally {
        await request(app).put('/api/journal-administration/conservation').set(superAuth).send({ jours: 90 });
      }
    });

    test('un changement dont l’entrée de journal échoue est annulé', async () => {
      const avant = await prisma.parametres.findUnique({ where: { id: 'singleton' } });
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_refuser_journal() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'journal indisponible'; END; $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe('CREATE TRIGGER test_refuser_journal BEFORE INSERT ON "JournalAdministration" FOR EACH ROW EXECUTE FUNCTION test_refuser_journal()');
      try {
        const res = await request(app).put('/api/parametres').set(adminAuth).send({ joursSansSaisie: avant.joursSansSaisie === 30 ? 31 : 30 });
        assert.equal(res.status, 500);
        assert.equal((await prisma.parametres.findUnique({ where: { id: 'singleton' } })).joursSansSaisie, avant.joursSansSaisie, 'réglage inchangé');
        const compte = await request(app).post('/api/users').set(adminAuth).send({ email: email('annule'), name: 'TEST Journal annulé', role: 'CONDUCTEUR_TRAVAUX' });
        assert.equal(compte.status, 500);
        assert.equal(await prisma.user.count({ where: { email: email('annule') } }), 0, 'compte non créé');
        const cle = await prisma.apiAccessKey.create({ data: { nom: `TEST journal annulé ${suffixe}`, prefixe: 'iris_test_ann', secretHash: `test-${suffixe}`, scopes: ['clients:read'], creeParId: admin.id } });
        assert.equal((await request(app).post(`/api/admin/api-keys/${cle.id}/revoke`).set(superAuth)).status, 500, 'une erreur, et non « clé introuvable »');
        assert.equal((await prisma.apiAccessKey.findUnique({ where: { id: cle.id } })).actif, true, 'clé toujours active');
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_refuser_journal ON "JournalAdministration"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_refuser_journal()');
      }
    });
  });
}
