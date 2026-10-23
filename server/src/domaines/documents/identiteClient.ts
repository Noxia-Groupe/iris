import type { ClientSite, Prisma } from '@prisma/client';
import { SITE_FACTURATION_ORDRE } from '../factures/metier';

// Identité minimale du client pour signer un devis et pour émettre une facture (lot 6a-2 bis),
// décidée par Nelson le 23-10-2026 :
//   - un client professionnel (case « pas de SIRET » décochée) porte une raison sociale, une
//     adresse de facturation et un SIREN (« un SIREN suffit ») ;
//   - un client sans SIRET (particulier, case cochée) n'a besoin que de son nom complet et de son
//     adresse (« L’identité minimal d’un client sans siret, avoir le nom du client complet et de son
//     adresse »).
// L'adresse est celle du site retenu par SITE_FACTURATION_ORDRE, le même que celui copié sur le
// devis signé et sur la facture émise : un autre site complet ne la remplace pas.
// L'identité de la société émettrice suit sa propre règle (CHAMPS_IDENTITE_OBLIGATOIRES, identite.ts).
export const LIBELLE_SIREN_CLIENT_MANQUANT = 'SIREN (ou case « pas de SIRET » pour un particulier)';

type ClientLu = { raisonSociale: string | null; siren: string | null; sansSiret: boolean };
type SiteLu = { adresse: string | null; codePostal: string | null; ville: string | null };

const renseigne = (valeur: string | null | undefined) => typeof valeur === 'string' && valeur.trim() !== '';

// Libellés des champs manquants, dans l'ordre de la fiche : nom, adresse, SIREN.
export function champsIdentiteClientManquants(client: ClientLu, siteFacturation: SiteLu | null | undefined): string[] {
  const manquants: string[] = [];
  if (!renseigne(client.raisonSociale)) manquants.push(client.sansSiret ? 'nom complet' : 'raison sociale');
  if (!siteFacturation || !renseigne(siteFacturation.adresse) || !renseigne(siteFacturation.codePostal) || !renseigne(siteFacturation.ville)) {
    manquants.push('adresse de facturation');
  }
  if (!client.sansSiret && !renseigne(client.siren)) manquants.push(LIBELLE_SIREN_CLIENT_MANQUANT);
  return manquants;
}

export class IdentiteClientIncompleteError extends Error {
  // `avant` complète le message : « d’émettre une facture », « d’enregistrer la signature d’un devis ».
  constructor(readonly manquants: string[], avant: string) {
    super(`Identité du client incomplète : renseignez ${manquants.join(', ')} sur la fiche client avant ${avant}.`);
  }
}

// Relit la fiche client et son site de facturation dans la transaction de l'appelant et refuse,
// sans rien écrire, une identité incomplète. Retourne ce que l'appelant copie : la raison sociale
// (ou le nom complet) et le site retenu.
export async function exigerIdentiteClient(tx: Prisma.TransactionClient, clientId: string, avant: string): Promise<{ raisonSociale: string; siteFacturation: ClientSite }> {
  const client = await tx.client.findUniqueOrThrow({ where: { id: clientId }, select: { raisonSociale: true, siren: true, sansSiret: true } });
  const siteFacturation = await tx.clientSite.findFirst({ where: { clientId }, orderBy: SITE_FACTURATION_ORDRE });
  const manquants = champsIdentiteClientManquants(client, siteFacturation);
  if (manquants.length || !siteFacturation) throw new IdentiteClientIncompleteError(manquants, avant);
  return { raisonSociale: client.raisonSociale.trim(), siteFacturation };
}
