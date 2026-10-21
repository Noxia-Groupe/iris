import { Prisma, type ExecutionGenerationVisites } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import type { AuthRequest } from '../../http/auth';
import { FUSEAU_HORAIRE_PAR_DEFAUT, dateFrancaise, jourCivilEntreprise } from '../../commun/dates';
import { getParametres } from '../parametres/metier';
import { avancerEcheanceContrat, creerVisiteContrat, verrouillerContratMaintenance, visiteDeLEcheance } from './metier';

// --- Génération automatique des visites de maintenance (lot pilote 5) ---
// Une fois par jour civil de la société, côté serveur et sans IA, chaque contrat actif est relu
// sous son verrou :
//  - si la visite de l'échéance courante est terminée, l'échéance passe à la suivante, selon la
//    même règle que l'action « Échéance suivante » de l'écran ;
//  - si l'échéance n'a pas encore de visite et tombe dans l'anticipation réglée
//    (Parametres.anticipationVisitesJours), l'intervention à planifier est créée, comme par
//    l'action « Générer l'intervention ».
// Un contrat dont le client est désactivé, ou dont la visite de l'échéance a été annulée, est
// laissé de côté et signalé. Chaque contrat est traité dans sa propre transaction : un contrat en
// échec est consigné sans empêcher les autres, et le passage est alors en échec (alerte).

export type ContratIgnore = { contratId: string; titre: string; motif: string };
export type ErreurContrat = { contratId: string | null; titre: string | null; message: string };
export class GenerationVisitesDesactivee extends Error {}

const MS_PAR_JOUR = 86_400_000;
// Un passage resté « en cours » plus longtemps a été interrompu (serveur arrêté, base perdue).
export const DUREE_MAX_PASSAGE_MS = 60 * 60_000;
// Intervalle des vérifications du minuteur : le passage du jour a lieu à la première vérification
// du jour civil de la société, puis les suivantes constatent qu'il a déjà eu lieu.
export const INTERVALLE_VERIFICATION_MS = 15 * 60_000;
const PREFIXE_AUTOMATIQUE = 'Génération automatique : ';
const PREFIXE_MANUEL = 'Génération des visites lancée par un administrateur : ';

const jourEnDate = (jour: string) => new Date(`${jour}T00:00:00.000Z`);

async function fuseauSociete() {
  const societe = await prisma.companySettings.findUnique({ where: { id: 'singleton' }, select: { fuseauHoraire: true } });
  return societe?.fuseauHoraire || FUSEAU_HORAIRE_PAR_DEFAUT;
}

type ResultatContrat = { creee: boolean; avancee: boolean; ignore?: string };

async function traiterContrat(contratId: string, horizon: Date, req: AuthRequest | null, prefixe: string): Promise<ResultatContrat> {
  return transactionVerifiee(async (tx) => {
    await verrouillerContratMaintenance(tx, contratId);
    let contrat = await tx.contratMaintenance.findFirst({ where: { id: contratId, statut: 'ACTIF' } });
    // Suspendu ou clos depuis la lecture de la liste : plus rien à générer.
    if (!contrat) return { creee: false, avancee: false };
    const client = await tx.client.findUnique({ where: { id: contrat.clientId }, select: { actif: true } });
    if (!client?.actif) return { creee: false, avancee: false, ignore: 'Client désactivé : aucune visite n’est créée ni aucune échéance avancée.' };
    let avancee = false;
    let visite = await visiteDeLEcheance(tx, contrat);
    if (visite?.statut === 'TERMINEE') {
      contrat = await avancerEcheanceContrat(tx, contrat, visite, req, prefixe);
      avancee = true;
      visite = await visiteDeLEcheance(tx, contrat);
    }
    if (visite?.statut === 'ANNULEE') {
      return { creee: false, avancee, ignore: `Visite ${visite.reference} de l’échéance du ${dateFrancaise(contrat.prochaineEcheance)} annulée : l’échéance n’avance plus d’elle-même.` };
    }
    if (visite || contrat.prochaineEcheance > horizon) return { creee: false, avancee };
    await creerVisiteContrat(tx, contrat, req, `${prefixe}échéance du ${dateFrancaise(contrat.prochaineEcheance)}.`);
    return { creee: true, avancee };
  });
}

// Passage de la génération. Automatique : au plus un par jour civil de la société (la clé du jour
// est unique) ; renvoie null si l'anticipation est vide ou si le passage du jour a déjà eu lieu.
// Manuel : lancé par un administrateur, à tout moment ; refusé si l'anticipation est vide.
export async function executerGenerationVisites(
  declenchement: { type: 'AUTOMATIQUE' } | { type: 'MANUEL'; req: AuthRequest },
  instant = new Date(),
): Promise<ExecutionGenerationVisites | null> {
  const { anticipationVisitesJours: anticipation } = await getParametres();
  if (anticipation === null) {
    if (declenchement.type === 'AUTOMATIQUE') return null;
    throw new GenerationVisitesDesactivee('La génération automatique des visites est désactivée : réglez d’abord son anticipation.');
  }
  const jour = jourCivilEntreprise(instant, await fuseauSociete());
  const req = declenchement.type === 'MANUEL' ? declenchement.req : null;
  let execution: ExecutionGenerationVisites;
  try {
    execution = await prisma.executionGenerationVisites.create({ data: {
      jour: jourEnDate(jour), declenchement: declenchement.type, anticipationJours: anticipation,
      cleJourAutomatique: req ? null : jour, auteurId: req ? req.user!.id : null, auteurNom: req ? req.user!.name : null,
    } });
  } catch (error) {
    if (!req && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }

  const horizon = new Date(jourEnDate(jour).getTime() + anticipation * MS_PAR_JOUR);
  const prefixe = req ? PREFIXE_MANUEL : PREFIXE_AUTOMATIQUE;
  const contratsIgnores: ContratIgnore[] = [];
  const erreurs: ErreurContrat[] = [];
  let visitesCreees = 0;
  let echeancesAvancees = 0;
  try {
    const contrats = await prisma.contratMaintenance.findMany({
      where: { statut: 'ACTIF' }, select: { id: true, titre: true }, orderBy: [{ prochaineEcheance: 'asc' }, { id: 'asc' }],
    });
    for (const contrat of contrats) {
      try {
        const resultat = await traiterContrat(contrat.id, horizon, req, prefixe);
        if (resultat.creee) visitesCreees += 1;
        if (resultat.avancee) echeancesAvancees += 1;
        if (resultat.ignore) contratsIgnores.push({ contratId: contrat.id, titre: contrat.titre, motif: resultat.ignore });
      } catch (error) {
        console.error(`[GÉNÉRATION DES VISITES] Contrat ${contrat.id} non traité :`, error);
        erreurs.push({ contratId: contrat.id, titre: contrat.titre, message: 'Contrat non traité : erreur technique, détaillée dans le journal du serveur.' });
      }
    }
  } catch (error) {
    console.error('[GÉNÉRATION DES VISITES] Lecture des contrats impossible :', error);
    erreurs.push({ contratId: null, titre: null, message: 'Lecture des contrats impossible : erreur technique, détaillée dans le journal du serveur.' });
  }
  return prisma.executionGenerationVisites.update({
    where: { id: execution.id },
    data: {
      fin: new Date(), statut: erreurs.length ? 'ECHEC' : 'REUSSIE', visitesCreees, echeancesAvancees,
      contratsIgnores: contratsIgnores as Prisma.InputJsonValue, erreurs: erreurs as Prisma.InputJsonValue,
    },
  });
}

// Le minuteur tourne sauf si GENERATION_VISITES_AUTOMATIQUE vaut 0 : les tests de bout en bout et
// l'outil de comparaison du rendu l'arrêtent, pour qu'aucun passage ne crée de visite pendant
// qu'ils tournent. Les passages manuels restent possibles.
export function minuteurGenerationActif(): boolean {
  return process.env.GENERATION_VISITES_AUTOMATIQUE?.trim() !== '0';
}

// Alerte destinée aux administrateurs, ou null :
//  - le dernier passage terminé est en échec, ou le dernier passage s'est interrompu ;
//  - le minuteur tourne, mais aucun passage automatique n'a eu lieu ni aujourd'hui ni hier alors
//    qu'il en a déjà eu un.
// Rien n'est signalé lorsque la génération est désactivée (anticipation vide).
export function alerteGenerationVisites(etat: {
  anticipation: number | null; minuteurActif: boolean; jour: string; instant: Date;
  derniere: Pick<ExecutionGenerationVisites, 'jour' | 'statut' | 'debut' | 'erreurs'> | null;
  derniereAutomatique: Pick<ExecutionGenerationVisites, 'jour'> | null;
}): string | null {
  const { anticipation, minuteurActif, jour, instant, derniere, derniereAutomatique } = etat;
  if (anticipation === null) return null;
  if (derniere?.statut === 'ECHEC') {
    const nombre = Array.isArray(derniere.erreurs) ? derniere.erreurs.length : 0;
    return `La génération des visites du ${dateFrancaise(derniere.jour)} est en échec (${nombre} erreur${nombre > 1 ? 's' : ''}) : des visites peuvent manquer. Relancez-la une fois la cause corrigée.`;
  }
  if (derniere?.statut === 'EN_COURS' && instant.getTime() - derniere.debut.getTime() > DUREE_MAX_PASSAGE_MS) {
    return `La génération des visites du ${dateFrancaise(derniere.jour)} s’est interrompue avant la fin : relancez-la.`;
  }
  if (minuteurActif && derniereAutomatique && derniereAutomatique.jour.getTime() < jourEnDate(jour).getTime() - MS_PAR_JOUR) {
    return `La génération automatique des visites n’a pas tourné depuis le ${dateFrancaise(derniereAutomatique.jour)} : vérifiez que le serveur fonctionne.`;
  }
  return null;
}

export async function etatGenerationVisites(instant = new Date()) {
  const [{ anticipationVisitesJours: anticipation }, fuseau, derniere, derniereAutomatique] = await Promise.all([
    getParametres(),
    fuseauSociete(),
    prisma.executionGenerationVisites.findFirst({ orderBy: [{ debut: 'desc' }, { id: 'desc' }] }),
    prisma.executionGenerationVisites.findFirst({ where: { declenchement: 'AUTOMATIQUE' }, orderBy: [{ jour: 'desc' }] }),
  ]);
  const minuteurActif = minuteurGenerationActif();
  const jour = jourCivilEntreprise(instant, fuseau);
  return {
    anticipationVisitesJours: anticipation,
    minuteurActif,
    derniereExecution: derniere,
    derniereExecutionAutomatique: derniereAutomatique,
    alerte: alerteGenerationVisites({ anticipation, minuteurActif, jour, instant, derniere, derniereAutomatique }),
  };
}

// Démarre le minuteur (appelé une fois, au lancement du serveur, après l'initialisation de la
// base) : une vérification aussitôt, puis toutes les INTERVALLE_VERIFICATION_MS. Une vérification
// ne commence pas tant que la précédente tourne, et un échec n'arrête jamais le serveur.
export function demarrerGenerationAutomatique(): NodeJS.Timeout | null {
  if (!minuteurGenerationActif()) {
    console.warn('[GÉNÉRATION DES VISITES] Génération automatique arrêtée sur ce serveur (GENERATION_VISITES_AUTOMATIQUE=0).');
    return null;
  }
  let enCours = false;
  const verifier = async () => {
    if (enCours) return;
    enCours = true;
    try {
      const execution = await executerGenerationVisites({ type: 'AUTOMATIQUE' });
      if (execution) {
        const bilan = `${execution.visitesCreees} visite(s) créée(s), ${execution.echeancesAvancees} échéance(s) avancée(s), ${(execution.contratsIgnores as unknown[]).length} contrat(s) laissé(s) de côté`;
        if (execution.statut === 'ECHEC') console.error(`[GÉNÉRATION DES VISITES] Passage du ${dateFrancaise(execution.jour)} en échec : ${bilan}, ${(execution.erreurs as unknown[]).length} erreur(s).`);
        else console.log(`[GÉNÉRATION DES VISITES] Passage du ${dateFrancaise(execution.jour)} : ${bilan}.`);
      }
    } catch (error) {
      console.error('[GÉNÉRATION DES VISITES] Passage automatique impossible, nouvel essai à la prochaine vérification :', error);
    } finally {
      enCours = false;
    }
  };
  void verifier();
  const minuteur = setInterval(() => void verifier(), INTERVALLE_VERIFICATION_MS);
  minuteur.unref();
  return minuteur;
}
