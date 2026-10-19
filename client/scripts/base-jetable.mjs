// Règle commune aux outils qui écrivent dans une base PostgreSQL (préparation des parcours E2E,
// outil de comparaison du rendu) : la base doit se dire jetable par son nom (#210).
//   - « e2e » ou « test » y forme un mot, en bord de nom ou séparé par « _ » ou « - » ;
//   - le nom ne s'écrit qu'en lettres, chiffres, « _ » et « - » : un chemin à deux segments
//     (`production/iris_e2e`), dont seul le premier désignerait la base, est refusé.
// `iris_e2e`, `iris-test` et `iris_releve_test` passent ; `production_latest`, `latest_prod`,
// `iris_tests`, `iris_test2` et `iris.test` sont refusés, toujours dans le sens sûr.
export const REGLE_BASE_JETABLE = '« e2e » ou « test » comme mot de son nom, écrit en lettres, chiffres, « _ » ou « - »';
export const estNomBaseJetable = (nom) => /^[A-Za-z0-9_-]+$/.test(nom) && /(^|[_-])(e2e|test)([_-]|$)/i.test(nom);
