import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estNomBaseJetable } from '../scripts/base-jetable.mjs';

// #210 : « e2e » ou « test » doit former un mot du nom de la base, et non une simple partie d'un mot.
test('une base jetable porte « e2e » ou « test » comme mot de son nom', () => {
  for (const nom of ['iris_e2e', 'iris-test', 'e2e', 'test', 'e2e-iris', 'iris_releve_test', 'IRIS_E2E', 'iris_e2e_a220']) {
    assert.equal(estNomBaseJetable(nom), true, nom);
  }
  for (const nom of ['production_latest', 'latest', 'latest_prod', 'iris', 'iris_tests', 'contest', 'e2eiris', '']) {
    assert.equal(estNomBaseJetable(nom), false, nom);
  }
});

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'preparer-e2e.mjs');

// Le script est lancé pour de bon. Garde-fou : son port d'API est occupé par ce test, si bien qu'une
// règle de nom qui régresserait l'arrêterait encore avant toute action (Prisma, compilation, migration).
const preparer = async (url: string | undefined) => {
  const serveur = net.createServer();
  await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_API_PORT: String((serveur.address() as net.AddressInfo).port) };
    delete env.E2E_DATABASE_URL;
    if (url !== undefined) env.E2E_DATABASE_URL = url;
    return spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  } finally {
    await new Promise((resolve) => serveur.close(resolve));
  }
};

test('la préparation E2E refuse une base non jetable, une URL invalide ou absente, avant toute action', async () => {
  for (const [cas, url, refus] of [
    ['base production_latest', 'postgresql://iris:iris@localhost:5432/production_latest?schema=public', /La base « production_latest » ne porte ni « e2e » ni « test » comme mot de son nom/],
    ['base latest', 'postgresql://iris:iris@localhost:5432/latest', /La base « latest » ne porte ni « e2e » ni « test » comme mot de son nom/],
    ['URL invalide', 'pas une url', /n’est pas une URL PostgreSQL valide/],
    ['variable absente', undefined, /E2E_DATABASE_URL est requise/],
  ] as const) {
    const resultat = await preparer(url);
    assert.equal(resultat.status, 1, cas);
    assert.match(resultat.stderr, refus, cas);
    assert.doesNotMatch(resultat.stdout, /\[préparation E2E\] npx/, `${cas} : aucune commande lancée`);
  }
});
