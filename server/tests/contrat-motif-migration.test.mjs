// Rejoue les migrations de main, puis celle de la PR, sur une base dédiée créée et supprimée ici.
// Ne jamais migrer directement TEST_DATABASE_URL : elle ne sert que de connexion administrative.
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
const mainDerniereMigration = '20260925120000_journal_activation_comptes';
const migrationPR = '20261007120000_contrat_journal_motif_obligatoire';
const adminUrl = process.env.TEST_DATABASE_URL;

// La connexion administrative utilise la même instance mais jamais la base de la suite API.
// Pas de repli vers DATABASE_URL (potentiellement durable).
test('migration motif : historique conservé, nouvelles écritures contrôlées', { skip: !adminUrl && 'TEST_DATABASE_URL requis' }, async () => {
  const base = `iris_motif_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl);
  const host = url.hostname;
  assert.ok(['127.0.0.1', 'localhost'].includes(host), 'seul PostgreSQL local est autorisé');
  assert.notEqual(url.pathname.slice(1), base);
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  url.pathname = `/${base}`;
  const admin = new pg.Client({ connectionString: maintenanceUrl.toString() });
  const dossier = mkdtempSync(join(tmpdir(), 'iris-motif-migration-'));
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
    const repertoiresMain = readdirSync(join(prismaDir, 'migrations'))
      .filter((nom) => nom <= mainDerniereMigration && nom !== 'migration_lock.toml');
    assert.ok(repertoiresMain.includes(mainDerniereMigration), 'migration finale main absente');
    for (const nom of repertoiresMain) {
      cpSync(join(prismaDir, 'migrations', nom), join(migrations, nom), { recursive: true });
    }
    const prisma = resolve(prismaDir, '../node_modules/.bin/prisma');
    const deployer = () => execFileSync(prisma, ['migrate', 'deploy', '--schema', schema], {
      env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    });
    deployer();
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    const auteur = randomUUID();
    const client = randomUUID();
    const contrat = randomUUID();
    await db.query('INSERT INTO "User" (id, email, name, "updatedAt") VALUES ($1, $2, $3, now())', [auteur, `${auteur}@iris.test`, 'Test historique']);
    await db.query('INSERT INTO "Client" (id, "raisonSociale", "updatedAt") VALUES ($1, $2, now())', [client, 'TEST migration motif']);
    await db.query('INSERT INTO "ContratMaintenance" (id, "clientId", titre, "periodiciteMois", "dureePrevisionnelleMinutes", "dateDebut", "prochaineEcheance", "updatedAt") VALUES ($1, $2, $3, 12, 60, now(), now(), now())', [contrat, client, 'Test migration motif']);
    const insertion = 'INSERT INTO "JournalSaisieChantier" (id, "contratMaintenanceId", cible, "cibleId", action, "auteurId", "auteurNom", motif) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
    const ajouter = (cible, action, motif) => db.query(insertion, [randomUUID(), contrat, cible, contrat, action, auteur, 'Test historique', motif]);
    const ancien = randomUUID();
    await db.query(insertion, [ancien, contrat, 'CONTRAT', contrat, 'REACTIVATION', auteur, 'Test historique', null]);
    cpSync(join(prismaDir, 'migrations', migrationPR), join(migrations, migrationPR), { recursive: true });
    deployer(); // RED : l'ancien CHECK valide l'historique et échoue ici.
    assert.deepEqual((await db.query('SELECT motif FROM "JournalSaisieChantier" WHERE id = $1', [ancien])).rows, [{ motif: null }]);
    const contrainte = await db.query('SELECT convalidated FROM pg_constraint WHERE conname = $1', ['JournalSaisieChantier_contrat_motif_check']);
    assert.deepEqual(contrainte.rows, [{ convalidated: false }]);
    for (const action of ['REACTIVATION', 'SUSPENSION', 'CLOTURE', 'AVANCEMENT_ECHEANCE', 'MODIFICATION_COUVERTURE']) {
      await assert.rejects(ajouter('CONTRAT', action, null), { code: '23514' }, `${action} sans motif refusée`);
      await assert.rejects(ajouter('CONTRAT', action, '   '), { code: '23514' }, `${action} avec motif blanc refusée`);
    }
    await ajouter('CONTRAT', 'CREATION', null);
    const intervention = randomUUID();
    await db.query('INSERT INTO "Intervention" (id, reference, "clientId", titre, "updatedAt") VALUES ($1, $2, $3, $4, now())', [intervention, `TEST-${intervention}`, client, 'Autre cible']);
    await db.query('INSERT INTO "JournalSaisieChantier" (id, "interventionId", cible, "cibleId", action, "auteurId", "auteurNom", motif) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)', [randomUUID(), intervention, 'INTERVENTION', intervention, 'CHANGEMENT_STATUT', auteur, 'Test historique']);
    assert.equal((await db.query('SELECT count(*)::int AS total FROM "JournalSaisieChantier"')).rows[0].total, 3);
  } finally {
    if (db) await db.end();
    if (baseCreee) await admin.query(`DROP DATABASE "${base}" WITH (FORCE)`);
    await admin.end().catch(() => {});
    rmSync(dossier, { recursive: true, force: true });
  }
});
