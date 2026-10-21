import express from 'express';
import { Prisma } from '@prisma/client';
import type { Express } from 'express';
import { prisma, transactionVerifiee } from '../../db';
import { ROLE_RESPONSABLE, isAdminRole } from '../../droits/roles';
import { perimetreChantiers } from '../../droits/perimetres';
import { voitMontantsChantier, sansMontantsSaisie, saisieSelonDroits } from '../../droits/visibilite';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { paramId } from '../../http/requete';
import { routeMixte } from '../../http/routes-mixtes';
import { dateIsoStricte } from '../../commun/dates';
import { decimalToNumber } from '../../commun/montants';
import { nombreDecimalNonNegatif, motifCorrectionValide, motifRestaurationValide } from '../../commun/validation';
import { valeurJournal } from '../../commun/journal-administration';
import { CHANTIER_LITE_SELECT, journaliserChangementChantier } from './metier';
import { requireTravauxWrite, requireTravauxArchive } from './droits';

// Un chantier clôturé (TERMINE) devient en lecture seule pour les conducteurs : ils ne
// peuvent plus y ajouter d'heures ou de dépenses ; un admin garde un accès total (c'est
// lui seul qui peut d'ailleurs réouvrir un chantier clôturé, cf. PATCH .../statut).
// Envoie la réponse d'erreur et retourne null si l'écriture est refusée.
// Périmètre explicite : `responsableId` du chantier, et pour un compte Responsable sa
// branche hiérarchique persistante (User.responsableHierarchiqueId) ; un intitulé de rôle
// seul ne suffit jamais à élargir l'accès.
async function assertChantierWritable(req: express.Request, res: express.Response, chantierId: string) {
  const user = (req as AuthRequest).user;
  const isAdmin = isAdminRole(user?.role);
  const chantier = await prisma.chantier.findUnique({ where: { id: chantierId } });
  if (!chantier) {
    res.status(404).json({ error: 'Chantier introuvable' });
    return null;
  }
  const estConducteurDeLAffaire = user?.role === 'CONDUCTEUR_TRAVAUX' && chantier.responsableId === user.id;
  const estResponsableDeLEquipe = user?.role === ROLE_RESPONSABLE
    && !!chantier.responsableId
    && (chantier.responsableId === user.id || user.equipeIds.includes(chantier.responsableId));
  if (!isAdmin && !estConducteurDeLAffaire && !estResponsableDeLEquipe) {
    // Même réponse qu'un chantier absent afin de ne pas révéler une affaire hors périmètre.
    res.status(404).json({ error: 'Chantier introuvable' });
    return null;
  }
  // Une affaire annulée n'accepte plus rien de personne : le verrou d'annulation garantit
  // qu'elle était vierge, une écriture postérieure la ferait ressusciter en silence.
  if (chantier.statut === 'ANNULE') {
    res.status(409).json({ error: 'Cette affaire est annulée : plus aucune saisie n’y est possible.' });
    return null;
  }
  if (!isAdmin && chantier.statut !== 'EN_COURS') {
    res.status(403).json({ error: 'Ce chantier est clôturé : impossible d\'y ajouter une dépense ou des heures.' });
    return null;
  }
  return chantier;
}

async function journaliserSaisieTravaux(
  tx: any,
  req: AuthRequest,
  cible: 'ACHAT' | 'HEURE',
  action: 'CREATION' | 'CORRECTION' | 'ARCHIVAGE' | 'RESTAURATION',
  cibleId: string,
  chantierId: string,
  avant: unknown,
  apres: unknown,
  motif?: string,
) {
  const user = req.user!;
  await tx.journalSaisieChantier.create({ data: {
    chantierId, cible, cibleId, action, auteurId: user.id, auteurNom: user.name,
    avant: avant ? valeurJournal(avant) : undefined,
    apres: apres ? valeurJournal(apres) : undefined,
    motif: motif || null,
  } });
}

// Achats
// Journal des achats, restreint au périmètre du demandeur (cf. perimetreChantiers) et
// dépouillé des montants du chantier (cf. CHANTIER_LITE_SELECT).
//
// Cette route renvoyait auparavant TOUS les achats de TOUS les chantiers, chacun avec son
// chantier complet : un conducteur ou un commercial y lisait les budgets vendus d'affaires
// qui ne le concernaient pas, alors que serializeChantier les lui masque partout ailleurs.
// Le contrôle d'accès n'a de valeur que s'il tient sur toutes les portes à la fois.
const listerAchats: express.RequestHandler = async (req, res) => {
  try {
    const achats = decimalToNumber(await prisma.achatReel.findMany({
      where: { archivedAt: null, chantier: perimetreChantiers(req) },
      include: {
        chantier: { select: CHANTIER_LITE_SELECT },
        categorie: true,
        fournisseur: true,
      },
      orderBy: { date: 'desc' },
    }));
    // Un technicien ne voit aucun coût d'achat (cf. voitMontantsChantier).
    res.json(voitMontantsChantier(req) ? achats : achats.map(sansMontantsSaisie));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching achats' });
  }
};

// Pointages (Heures)
// Journal des heures : même correction et même raison que le journal des achats.
const listerHeures: express.RequestHandler = async (req, res) => {
  try {
    const heures = decimalToNumber(await prisma.pointageHeure.findMany({
      where: { archivedAt: null, chantier: perimetreChantiers(req) },
      include: {
        chantier: { select: CHANTIER_LITE_SELECT },
        intervenant: true,
      },
      orderBy: { date: 'desc' },
    }));
    // Taux appliqué et taux de l'intervenant réservés à l'administration (cf. saisieSelonDroits).
    res.json(heures.map(saisieSelonDroits(req)));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching heures' });
  }
};

export function enregistrerRoutesSaisiesTravaux(app: Express): void {
  app.post('/api/achats', requireAuth, requireTravauxWrite, async (req, res) => {
    try {
      const date = dateIsoStricte(req.body.date);
      if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
      const montantHT = nombreDecimalNonNegatif(req.body.montantHT, 10, true);
      if (montantHT === null) return res.status(400).json({ error: 'Le montant HT doit être un nombre positif ou nul.' });
      if (!(await assertChantierWritable(req, res, req.body.chantierId))) return;
      const cree = await transactionVerifiee(async (tx) => {
        const achat = await tx.achatReel.create({
          data: {
            date, fournisseurId: req.body.fournisseurId, numeroFacture: req.body.numeroFacture || null,
            description: req.body.description, montantHT, chantierId: req.body.chantierId,
            categorieId: req.body.categorieId,
            createdById: (req as AuthRequest).user!.id,
            updatedById: (req as AuthRequest).user!.id,
          }
        });
        await journaliserSaisieTravaux(tx, req as AuthRequest, 'ACHAT', 'CREATION', achat.id, achat.chantierId, null, achat);
        return achat;
      });
      res.json(cree);
    } catch (error) {
      res.status(500).json({ error: 'Error creating achat' });
    }
  });

  // Correction d'un achat déjà saisi (erreur de montant, de fournisseur, de catégorie...) —
  // mêmes droits que la saisie (tout compte non-commercial, sur un chantier EN_COURS ou
  // n'importe quel chantier pour un admin, cf. assertChantierWritable). Ne permet pas de
  // changer le chantier de l'achat, comme pour PATCH /api/heures/:id.
  app.patch('/api/achats/:id', requireAuth, requireTravauxWrite, async (req, res) => {
    try {
      const achatId = paramId(req);
      const achat = await prisma.achatReel.findUnique({ where: { id: achatId } });
      if (!achat) return res.status(404).json({ error: 'Achat introuvable.' });
      if (!(await assertChantierWritable(req, res, achat.chantierId))) return;
      if (achat.archivedAt) return res.status(409).json({ error: 'Un achat archivé ne peut plus être corrigé.' });
      const motifCorrection = motifCorrectionValide(req.body?.motifCorrection);
      if (!motifCorrection) return res.status(400).json({ error: 'Le motif de correction doit contenir entre 3 et 500 caractères.' });

      const data: Record<string, unknown> = {};
      if ('date' in req.body) {
        const date = dateIsoStricte(req.body.date);
        if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
        data.date = date;
      }
      if ('numeroFacture' in req.body) data.numeroFacture = req.body.numeroFacture || null;
      if ('description' in req.body) data.description = req.body.description;
      if ('montantHT' in req.body) {
        const montantHT = nombreDecimalNonNegatif(req.body.montantHT, 10, true);
        if (montantHT === null) return res.status(400).json({ error: 'Le montant HT doit être un nombre positif ou nul.' });
        data.montantHT = montantHT;
      }
      if ('fournisseurId' in req.body) {
        const fournisseur = await prisma.fournisseur.findUnique({ where: { id: String(req.body.fournisseurId) } });
        if (!fournisseur) return res.status(404).json({ error: 'Fournisseur introuvable.' });
        data.fournisseurId = fournisseur.id;
      }
      if ('categorieId' in req.body) {
        const categorie = await prisma.categorie.findUnique({ where: { id: String(req.body.categorieId) } });
        if (!categorie) return res.status(404).json({ error: 'Catégorie introuvable.' });
        data.categorieId = categorie.id;
      }

      data.updatedById = (req as AuthRequest).user!.id;
      const resultat = await transactionVerifiee(async (tx) => {
        // Ce filtre n’est pas redondant avec le garde ci-dessus : un archivage concurrent peut
        // passer entre le findUnique et cet UPDATE. Sans lui, une correction toucherait un archivé.
        const { count } = await tx.achatReel.updateMany({ where: { id: achatId, archivedAt: null }, data });
        if (count === 0) return null;
        const misAJour = await tx.achatReel.findUniqueOrThrow({ where: { id: achatId } });
        await journaliserSaisieTravaux(tx, req as AuthRequest, 'ACHAT', 'CORRECTION', achatId, achat.chantierId, achat, misAJour, motifCorrection);
        return misAJour;
      });
      if (!resultat) return res.status(409).json({ error: 'Un achat archivé ne peut plus être corrigé.' });
      res.json(resultat);
    } catch (error) {
      res.status(500).json({ error: 'Error updating achat' });
    }
  });

  // Suppression d'un achat saisi par erreur (doublon, mauvais chantier...) — mêmes droits
  // que la correction ci-dessus (PATCH), cf. assertChantierWritable.
  app.delete('/api/achats/:id', requireAuth, requireTravauxArchive, async (req, res) => {
    try {
      const achatId = paramId(req);
      const achat = await prisma.achatReel.findUnique({ where: { id: achatId } });
      if (!achat) return res.status(404).json({ error: 'Achat introuvable.' });
      if (!(await assertChantierWritable(req, res, achat.chantierId))) return;
      if (achat.archivedAt) return res.status(409).json({ error: 'Cet achat est déjà archivé.' });

      const motifArchivage = typeof req.body?.motifArchivage === 'string' ? req.body.motifArchivage.trim() : '';
      // PostgreSQL char_length compte les caractères alors que .length compte les unités UTF-16.
      const longueurMotifArchivage = [...motifArchivage].length;
      if (longueurMotifArchivage < 3 || longueurMotifArchivage > 500) return res.status(400).json({ error: 'Le motif d’archivage doit contenir entre 3 et 500 caractères.' });
      const archiveCree = await transactionVerifiee(async (tx) => {
        const { count } = await tx.achatReel.updateMany({ where: { id: achatId, archivedAt: null }, data: { archivedAt: new Date(), archivedById: (req as AuthRequest).user!.id, motifArchivage } });
        if (count === 0) return false;
        const archive = await tx.achatReel.findUniqueOrThrow({ where: { id: achatId } });
        await journaliserSaisieTravaux(tx, req as AuthRequest, 'ACHAT', 'ARCHIVAGE', achatId, achat.chantierId, achat, archive, motifArchivage);
        return true;
      });
      if (!archiveCree) return res.status(409).json({ error: 'Cet achat est déjà archivé.' });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Error deleting achat' });
    }
  });

  app.post('/api/achats/:id/restaurer', requireAuth, requireTravauxArchive, async (req, res) => {
    try {
      const achatId = paramId(req);
      const achat = await prisma.achatReel.findUnique({ where: { id: achatId } });
      if (!achat) return res.status(404).json({ error: 'Achat introuvable.' });
      if (!(await assertChantierWritable(req, res, achat.chantierId))) return;
      if (!achat.archivedAt) return res.status(409).json({ error: 'Cet achat est déjà actif.' });
      const motifRestauration = motifRestaurationValide(req.body?.motifRestauration);
      if (!motifRestauration) return res.status(400).json({ error: 'Le motif de restauration doit contenir entre 3 et 500 caractères.' });
      const restaure = await transactionVerifiee(async (tx) => {
        const { count } = await tx.achatReel.updateMany({
          where: { id: achatId, archivedAt: { not: null } },
          data: { archivedAt: null, archivedById: null, motifArchivage: null, updatedById: (req as AuthRequest).user!.id },
        });
        if (count === 0) return null;
        const actif = await tx.achatReel.findUniqueOrThrow({ where: { id: achatId } });
        await journaliserSaisieTravaux(tx, req as AuthRequest, 'ACHAT', 'RESTAURATION', achatId, achat.chantierId, achat, actif, motifRestauration);
        return actif;
      });
      if (!restaure) return res.status(409).json({ error: 'Cet achat est déjà actif.' });
      res.json(restaure);
    } catch (error) {
      res.status(500).json({ error: 'Error restoring achat' });
    }
  });

  // Ouvertes à tous les rôles : c'est le périmètre renvoyé qui distingue un administrateur
  // d'un conducteur, pas le droit d'appeler la route.
  routeMixte('get', '/achats', 'chantiers:read', listerAchats, []);
  routeMixte('get', '/heures', 'chantiers:read', listerHeures, []);

  app.post('/api/heures', requireAuth, requireTravauxWrite, async (req, res) => {
    try {
      const date = dateIsoStricte(req.body.date);
      if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
      const nbrHeures = nombreDecimalNonNegatif(req.body.nbrHeures, 8);
      if (nbrHeures === null) return res.status(400).json({ error: 'Le nombre d’heures doit être strictement positif.' });
      const intervenant = await prisma.intervenant.findUnique({ where: { id: req.body.intervenantId } });
      if (!intervenant) return res.status(404).json({ error: 'Intervenant not found' });
      if (!(await assertChantierWritable(req, res, req.body.chantierId))) return;

      const cree = await transactionVerifiee(async (tx) => {
        const pointage = await tx.pointageHeure.create({
          data: {
            date, intervenantId: req.body.intervenantId, chantierId: req.body.chantierId,
            nbrHeures, tauxHoraireApplique: intervenant.tauxHoraireCharge,
            commentaire: req.body.commentaire || null,
            createdById: (req as AuthRequest).user!.id,
            updatedById: (req as AuthRequest).user!.id,
          }
        });
        await journaliserSaisieTravaux(tx, req as AuthRequest, 'HEURE', 'CREATION', pointage.id, pointage.chantierId, null, pointage);
        return pointage;
      });
      // Réponse masquée comme en lecture : ni taux appliqué hors administration.
      res.json(saisieSelonDroits(req)(cree));
    } catch (error) {
      res.status(500).json({ error: 'Error creating pointage' });
    }
  });

  // Correction d'un pointage d'heures déjà saisi (erreur de date, d'intervenant, de nombre
  // d'heures...) — mêmes droits que la saisie (tout compte non-commercial, sur un chantier
  // EN_COURS ou n'importe quel chantier pour un admin, cf. assertChantierWritable). Ne
  // permet pas de changer le chantier du pointage : ce n'est pas une réaffectation, juste
  // une correction de saisie sur le chantier d'origine.
  app.patch('/api/heures/:id', requireAuth, requireTravauxWrite, async (req, res) => {
    try {
      const pointageId = paramId(req);
      const pointage = await prisma.pointageHeure.findUnique({ where: { id: pointageId } });
      if (!pointage) return res.status(404).json({ error: 'Pointage introuvable.' });
      if (!(await assertChantierWritable(req, res, pointage.chantierId))) return;
      if (pointage.archivedAt) return res.status(409).json({ error: 'Un pointage archivé ne peut plus être corrigé.' });
      const motifCorrection = motifCorrectionValide(req.body?.motifCorrection);
      if (!motifCorrection) return res.status(400).json({ error: 'Le motif de correction doit contenir entre 3 et 500 caractères.' });

      const data: Record<string, unknown> = {};
      if ('date' in req.body) {
        const date = dateIsoStricte(req.body.date);
        if (!date) return res.status(400).json({ error: 'La date doit être valide au format JJ-MM-AAAA.' });
        data.date = date;
      }
      if ('nbrHeures' in req.body) {
        const nbrHeures = nombreDecimalNonNegatif(req.body.nbrHeures, 8);
        if (nbrHeures === null) return res.status(400).json({ error: 'Le nombre d’heures doit être strictement positif.' });
        data.nbrHeures = nbrHeures;
      }
      if ('commentaire' in req.body) data.commentaire = req.body.commentaire || null;
      // Changer l'intervenant réapplique son taux horaire chargé ACTUEL (même logique qu'à
      // la création) : le taux figé de l'ancien intervenant n'a pas de sens pour le nouveau.
      if ('intervenantId' in req.body && req.body.intervenantId !== pointage.intervenantId) {
        const intervenant = await prisma.intervenant.findUnique({ where: { id: String(req.body.intervenantId) } });
        if (!intervenant) return res.status(404).json({ error: 'Intervenant introuvable.' });
        data.intervenantId = intervenant.id;
        data.tauxHoraireApplique = intervenant.tauxHoraireCharge;
      }

      data.updatedById = (req as AuthRequest).user!.id;
      const resultat = await transactionVerifiee(async (tx) => {
        // Ce filtre n’est pas redondant avec le garde ci-dessus : un archivage concurrent peut
        // passer entre le findUnique et cet UPDATE. Sans lui, une correction toucherait un archivé.
        const { count } = await tx.pointageHeure.updateMany({ where: { id: pointageId, archivedAt: null }, data });
        if (count === 0) return null;
        const misAJour = await tx.pointageHeure.findUniqueOrThrow({ where: { id: pointageId } });
        await journaliserSaisieTravaux(tx, req as AuthRequest, 'HEURE', 'CORRECTION', pointageId, pointage.chantierId, pointage, misAJour, motifCorrection);
        return misAJour;
      });
      if (!resultat) return res.status(409).json({ error: 'Un pointage archivé ne peut plus être corrigé.' });
      res.json(saisieSelonDroits(req)(resultat));
    } catch (error) {
      res.status(500).json({ error: 'Error updating pointage' });
    }
  });

  // Suppression d'un pointage saisi par erreur (doublon, mauvais chantier...) — mêmes
  // droits que la correction ci-dessus (PATCH), cf. assertChantierWritable.
  app.delete('/api/heures/:id', requireAuth, requireTravauxArchive, async (req, res) => {
    try {
      const pointageId = paramId(req);
      const pointage = await prisma.pointageHeure.findUnique({ where: { id: pointageId } });
      if (!pointage) return res.status(404).json({ error: 'Pointage introuvable.' });
      if (!(await assertChantierWritable(req, res, pointage.chantierId))) return;
      if (pointage.archivedAt) return res.status(409).json({ error: 'Ce pointage est déjà archivé.' });

      const motifArchivage = typeof req.body?.motifArchivage === 'string' ? req.body.motifArchivage.trim() : '';
      // PostgreSQL char_length compte les caractères alors que .length compte les unités UTF-16.
      const longueurMotifArchivage = [...motifArchivage].length;
      if (longueurMotifArchivage < 3 || longueurMotifArchivage > 500) return res.status(400).json({ error: 'Le motif d’archivage doit contenir entre 3 et 500 caractères.' });
      const archiveCree = await transactionVerifiee(async (tx) => {
        const { count } = await tx.pointageHeure.updateMany({ where: { id: pointageId, archivedAt: null }, data: { archivedAt: new Date(), archivedById: (req as AuthRequest).user!.id, motifArchivage } });
        if (count === 0) return false;
        const archive = await tx.pointageHeure.findUniqueOrThrow({ where: { id: pointageId } });
        await journaliserSaisieTravaux(tx, req as AuthRequest, 'HEURE', 'ARCHIVAGE', pointageId, pointage.chantierId, pointage, archive, motifArchivage);
        return true;
      });
      if (!archiveCree) return res.status(409).json({ error: 'Ce pointage est déjà archivé.' });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Error deleting pointage' });
    }
  });

  app.post('/api/heures/:id/restaurer', requireAuth, requireTravauxArchive, async (req, res) => {
    try {
      const pointageId = paramId(req);
      const pointage = await prisma.pointageHeure.findUnique({ where: { id: pointageId } });
      if (!pointage) return res.status(404).json({ error: 'Pointage introuvable.' });
      if (!(await assertChantierWritable(req, res, pointage.chantierId))) return;
      if (!pointage.archivedAt) return res.status(409).json({ error: 'Ce pointage est déjà actif.' });
      const motifRestauration = motifRestaurationValide(req.body?.motifRestauration);
      if (!motifRestauration) return res.status(400).json({ error: 'Le motif de restauration doit contenir entre 3 et 500 caractères.' });
      const restaure = await transactionVerifiee(async (tx) => {
        const { count } = await tx.pointageHeure.updateMany({
          where: { id: pointageId, archivedAt: { not: null } },
          data: { archivedAt: null, archivedById: null, motifArchivage: null, updatedById: (req as AuthRequest).user!.id },
        });
        if (count === 0) return null;
        const actif = await tx.pointageHeure.findUniqueOrThrow({ where: { id: pointageId } });
        await journaliserSaisieTravaux(tx, req as AuthRequest, 'HEURE', 'RESTAURATION', pointageId, pointage.chantierId, pointage, actif, motifRestauration);
        return actif;
      });
      if (!restaure) return res.status(409).json({ error: 'Ce pointage est déjà actif.' });
      res.json(saisieSelonDroits(req)(restaure));
    } catch (error) {
      res.status(500).json({ error: 'Error restoring pointage' });
    }
  });

  // Clause de sécurisation : un chantier ne compte dans le CA et la marge validés du
  // commercial que s'il est Terminé ET Encaissé. Sans plan commercial, aucune commission
  // n'en découle (décision du 17-10-2026). Réservé aux admins ; togglable indépendamment
  // du statut Terminé/En cours. Chaque changement est journalisé (#181) ; un enregistrement à
  // l'identique ne change rien, pas même la date d'encaissement, et n'écrit aucune entrée.
  app.patch('/api/chantiers/:id/encaisse', requireAuth, requireAdmin, async (req, res) => {
    try {
      const encaisse = !!req.body.encaisse;
      const id = paramId(req);
      const chantier = await transactionVerifiee(async (tx) => {
        const [ligne] = await tx.$queryRaw<Array<{ encaisse: boolean; dateEncaissement: Date | null }>>(Prisma.sql`SELECT "encaisse", "dateEncaissement" FROM "Chantier" WHERE "id" = ${id} FOR UPDATE`);
        if (!ligne) return null;
        if (ligne.encaisse === encaisse) return tx.chantier.findUniqueOrThrow({ where: { id } });
        const dateEncaissement = encaisse ? new Date() : null;
        await journaliserChangementChantier(tx, id, (req as AuthRequest).user!, 'CHANGEMENT_ENCAISSEMENT',
          { encaisse: ligne.encaisse, dateEncaissement: ligne.dateEncaissement?.toISOString() ?? null },
          { encaisse, dateEncaissement: dateEncaissement?.toISOString() ?? null });
        return tx.chantier.update({ where: { id }, data: { encaisse, dateEncaissement } });
      });
      if (!chantier) return res.status(404).json({ error: 'Chantier introuvable' });
      res.json(decimalToNumber(chantier));
    } catch (error) {
      res.status(500).json({ error: 'Error updating encaissement' });
    }
  });
}
