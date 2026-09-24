export type EntreeJournalSaisie = {
  id: string;
  cible: string;
  cibleId: string;
  action: string;
};

// L'API renvoie le journal du plus récent au plus ancien. Seule la première entrée
// ARCHIVAGE ou RESTAURATION d'une écriture décrit son état courant.
export function archivagesRestaurables(journalDuPlusRecent: EntreeJournalSaisie[]): Set<string> {
  const vues = new Set<string>();
  const restaurables = new Set<string>();
  for (const entree of journalDuPlusRecent) {
    if (entree.action !== 'ARCHIVAGE' && entree.action !== 'RESTAURATION') continue;
    const cle = `${entree.cible}:${entree.cibleId}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    if (entree.action === 'ARCHIVAGE') restaurables.add(entree.id);
  }
  return restaurables;
}
