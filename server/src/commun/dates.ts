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

export function dateIsoStricte(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Le format métier français est JJ-MM-AAAA. YYYY-MM-DD reste accepté pour les champs
  // HTML natifs. Une date-heure ISO est également acceptée, car l'API la renvoie elle-même. Une
  // date-seule ne peut pas porter l'heure : on retient la date telle qu'elle est écrite, selon la
  // réponse de Nelson du 14-10-2026 (« Avec l'api qui renvoi une date avec heure tu retiens la
  // date simplement si ce n'est pas possible de prendre egalement en compte l'heure qui va
  // avec »). Sans décalage, l'heure ne désigne aucun instant. Avec un décalage, la date écrite est
  // gardée aussi, et non le jour de la société de l'instant (décision de Nelson du 15-10-2026 :
  // « garde le comportement actuel ») : cette lecture le faisait déjà pour « Z » et ±HH:MM
  // (±HHMM est accepté depuis #130), et l'API d'Iris renvoie une date-seule sous la forme
  // …T00:00:00.000Z, qu'une conversion au jour de la société décalerait. L'heure et le décalage
  // doivent être valides (HH:MM de 00:00 à 23:59, secondes et fraction facultatives).
  const isoComplet = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/.exec(value);
  if (isoComplet) return dateIsoStricte(`${isoComplet[1]}-${isoComplet[2]}-${isoComplet[3]}`);
  const match = /^(?:(\d{2})-(\d{2})-(\d{4})|(\d{4})-(\d{2})-(\d{2}))$/.exec(value);
  if (!match) return null;
  const [, jourFr, moisFr, anneeFr, anneeIso, moisIso, jourIso] = match;
  const annee = Number(anneeFr || anneeIso);
  const mois = Number(moisFr || moisIso);
  const jour = Number(jourFr || jourIso);
  const date = new Date(Date.UTC(annee, mois - 1, jour));
  if (date.getUTCFullYear() !== annee || date.getUTCMonth() !== mois - 1 || date.getUTCDate() !== jour) return null;
  return date.toISOString();
}

// Les dates-seules restent des jours métier et ne doivent donc jamais être relues dans
// un fuseau. En revanche, une référence qui est un instant (ou l'instant courant) doit
// d'abord devenir le jour civil de l'entreprise.
export function jourCivilDeReference(refParam: unknown, fuseauHoraire: string, instant = new Date()): string {
  if (typeof refParam === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(refParam)) return refParam;
  const parsed = refParam instanceof Date ? refParam : (typeof refParam === 'string' && refParam ? new Date(refParam) : instant);
  return jourCivilEntreprise(isNaN(parsed.getTime()) ? instant : parsed, fuseauHoraire);
}

export function ajouterJoursCivils(jour: string, nombre: number): string {
  return new Date(new Date(`${jour}T00:00:00.000Z`).getTime() + nombre * 86400000).toISOString().slice(0, 10);
}

// Convertit minuit du jour civil entreprise en instant pour les champs DateTime tels
// que createdAt. L'itération couvre les fuseaux à changement d'offset sans dépendre du
// fuseau de la machine qui exécute le serveur.
export function debutJourCivilEntreprise(jour: string, fuseauHoraire: string): Date {
  const [annee, mois, numeroJour] = jour.split('-').map(Number);
  const cible = Date.UTC(annee, mois - 1, numeroJour);
  let instant = new Date(cible);
  for (let i = 0; i < 2; i++) {
    const parties = new Intl.DateTimeFormat('en-CA', {
      timeZone: fuseauHoraire, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant);
    const valeur = (type: Intl.DateTimeFormatPartTypes) => Number(parties.find((partie) => partie.type === type)?.value);
    const lu = Date.UTC(valeur('year'), valeur('month') - 1, valeur('day'), valeur('hour'), valeur('minute'), valeur('second'));
    instant = new Date(instant.getTime() + cible - lu);
  }
  return instant;
}
