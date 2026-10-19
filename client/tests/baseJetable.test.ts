import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estNomBaseJetable } from '../scripts/base-jetable.mjs';

// #210 : « e2e » ou « test » doit former un mot du nom de la base, écrit en lettres, chiffres, « _ »
// ou « - », et non une simple partie d'un mot.
test('une base jetable porte « e2e » ou « test » comme mot de son nom', () => {
  for (const nom of ['iris_e2e', 'iris-test', 'e2e', 'test', 'e2e-iris', 'iris_releve_test', 'IRIS_E2E', 'iris_e2e_a220', 'iris_e2e_2', 'test_iris']) {
    assert.equal(estNomBaseJetable(nom), true, nom);
  }
  for (const nom of ['production_latest', 'latest', 'latest_prod', 'iris', 'iris_tests', 'iris_test2', 'contest', 'e2eiris', 'iris.test', 'e2e.iris', 'production/iris_e2e', '"iris_e2e"', '']) {
    assert.equal(estNomBaseJetable(nom), false, nom);
  }
});

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
// Les scripts sont lancés pour de bon. Trois garde-fous, indépendants de la règle testée, empêchent
// toute action si elle régressait : leur port d'API est occupé par ce test, aucun exécutable n'est
// trouvable par leur PATH (node est lancé par son chemin absolu), et la base visée est injoignable.
const sansExecutable = path.join(os.tmpdir(), 'iris-aucun-executable-inexistant');
const url = (nom: string) => `postgresql://iris:iris@127.0.0.1:1/${nom}?schema=public&connect_timeout=5`;
const refusNom = (nom: string) => new RegExp(`La base « ${nom.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} » n’est pas une base jetable \\(« e2e » ou « test » comme mot de son nom`);

const preparer = async (adresse: string | undefined) => {
  const serveur = net.createServer();
  await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  const port = (serveur.address() as net.AddressInfo).port;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: sansExecutable, E2E_API_PORT: String(port) };
    delete env.E2E_DATABASE_URL;
    delete env.E2E_BASE_URL;
    if (adresse !== undefined) env.E2E_DATABASE_URL = adresse;
    return { port, ...spawnSync(process.execPath, [path.join(scripts, 'preparer-e2e.mjs')], { env, encoding: 'utf8', timeout: 30_000 }) };
  } finally {
    await new Promise((resolve) => serveur.close(resolve));
  }
};

test('la préparation E2E refuse une base non jetable, une URL invalide ou absente, avant toute action', async () => {
  for (const [cas, adresse, refus] of [
    ['base production_latest', url('production_latest'), refusNom('production_latest')],
    ['base latest', url('latest'), refusNom('latest')],
    ['chemin à deux segments', url('production/iris_e2e'), refusNom('production/iris_e2e')],
    ['URL invalide', 'pas une url', /n’est pas une URL PostgreSQL valide/],
    ['variable absente', undefined, /E2E_DATABASE_URL est requise/],
  ] as const) {
    const resultat = await preparer(adresse);
    assert.equal(resultat.status, 1, cas);
    assert.match(resultat.stderr, refus, cas);
    assert.doesNotMatch(resultat.stdout, /\[préparation E2E\] npx/, `${cas} : aucune commande lancée`);
  }
});

test('la préparation E2E admet une base jetable, puis s’arrête sur le port occupé', async () => {
  const resultat = await preparer(url('iris_e2e'));
  assert.equal(resultat.status, 1);
  assert.match(resultat.stderr, new RegExp(`Un serveur écoute déjà sur le port ${resultat.port} \\(API\\)`));
  assert.doesNotMatch(resultat.stdout, /\[préparation E2E\] npx/);
});

test('l’outil de comparaison du rendu applique la même règle', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: sansExecutable, RELEVE_DATABASE_URL: url('production_latest') };
  // --reference inexistant : si la règle régressait, le contrôle suivant refuserait encore, avant tout.
  const resultat = spawnSync(process.execPath, [path.join(scripts, 'comparer-rendu', 'index.mjs'), '--reference', sansExecutable], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, refusNom('production_latest'));
});
