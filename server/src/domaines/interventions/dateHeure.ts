import { FUSEAU_HORAIRE_PAR_DEFAUT, jourCivilEntreprise } from '../../commun/dates';

// Date et heure d'un instant lues au fuseau de la société, au format français (lot 6a-4a, PDF du
// compte rendu d'intervention). Outil commun nouveau du lot 6a-4, posé dans le domaine des
// interventions : les PDF suivants du lot le reprennent d'ici. Le jour vient de jourCivilEntreprise,
// l'heure du même instant dans le même fuseau, jamais de celui de la machine qui exécute le serveur.

// JJ-MM-AAAA
export function jourFrancaisEntreprise(instant: Date, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT): string {
  return jourCivilEntreprise(instant, fuseauHoraire).split('-').reverse().join('-');
}

// JJ-MM-AAAA HH:MM, l'heure de 00 à 23.
export function dateHeureFrancaiseEntreprise(instant: Date, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT): string {
  const parties = new Intl.DateTimeFormat('en-GB', {
    timeZone: fuseauHoraire, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const valeur = (type: Intl.DateTimeFormatPartTypes) => parties.find((partie) => partie.type === type)?.value;
  return `${jourFrancaisEntreprise(instant, fuseauHoraire)} ${valeur('hour')}:${valeur('minute')}`;
}
