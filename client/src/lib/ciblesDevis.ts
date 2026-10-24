// Lot 4 suite (décisions de Nelson des 22 et 23-10-2026) : un devis se convertit au plus deux fois,
// en deux cibles de types différents parmi chantier, intervention et contrat de maintenance, et son
// annulation annule ce qu'il a créé. Le serveur en reste juge ; l'écran n'en tire que les boutons
// à proposer et les textes à afficher.
export type CibleDevis = 'CHANTIER' | 'INTERVENTION' | 'CONTRAT';
export type ConversionEnregistree = { cibleType: string; cibleId: string; rang: number };

const CIBLES: CibleDevis[] = ['CHANTIER', 'INTERVENTION', 'CONTRAT'];
const CONVERSIONS_PAR_AFFAIRE = 2;

// Cibles encore possibles pour un devis convertible : celles qu'il n'a pas créées, tant qu'il n'en a
// pas créé deux.
export function ciblesEncorePossibles(conversions: ConversionEnregistree[]): CibleDevis[] {
  if (conversions.length >= CONVERSIONS_PAR_AFFAIRE) return [];
  return CIBLES.filter(cible => !conversions.some(c => c.cibleType === cible));
}

// Question posée avant l'annulation : elle dit ce qui sera annulé avec le devis.
export function questionAnnulation(conversions: ConversionEnregistree[]): string {
  const effets = [
    conversions.some(c => c.cibleType === 'CHANTIER') && 'son chantier',
    conversions.some(c => c.cibleType === 'CONTRAT') && 'son contrat de maintenance et les visites non réalisées de ce contrat',
    conversions.some(c => c.cibleType === 'INTERVENTION') && 'son intervention',
  ].filter(Boolean);
  const annonce = effets.length ? `L’annulation de ce devis annule aussi ${effets.join(', ')}.\n` : '';
  return `${annonce}Motif de l’annulation de ce devis ?`;
}

// Ligne affichée pour une cible créée par le devis, annulé ou non.
export function texteCible(cibleType: string, annule: boolean): string {
  if (cibleType === 'CHANTIER') return annule ? 'Chantier annulé avec le devis' : 'Chantier issu de ce devis';
  if (cibleType === 'INTERVENTION') return annule ? 'Intervention issue de ce devis, annulée' : 'Intervention issue de ce devis';
  return annule ? 'Contrat de maintenance annulé avec le devis' : 'Contrat de maintenance issu de ce devis';
}
