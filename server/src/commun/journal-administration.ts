import { prisma } from '../db';
import { isSuperAdminRole } from '../droits/roles';
import type { AuthRequest } from '../http/auth';
import { decimalToNumber } from './montants';

export function valeurJournal(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(decimalToNumber(value))) as Record<string, unknown>;
}

// --- Journal des paramètres et des droits (lot (a), décision de Nelson du 13-10-2026) ---
// Chaque changement de réglage ou de droits d'un compte s'écrit dans la même transaction que le
// changement lui-même : si l'entrée ne peut pas être écrite, le changement est annulé. Seuls les
// champs qui changent sont gardés (avant / après) ; un enregistrement sans changement n'écrit
// rien. Aucun secret n'y entre (clé d'intégration, jeton du partage public).
type EntreeJournalAdministration = {
  domaine: 'DROITS' | 'REGLAGES';
  type: 'COMPTE' | 'PARAMETRES' | 'MODULES' | 'REMUNERATION' | 'PRIME_COMMERCIAL' | 'SOCIETE' | 'CLE_INTEGRATION' | 'PARTAGE_PLANNING' | 'CONSERVATION_JOURNAL';
  action: string;
  cibleId?: string | null;
  cibleLibelle?: string | null;
  avant?: Record<string, unknown> | null;
  apres?: Record<string, unknown> | null;
  detail?: string | null;
  // Entrée fermée au simple administrateur : elle concerne un compte super administrateur
  // (décision du 14-10-2026), ou relève d'un réglage réservé au super administrateur dont
  // l'historique lui est réservé aussi (clés d'intégration).
  concerneSuperAdmin?: boolean;
  reserveSuperAdmin?: boolean;
};

const AUTEUR_JOURNAL_DEMARRAGE = 'Iris (démarrage, SUPERADMIN_EMAILS)';

export async function journaliserAdministration(tx: any, req: AuthRequest | null, entree: EntreeJournalAdministration) {
  const auteur = req?.user;
  await tx.journalAdministration.create({
    data: {
      domaine: entree.domaine,
      type: entree.type,
      action: entree.action,
      cibleId: entree.cibleId ?? null,
      cibleLibelle: entree.cibleLibelle ?? null,
      avant: entree.avant ? valeurJournal(entree.avant) : undefined,
      apres: entree.apres ? valeurJournal(entree.apres) : undefined,
      detail: entree.detail ?? null,
      concerneSuperAdmin: !!entree.concerneSuperAdmin,
      reserveSuperAdmin: !!entree.reserveSuperAdmin,
      auteurId: auteur?.id ?? null,
      auteurNom: auteur?.name?.trim() || AUTEUR_JOURNAL_DEMARRAGE,
      auteurSuperAdmin: isSuperAdminRole(auteur?.role),
    },
  });
}

// Champs qui changent entre deux états, valeurs normalisées comme dans le journal (décimaux en
// nombres, dates en ISO). Null si rien ne change.
export function changementsJournal(avant: Record<string, unknown> | null | undefined, apres: Record<string, unknown> | null | undefined, champs: readonly string[]) {
  const ancien: Record<string, unknown> = {};
  const nouveau: Record<string, unknown> = {};
  for (const champ of champs) {
    const a = valeurJournal({ v: avant?.[champ] ?? null }).v ?? null;
    const b = valeurJournal({ v: apres?.[champ] ?? null }).v ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      ancien[champ] = a;
      nouveau[champ] = b;
    }
  }
  return Object.keys(nouveau).length ? { avant: ancien, apres: nouveau } : null;
}

// Supprime les entrées plus anciennes que la durée de conservation (Parametres.
// journalConservationJours). Le trigger de la table refuse toute autre suppression. Appelée au
// démarrage et à chaque consultation du journal : sans tâche planifiée, une entrée échue
// disparaît au plus tard à la consultation suivante.
export async function purgerJournalAdministration() {
  await prisma.$executeRaw`DELETE FROM "JournalAdministration" WHERE "createdAt" < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - make_interval(days => COALESCE((SELECT "journalConservationJours" FROM "Parametres" WHERE "id" = 'singleton'), 90))`;
}

// Verrouille la ligne d'un réglage unique le temps de la transaction : deux enregistrements
// simultanés ne peuvent pas journaliser le même « avant ». Sans ligne (première écriture), rien
// n'est verrouillé, et l'avant est vide.
export async function verrouillerReglage(tx: any, table: 'Parametres' | 'ParametresRemuneration' | 'CompanySettings' | 'PlanningPublicShare') {
  await tx.$queryRawUnsafe(`SELECT 1 FROM "${table}" WHERE "id" = 'singleton' FOR UPDATE`);
}
