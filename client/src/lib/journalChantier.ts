// Lecture du journal d'audit de la fiche chantier : saisies Travaux (achats, heures) et
// changements du client de l'affaire.

export type EntreeJournalChantier = { cible: string; action: string };

export function estChangementClient(entree: EntreeJournalChantier): boolean {
  return entree.cible === 'CHANTIER' && entree.action === 'CHANGEMENT_CLIENT';
}

export function titreEntreeJournal(entree: EntreeJournalChantier): string {
  if (estChangementClient(entree)) return 'Client de l’affaire — changement';
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
