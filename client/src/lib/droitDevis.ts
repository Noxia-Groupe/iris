// Case « Droit devis » d'Administration > Utilisateurs.
// Le droit d'établir un devis comprend le référentiel minimal nécessaire pour choisir le client.
export const DROITS_DEVIS = ['devis:read', 'devis:write', 'clients:read'];
const DROITS_PROPRES_AU_DEVIS = ['devis:read', 'devis:write'];

/**
 * État de la case pour un compte : cochée si les trois droits sont effectifs. Elle ne se décoche
 * pas (« accordé par le type de compte ») quand un droit devis effectif ne vient pas des droits
 * individuels : le retirer d'ici ne changerait rien. `clients:read` n'entre pas dans ce test, car
 * certains types de compte le portent sans le devis (technicien, conducteur depuis #143).
 */
export function etatDroitDevis(effectifs: string[], individuels: string[]): { coche: boolean; vientDuRole: boolean } {
  const coche = DROITS_DEVIS.every((droit) => effectifs.includes(droit));
  const vientDuRole = coche && DROITS_PROPRES_AU_DEVIS.some((droit) => !individuels.includes(droit));
  return { coche, vientDuRole };
}

/** Droits individuels après un clic sur la case : décocher retire les droits devis individuels
 * présents (le type de compte peut garder `clients:read`), cocher accorde les trois. */
export function droitsApresBasculeDevis(individuels: string[], coche: boolean): string[] {
  return coche
    ? individuels.filter((droit) => !DROITS_DEVIS.includes(droit))
    : [...new Set([...individuels, ...DROITS_DEVIS])];
}
