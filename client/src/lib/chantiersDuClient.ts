// Chantiers qu'une intervention SAV peut viser (décision de Nelson du 16-10-2026, #144) : ceux liés
// à la fiche de son client (clientId), et non ceux dont le libellé reprend sa raison sociale. Une
// affaire héritée sans fiche n'est pas proposée ; le serveur applique la même règle.
export function chantiersDuClient<T extends { clientId?: string | null }>(chantiers: T[], clientId: string): T[] {
  return chantiers.filter((chantier) => !!chantier.clientId && chantier.clientId === clientId);
}
