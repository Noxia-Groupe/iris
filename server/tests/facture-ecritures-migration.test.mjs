// Base PostgreSQL locale éphémère : les migrations de main précèdent celle de la PR.
// TEST_DATABASE_URL est uniquement une connexion administrative, jamais la cible migrée.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

const prismaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma');
const derniereMain = '20260925120000_journal_activation_comptes';
const migrationPR = '20261007140000_facture_ecritures_figees';
const adminUrl = process.env.TEST_DATABASE_URL;

test('migration imputation : refuse une pièce déjà numérotée sans la reconstruire depuis les règles actuelles', { skip: !adminUrl && 'TEST_DATABASE_URL requis' }, async () => {
  const base = `iris_imputation_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'seul PostgreSQL local est autorisé');
  assert.notEqual(url.pathname.slice(1), base);
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  url.pathname = `/${base}`;
  const admin = new pg.Client({ connectionString: maintenance.toString() });
  const dossier = mkdtempSync(join(tmpdir(), 'iris-imputation-migration-'));
  const schema = join(dossier, 'schema.prisma');
  const migrations = join(dossier, 'migrations');
  let baseCreee = false;
  let db;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${base}"`);
    baseCreee = true;
    copyFileSync(join(prismaDir, 'schema.prisma'), schema);
    mkdirSync(migrations);
    copyFileSync(join(prismaDir, 'migrations/migration_lock.toml'), join(migrations, 'migration_lock.toml'));
    const main = readdirSync(join(prismaDir, 'migrations')).filter(nom => nom <= derniereMain && nom !== 'migration_lock.toml');
    assert.ok(main.includes(derniereMain), 'migration finale main absente');
    for (const nom of main) cpSync(join(prismaDir, 'migrations', nom), join(migrations, nom), { recursive: true });
    const prisma = resolve(prismaDir, '../node_modules/.bin/prisma');
    const deployer = () => execFileSync(prisma, ['migrate', 'deploy', '--schema', schema], {
      env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    });
    deployer();
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    const client = randomUUID();
    const facture = randomUUID();
    await db.query('INSERT INTO "Client" (id, "raisonSociale", "updatedAt") VALUES ($1, $2, now())', [client, 'TEST migration imputations']);
    await db.query('INSERT INTO "Facture" (id, numero, annee, "clientId", "clientRaisonSociale", statut, "dateEmission", "dateEcheance", "totalHt", "totalTva", "totalTtc", origine, "motifHorsAffaire", "updatedAt") VALUES ($1, $2, 2026, $3, $4, $5, now(), now(), 10, 2, 12, $6, $7, now())',
      [facture, 'TEST-HISTORIQUE-001', client, 'TEST migration imputations', 'EMISE', 'HORS_AFFAIRE', 'TEST pièce artificielle sur base jetable']);
    cpSync(join(prismaDir, 'migrations', migrationPR), join(migrations, migrationPR), { recursive: true });
    assert.throws(deployer, erreur => {
      const sortie = `${erreur.stdout || ''}\n${erreur.stderr || ''}`;
      assert.match(sortie, /P3018/);
      assert.match(sortie, /Pièces historiques présentes : reprise comptable validée requise avant migration/);
      return true;
    });
    assert.deepEqual((await db.query('SELECT numero, statut FROM "Facture" WHERE id = $1', [facture])).rows,
      [{ numero: 'TEST-HISTORIQUE-001', statut: 'EMISE' }]);
    assert.equal((await db.query('SELECT count(*)::int AS total FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL', [migrationPR])).rows[0].total, 0);
  } finally {
    if (db) await db.end();
    if (baseCreee) await admin.query(`DROP DATABASE "${base}" WITH (FORCE)`);
    await admin.end().catch(() => {});
    rmSync(dossier, { recursive: true, force: true });
  }
});
