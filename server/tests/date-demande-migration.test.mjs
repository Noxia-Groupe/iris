// Exécute la migration depuis le schéma précédent sur une base jetable distincte.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_URL;
const prismaDir = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma');
const migration = '20261007130000_intervention_date_demande';

test('migration date demande : historique nullable préservé, nouveaux rattachements contrôlés', { skip: !adminUrl && 'TEST_DATABASE_URL requis' }, async () => {
  const url = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'seul PostgreSQL local est autorisé');
  const base = `iris_date_historique_${randomUUID().replaceAll('-', '')}`;
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  url.pathname = `/${base}`;
  const admin = new pg.Client({ connectionString: maintenance.toString() });
  const dir = mkdtempSync(join(tmpdir(), 'iris-date-demande-'));
  const schema = join(dir, 'schema.prisma');
  const migrations = join(dir, 'migrations');
  let created = false;
  let db;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${base}"`);
    created = true;
    copyFileSync(join(prismaDir, 'schema.prisma'), schema);
    mkdirSync(migrations);
    copyFileSync(join(prismaDir, 'migrations/migration_lock.toml'), join(migrations, 'migration_lock.toml'));
    for (const name of readdirSync(join(prismaDir, 'migrations')).filter((name) => name < migration && name !== 'migration_lock.toml')) {
      cpSync(join(prismaDir, 'migrations', name), join(migrations, name), { recursive: true });
    }
    const deploy = () => execFileSync(resolve(prismaDir, '../node_modules/.bin/prisma'), ['migrate', 'deploy', '--schema', schema], {
      env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    });
    deploy();
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    const client = randomUUID();
    const contrat = randomUUID();
    const curative = randomUUID();
    const contractuelle = randomUUID();
    const autreClient = randomUUID();
    const historiqueIncoherent = randomUUID();
    await db.query('INSERT INTO "Client" (id, "raisonSociale", "updatedAt") VALUES ($1, $2, now())', [client, 'TEST date historique']);
    await db.query('INSERT INTO "ContratMaintenance" (id, "clientId", titre, "periodiciteMois", "dureePrevisionnelleMinutes", "dateDebut", "prochaineEcheance", "updatedAt") VALUES ($1, $2, $3, 12, 60, $4, $4, now())', [contrat, client, 'TEST contrat historique', '2025-01-01']);
    await db.query('INSERT INTO "Intervention" (id, reference, "clientId", titre, "updatedAt") VALUES ($1, $2, $3, $4, now())', [curative, `TEST-${curative}`, client, 'Historique libre']);
    await db.query('INSERT INTO "Intervention" (id, reference, "clientId", titre, "contratMaintenanceId", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())', [contractuelle, `TEST-${contractuelle}`, client, 'Historique contractuel', contrat]);
    await db.query('INSERT INTO "Client" (id, "raisonSociale", "updatedAt") VALUES ($1, $2, now())', [autreClient, 'TEST autre client']);
    // La migration ne répare pas implicitement les données historiques incohérentes.
    await db.query('INSERT INTO "Intervention" (id, reference, "clientId", titre, "contratMaintenanceId", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())', [historiqueIncoherent, `TEST-${historiqueIncoherent}`, autreClient, 'Historique incohérent', contrat]);
    cpSync(join(prismaDir, 'migrations', migration), join(migrations, migration), { recursive: true });
    deploy();
    const rows = await db.query('SELECT id, "dateDemande" FROM "Intervention" WHERE id = ANY($1::text[]) ORDER BY id', [[curative, contractuelle]]);
    assert.equal(rows.rowCount, 2);
    assert.ok(rows.rows.every(({ dateDemande }) => dateDemande === null), 'aucune date de réception inventée');
    await db.query('UPDATE "Intervention" SET statut = $1 WHERE id = $2', ['PLANIFIEE', contractuelle]);
    await db.query('UPDATE "Intervention" SET statut = $1 WHERE id = $2', ['PLANIFIEE', historiqueIncoherent]);
    assert.equal((await db.query('SELECT "clientId" FROM "Intervention" WHERE id = $1', [historiqueIncoherent])).rows[0].clientId, autreClient);
    // Un dossier contractuel historique NULL peut également recevoir une date,
    // à condition de respecter le début du contrat, mais pas être réécrit.
    await assert.rejects(db.query('UPDATE "Intervention" SET "dateDemande" = $1 WHERE id = $2', ['2024-12-31', contractuelle]), { code: '23514' });
    await db.query('UPDATE "Intervention" SET "dateDemande" = $1 WHERE id = $2', ['2025-01-01', contractuelle]);
    await assert.rejects(db.query('UPDATE "Intervention" SET "dateDemande" = $1 WHERE id = $2', ['2025-01-02', contractuelle]), { code: '23514' });
    const insertion = 'INSERT INTO "Intervention" (id, reference, "clientId", titre, "contratMaintenanceId", "dateDemande", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, now())';
    const nouvelle = randomUUID();
    await db.query(insertion, [nouvelle, `TEST-${nouvelle}`, client, 'Même client', contrat, '2025-01-01']);
    assert.equal((await db.query('SELECT "clientId" FROM "Intervention" WHERE id = $1', [nouvelle])).rows[0].clientId, client);
    const etrangere = randomUUID();
    await assert.rejects(db.query(insertion, [etrangere, `TEST-${etrangere}`, autreClient, 'Autre client', contrat, '2025-01-01']), { code: '23514' });
    await assert.rejects(db.query('UPDATE "Intervention" SET "clientId" = $1 WHERE id = $2', [autreClient, nouvelle]), { code: '23514' });
    await assert.rejects(db.query('UPDATE "Intervention" SET "clientId" = $1 WHERE id = $2', [client, historiqueIncoherent]), { code: '23514' });
    // Une date historique NULL peut être renseignée une seule fois, sans réécriture ultérieure.
    await db.query('UPDATE "Intervention" SET "dateDemande" = $1 WHERE id = $2', ['2025-01-01', curative]);
    await db.query('UPDATE "Intervention" SET "dateDemande" = $1 WHERE id = $2', ['2025-01-01', curative]);
    await assert.rejects(db.query('UPDATE "Intervention" SET "dateDemande" = $1 WHERE id = $2', ['2025-02-01', curative]), { code: '23514' });
    await assert.rejects(db.query('UPDATE "Intervention" SET "dateDemande" = NULL WHERE id = $1', [curative]), { code: '23514' });
    assert.equal((await db.query('SELECT "dateDemande"::text AS jour FROM "Intervention" WHERE id = $1', [curative])).rows[0].jour, '2025-01-01');
    await db.query('UPDATE "Intervention" SET "contratMaintenanceId" = $1 WHERE id = $2', [contrat, curative]);
    const avantEffet = randomUUID();
    await db.query('INSERT INTO "Intervention" (id, reference, "clientId", titre, "dateDemande", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())', [avantEffet, `TEST-${avantEffet}`, client, 'Libre avant effet', '2024-12-31']);
    await assert.rejects(db.query('UPDATE "Intervention" SET "dateDemande" = $1 WHERE id = $2', ['2025-01-01', avantEffet]), { code: '23514' });
    assert.equal((await db.query('SELECT "dateDemande"::text AS jour FROM "Intervention" WHERE id = $1', [avantEffet])).rows[0].jour, '2024-12-31');
    await assert.rejects(db.query('UPDATE "Intervention" SET "contratMaintenanceId" = $1 WHERE id = $2', [contrat, avantEffet]), { code: '23514' });
    assert.equal((await db.query('SELECT "contratMaintenanceId", "dateDemande"::text AS jour FROM "Intervention" WHERE id = $1', [avantEffet])).rows[0].contratMaintenanceId, null);
    const libreEtranger = randomUUID();
    await db.query('INSERT INTO "Intervention" (id, reference, "clientId", titre, "dateDemande", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())', [libreEtranger, `TEST-${libreEtranger}`, autreClient, 'Libre étranger', '2025-01-01']);
    await assert.rejects(db.query('UPDATE "Intervention" SET "contratMaintenanceId" = $1 WHERE id = $2', [contrat, libreEtranger]), { code: '23514' });
    await assert.rejects(db.query('UPDATE "ContratMaintenance" SET "clientId" = $1 WHERE id = $2', [autreClient, contrat]), { code: '23514' });
    await assert.rejects(db.query('INSERT INTO "Intervention" (id, reference, "clientId", titre, "contratMaintenanceId", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())', [randomUUID(), `TEST-${randomUUID()}`, client, 'Nouveau sans date', contrat]), { code: '23514' });
  } finally {
    if (db) await db.end();
    if (created) await admin.query(`DROP DATABASE "${base}" WITH (FORCE)`);
    await admin.end().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
