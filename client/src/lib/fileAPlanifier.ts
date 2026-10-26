import { formatDateOnly } from './dateFormatting';

// File « à planifier » : visites d'un contrat actif (échéance, durée prévue) et interventions
// curatives, sans contrat ni durée prévue (lot pilote 3) ; s'y ajoutent les interventions terminées « à
// suivre », jusqu'à la création de leur suite (intervention de suivi liée).
export type ContractQueueItem = {
  id: string; reference: string; titre: string; echeanceContrat: string | null; dateSouhaitee: string | null;
  statut?: string; aSuivre?: boolean; priorite?: string;
  client: { raisonSociale: string }; site: { nom: string; ville: string } | null;
  contratMaintenance: { id: string; titre: string } | null;
  dureePrevisionnelleMinutes: number | null;
};
// Date due : l'échéance d'une visite, la date souhaitée d'une curative ; vide sans date.
export const dateDue = (item: ContractQueueItem): string => { const date = item.echeanceContrat ?? item.dateSouhaitee; return date ? formatDateOnly(date) : ''; };
