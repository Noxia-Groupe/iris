// Origines proposées à la création d'une facture. Une affaire ou un contrat annulés ne se facturent pas, ni
// une intervention annulée, d'un contrat annulé ou rattachée à une affaire annulée (décision de Nelson de la
// nuit du 26 au 27-10-2026, point 14 ; lectures retenues, à confirmer) : le serveur les refuse (409), l'écran
// ne les propose pas. La liste des interventions exclut déjà les annulées ; celle des contrats dit lesquels
// le sont.
export type SourceFacture = {
  id: string; statut?: string; clientId?: string; client?: { id: string };
  contratMaintenanceId?: string | null; chantier?: { statut?: string } | null;
};

export function sourceFacturable(source: SourceFacture, contratsAnnules: ReadonlySet<string>): boolean {
  if (source.statut === 'ANNULE' || source.statut === 'ANNULEE') return false;
  if (source.chantier?.statut === 'ANNULE') return false;
  return !(source.contratMaintenanceId && contratsAnnules.has(source.contratMaintenanceId));
}

export function sourcesFacturables<T extends SourceFacture>(sources: T[], contrats: SourceFacture[], clientId: string): T[] {
  const contratsAnnules = new Set(contrats.filter((contrat) => contrat.statut === 'ANNULE').map((contrat) => contrat.id));
  return sources
    .filter((source) => !clientId || source.clientId === clientId || source.client?.id === clientId)
    .filter((source) => sourceFacturable(source, contratsAnnules));
}
