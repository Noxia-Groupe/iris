const FUSEAUX_HORAIRES_FRANCAIS = [
  'Europe/Paris', 'America/Guadeloupe', 'America/Martinique', 'America/Cayenne',
  'America/Miquelon', 'Indian/Mayotte', 'Indian/Reunion', 'Pacific/Noumea',
  'Pacific/Wallis', 'Pacific/Tahiti', 'Pacific/Marquesas', 'Pacific/Gambier',
] as const;
export const FUSEAU_HORAIRE_PAR_DEFAUT = 'Europe/Paris';

export function fuseauHoraireEntrepriseValide(fuseauHoraire: unknown): fuseauHoraire is typeof FUSEAUX_HORAIRES_FRANCAIS[number] {
  return typeof fuseauHoraire === 'string' && (FUSEAUX_HORAIRES_FRANCAIS as readonly string[]).includes(fuseauHoraire);
}

// Un jour civil dérivé d'un instant doit toujours être lu dans le fuseau de l'entreprise,
// jamais dans UTC ou dans le fuseau de la machine qui exécute le serveur.
export function jourCivilEntreprise(instant: Date, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT): string {
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuseauHoraire, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const valeur = (type: Intl.DateTimeFormatPartTypes) => parties.find((partie) => partie.type === type)?.value;
  return `${valeur('year')}-${valeur('month')}-${valeur('day')}`;
}

export function aujourdHuiEntreprise(fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT, instant = new Date()): string {
  return jourCivilEntreprise(instant, fuseauHoraire);
}

// Les références annuelles sont dérivées d'un instant de création : leur exercice est
// donc celui du jour civil de l'entreprise, jamais celui d'UTC ou de la machine serveur.
export function anneeEntreprise(instant: Date, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT): number {
  return Number(jourCivilEntreprise(instant, fuseauHoraire).slice(0, 4));
}

// La règle « pas de facture postdatée » compare des JOURS CIVILS de l'entreprise, jamais
// des instants. `instant` est injectable pour que la règle soit testable sans dépendre de
// l'heure qu'il est au moment où la suite tourne.
export function dateEmissionEstFuture(dateEmission: string, fuseauHoraire: string, instant = new Date()): boolean {
  return dateSeuleEnJourCivil(dateEmission) > aujourdHuiEntreprise(fuseauHoraire, instant);
}

export function dateSeuleEnJourCivil(dateSeule: Date | string): string {
  // Une date-seule est stockée à minuit UTC et ne désigne pas un instant : on lit ses
  // composantes telles quelles. La relire dans un fuseau la ferait basculer d'un jour
  // à l'ouest de Greenwich — et d'un exercice quand la date est un 1er janvier.
  return (typeof dateSeule === 'string' ? dateSeule : dateSeule.toISOString()).slice(0, 10);
}
