// Règle commune aux outils qui écrivent dans une base PostgreSQL (préparation des parcours E2E,
// outil de comparaison du rendu) : la base doit se dire jetable par son nom, où « e2e » ou « test »
// forme un mot, en bord de nom ou séparé par « _ » ou « - ». `iris_e2e`, `iris-test` et
// `iris_releve_test` passent ; `production_latest` ou `latest_prod`, où « test » n'est qu'une partie
// d'un mot, sont refusés (#210).
export const estNomBaseJetable = (nom) => /(^|[_-])(e2e|test)([_-]|$)/i.test(nom);
