import { FUSEAU_HORAIRE_PAR_DEFAUT, jourCivilDeReference, ajouterJoursCivils, debutJourCivilEntreprise } from '../../commun/dates';

// Bornes lundi 00:00 -> samedi 00:00 (exclusif) de la semaine civile contenant `weekParam`.
// Les bornes sont des instants car elles filtrent createdAt ; les jours retournés restent
// explicites pour éviter toute relecture UTC dans la réponse HTTP.
export function weekBoundsFrom(weekParam: unknown, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT, instant = new Date()): { monday: Date; friday: Date; saturdayExclusive: Date; mondayCivil: string; fridayCivil: string } {
  const refCivil = jourCivilDeReference(weekParam, fuseauHoraire, instant);
  const day = new Date(`${refCivil}T00:00:00.000Z`).getUTCDay(); // jour d'une date-seule
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const mondayCivil = ajouterJoursCivils(refCivil, diffToMonday);
  const fridayCivil = ajouterJoursCivils(mondayCivil, 4);
  return {
    monday: debutJourCivilEntreprise(mondayCivil, fuseauHoraire),
    friday: debutJourCivilEntreprise(fridayCivil, fuseauHoraire),
    saturdayExclusive: debutJourCivilEntreprise(ajouterJoursCivils(mondayCivil, 5), fuseauHoraire),
    mondayCivil,
    fridayCivil,
  };
}

// Bornes [début, fin exclue[ d'une période "semaine civile complète" (lundi->lundi
// suivant, 7 jours), « mois civil », « trimestre civil » (janv-mars, avr-juin, juil-sept,
// oct-déc) ou « année civile » contenant `refParam`. Les données métier filtrées sont des
// dates-seules : leurs bornes restent à minuit UTC, mais le jour de référence issu d'un
// instant est obligatoirement lu dans le fuseau de l'entreprise.
export function periodBounds(period: 'week' | 'month' | 'quarter' | 'year', refParam: unknown, fuseauHoraire = FUSEAU_HORAIRE_PAR_DEFAUT, instant = new Date()): { start: Date; endExclusive: Date } {
  const refCivil = jourCivilDeReference(refParam, fuseauHoraire, instant);
  const [annee, mois, jour] = refCivil.split('-').map(Number);
  if (period === 'year') {
    return {
      start: new Date(Date.UTC(annee, 0, 1)),
      endExclusive: new Date(Date.UTC(annee + 1, 0, 1)),
    };
  }
  if (period === 'quarter') {
    const quarterStartMonth = Math.floor((mois - 1) / 3) * 3;
    return {
      start: new Date(Date.UTC(annee, quarterStartMonth, 1)),
      endExclusive: new Date(Date.UTC(annee, quarterStartMonth + 3, 1)),
    };
  }
  if (period === 'month') {
    return {
      start: new Date(Date.UTC(annee, mois - 1, 1)),
      endExclusive: new Date(Date.UTC(annee, mois, 1)),
    };
  }
  const day = new Date(Date.UTC(annee, mois - 1, jour)).getUTCDay(); // date-seule
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(Date.UTC(annee, mois - 1, jour + diffToMonday));
  return { start, endExclusive: new Date(start.getTime() + 7 * 86400000) };
}
