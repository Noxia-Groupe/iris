import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import type { AuthRequest } from '../../http/auth';
import { paramId } from '../../http/requete';
import { decimalToNumber } from '../../commun/montants';
import { journaliserAdministration } from '../../commun/journal-administration';

// --- Rattachement d'un intervenant à une main d'œuvre (décision de Nelson du 24-10-2026) ---
// « Liée à l'intervenant » : chaque technicien (fiche intervenant) est rattaché à une main d'œuvre du
// catalogue ; sur une intervention hors contrat, ses heures sont valorisées au prix de vente à l'heure
// hors contrat de cette main d'œuvre, figé sur l'heure à sa saisie, pour la marge d'un SAV hors contrat
// (margeSav.ts ; rien n'est calculé ici). Le rattachement est facultatif et réglé par l'administration
// seule, comme le taux horaire. Il exige une main d'œuvre active ; désactiver une main d'œuvre garde
// les rattachements existants (choix par défaut, à confirmer). Chaque changement est écrit au journal
// des paramètres et des droits, la fiche intervenant n'ayant pas de journal propre.

type MainOeuvreResumee = { id: string; reference: string; nom: string; actif: boolean };
const SELECTION_MAIN_OEUVRE = { id: true, reference: true, nom: true, actif: true } as const;
export const INCLUSION_RATTACHEMENT = { rattachementMainOeuvre: { include: { prestation: { select: SELECTION_MAIN_OEUVRE } } } } as const;

const libelleMainOeuvre = (mainOeuvre: { reference: string; nom: string } | null | undefined) => (mainOeuvre ? `${mainOeuvre.reference} — ${mainOeuvre.nom}` : null);

// Vue de l'administration : la fiche avec sa main d'œuvre (identifiant, référence, nom, activité).
export function avecMainOeuvre<T extends { rattachementMainOeuvre?: { prestationId: string; prestation: MainOeuvreResumee } | null }>(fiche: T) {
  const { rattachementMainOeuvre, ...reste } = fiche;
  return { ...reste, mainOeuvreId: rattachementMainOeuvre?.prestationId ?? null, mainOeuvre: rattachementMainOeuvre?.prestation ?? null };
}

// Lu dans la transaction de la suppression d'une fiche, sous son verrou : la suppression emporte le
// rattachement (ON DELETE CASCADE), journalisé comme un retrait.
export async function journaliserRattachementSupprime(tx: Prisma.TransactionClient, req: express.Request, fiche: { id: string; nom: string }) {
  const rattachement = await tx.intervenantMainOeuvre.findUnique({ where: { intervenantId: fiche.id }, include: { prestation: { select: SELECTION_MAIN_OEUVRE } } });
  if (!rattachement) return;
  await journaliserAdministration(tx, req as AuthRequest, {
    domaine: 'REGLAGES', type: 'INTERVENANT', action: 'RATTACHEMENT_MAIN_OEUVRE', cibleId: fiche.id, cibleLibelle: fiche.nom,
    avant: { mainOeuvre: libelleMainOeuvre(rattachement.prestation) }, apres: { mainOeuvre: null },
    detail: `Fiche intervenant supprimée ; main d’œuvre ${rattachement.prestationId}.`,
  });
}

// PUT /api/intervenants/:id/main-oeuvre { mainOeuvreId } — `null` retire le rattachement.
export const rattacherMainOeuvre: express.RequestHandler = async (req, res) => {
  const id = paramId(req);
  const brut = (req.body ?? {}).mainOeuvreId;
  if (brut !== null && (typeof brut !== 'string' || !brut.trim())) return res.status(400).json({ error: 'Main d’œuvre invalide : identifiant attendu, ou null pour retirer le rattachement.' });
  const mainOeuvreId = brut === null ? null : brut.trim();
  try {
    // READ COMMITTED explicite (#226). Verrous dans l'ordre : la fiche (FOR UPDATE), puis la main
    // d'œuvre (FOR SHARE), qu'une modification, une désactivation ou un retour en prestation
    // ordinaire verrouillent FOR UPDATE : l'un attend l'autre, puis relit ce qu'il a écrit.
    const resultat = await transactionVerifiee(async (tx) => {
      const [fiche] = await tx.$queryRaw<Array<{ id: string; nom: string }>>(Prisma.sql`SELECT "id", "nom" FROM "Intervenant" WHERE "id" = ${id} FOR UPDATE`);
      if (!fiche) return { statut: 404, erreur: 'Intervenant introuvable.' };
      const actuel = await tx.intervenantMainOeuvre.findUnique({ where: { intervenantId: id }, include: { prestation: { select: SELECTION_MAIN_OEUVRE } } });
      if ((actuel?.prestationId ?? null) === mainOeuvreId) return { statut: 200 };
      let cible: MainOeuvreResumee | null = null;
      if (mainOeuvreId) {
        const [prestation] = await tx.$queryRaw<Array<MainOeuvreResumee & { estMainOeuvre: boolean }>>(Prisma.sql`SELECT "id", "reference", "nom", "actif", "estMainOeuvre" FROM "CataloguePrestation" WHERE "id" = ${mainOeuvreId} FOR SHARE`);
        if (!prestation || !prestation.estMainOeuvre) return { statut: 400, erreur: 'Main d’œuvre introuvable : choisissez une main d’œuvre du catalogue.' };
        if (!prestation.actif) return { statut: 400, erreur: `La main d’œuvre « ${prestation.nom} » est désactivée : choisissez une main d’œuvre active.` };
        cible = prestation;
        await tx.intervenantMainOeuvre.upsert({ where: { intervenantId: id }, create: { intervenantId: id, prestationId: prestation.id }, update: { prestationId: prestation.id } });
      } else {
        await tx.intervenantMainOeuvre.delete({ where: { intervenantId: id } });
      }
      // Le changement validé, la fiche est réécrite sans rien y changer (lot « marge d'un SAV hors contrat ») :
      // une saisie d'heures SAV, sérialisable, qui attend son verrou (verrouillerContexteCout) est alors refusée
      // (conflit, 409), comme après un changement de taux, au lieu de figer le prix de vente de son instantané,
      // pris avant ce changement.
      await tx.$executeRaw(Prisma.sql`UPDATE "Intervenant" SET "nom" = "nom" WHERE "id" = ${id}`);
      await journaliserAdministration(tx, req as AuthRequest, {
        domaine: 'REGLAGES', type: 'INTERVENANT', action: 'RATTACHEMENT_MAIN_OEUVRE', cibleId: fiche.id, cibleLibelle: fiche.nom,
        avant: { mainOeuvre: libelleMainOeuvre(actuel?.prestation) }, apres: { mainOeuvre: libelleMainOeuvre(cible) },
        detail: `Main d’œuvre ${actuel?.prestationId ?? 'aucune'} → ${cible?.id ?? 'aucune'}.`,
      });
      return { statut: 200 };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (resultat.statut !== 200) return res.status(resultat.statut).json({ error: resultat.erreur });
    const fiche = await prisma.intervenant.findUnique({ where: { id }, include: INCLUSION_RATTACHEMENT });
    res.json(decimalToNumber(fiche ? avecMainOeuvre(fiche) : null));
  } catch {
    res.status(500).json({ error: 'Impossible de rattacher cette main d’œuvre.' });
  }
};
