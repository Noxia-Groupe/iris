// Lecture du journal d'audit de la fiche chantier : saisies Travaux (achats, heures) et
// changements de l'affaire elle-même : client, titulaire, commercial et case « Encaissé » (#181).

export type EntreeJournalChantier = { cible: string; action: string; avant?: unknown; apres?: unknown };

export function estChangementClient(entree: EntreeJournalChantier): boolean {
  return entree.cible === 'CHANTIER' && entree.action === 'CHANGEMENT_CLIENT';
}

// Un côté d'une réattribution : le nom du compte, figé à l'acte.
function compteLisible(valeur: unknown, sansCompte: string): string {
  const instantane = (valeur && typeof valeur === 'object' ? valeur : {}) as { nom?: string | null; responsableId?: string | null; commercialId?: string | null };
  if (!instantane.responsableId && !instantane.commercialId) return sansCompte;
  return instantane.nom || 'compte supprimé';
}
const encaissementLisible = (valeur: unknown) => ((valeur as { encaisse?: boolean } | null)?.encaisse ? 'Encaissé' : 'Non encaissé');

const CHANGEMENTS_AFFAIRE: Record<string, { titre: string; lisible: (valeur: unknown) => string }> = {
  CHANGEMENT_CLIENT: { titre: 'Client de l’affaire — changement', lisible: (valeur) => clientLisible(valeur) },
  CHANGEMENT_TITULAIRE: { titre: 'Titulaire — réattribution', lisible: (valeur) => compteLisible(valeur, 'aucun titulaire') },
  CHANGEMENT_COMMERCIAL: { titre: 'Commercial — réattribution', lisible: (valeur) => compteLisible(valeur, 'aucun commercial') },
  CHANGEMENT_ENCAISSEMENT: { titre: 'Encaissement — changement', lisible: encaissementLisible },
};

// Un changement de l'affaire, lisible des deux côtés ; null pour une saisie Travaux.
export function changementAffaire(entree: EntreeJournalChantier): { avant: string; apres: string } | null {
  const changement = entree.cible === 'CHANTIER' ? CHANGEMENTS_AFFAIRE[entree.action] : undefined;
  return changement ? { avant: changement.lisible(entree.avant), apres: changement.lisible(entree.apres) } : null;
}

export function titreEntreeJournal(entree: EntreeJournalChantier): string {
  if (entree.cible === 'CHANTIER' && CHANGEMENTS_AFFAIRE[entree.action]) return CHANGEMENTS_AFFAIRE[entree.action].titre;
  return `${entree.cible === 'ACHAT' ? 'Achat' : 'Heures'} — ${entree.action.toLowerCase()}`;
}

// Un côté d'un changement de client : la fiche client (raison sociale figée à l'acte), et le
// libellé de l'affaire quand il en diffère, par exemple pour une affaire héritée réparée.
export function clientLisible(valeur: unknown): string {
  const instantane = (valeur && typeof valeur === 'object' ? valeur : {}) as { raisonSociale?: string | null; libelle?: string | null };
  const fiche = instantane.raisonSociale || 'aucune fiche client liée';
  return instantane.libelle && instantane.libelle !== instantane.raisonSociale
    ? `${fiche} (libellé de l’affaire : « ${instantane.libelle} »)`
    : fiche;
}
