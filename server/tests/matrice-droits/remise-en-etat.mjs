// Remise de la base à l'état de référence entre deux cas d'une matrice d'écritures réelles (lot D1a-5 ; avenant au
// cadrage du lot D1a pour D1a-5, version 2, section 1 : approche A3 de l'étude préalable).
//
// Ce fichier n'est pas un fichier de tests (pas de suffixe « .test.mjs ») : les fichiers matrice-droits-ecritures-*
// l'importent. Méthode :
//  - une fois le jeu de données construit, chaque table publique (celles de l'empreinte, outils.mjs) est copiée dans
//    un schéma d'instantané propre à la base jetable du fichier, et la valeur de chaque séquence est relevée ;
//  - après un cas qui écrit, les tables changées, que nomme l'empreinte de toute la base, sont vidées par DELETE puis
//    recopiées par INSERT … SELECT depuis l'instantané, et les séquences remises par setval, dans une seule
//    transaction, sous SET LOCAL session_replication_role = replica : les déclencheurs (gardes d'immutabilité des
//    pièces émises, journaux en ajout seul) et les clés étrangères n'y jouent pas, et ne sont coupés que dans cette
//    transaction ;
//  - après chaque remise, l'empreinte de toute la base, séquences comprises (last_value et is_called, note N4 de
//    #428), est comparée à la référence ; un écart fait échouer le cas en nommant le compte, la route, la cible et les
//    tables. Une sonde vérifie ensuite que le rôle de réplication n'est resté posé nulle part : la connexion de la
//    remise est revenue à « origin », et un déclencheur d'immutabilité refuse toujours, par cette connexion comme par
//    celle de l'application, de remettre en brouillon une facture émise (la modification est annulée dans tous les cas).
//
// Garde-fous (avenant, section 1) :
//  - une connexion pg dédiée, distincte de celles de l'application, jamais le client Prisma qu'elle emploie ;
//  - BEGIN, puis SET LOCAL session_replication_role = replica, dans la seule transaction de remise ;
//  - la sonde d'immutabilité ci-dessus, après chaque remise ;
//  - un refus de l'outil si current_database() n'est pas la base jetable créée par le fichier (nom donné par
//    baseJetable d'outils.mjs : « iris_test_matrice_<partie>_<suffixe> »).
// Aucune remise ne tourne pendant une requête : l'appelant attend la réponse de chaque cas, et, pour un cas joué par
// une clé d'intégration, la dernière utilisation de la clé, écrite sans attente par la porte /api/v1
// (attendreDernierUsage, plus bas), avant l'empreinte.
//
// Rôle PostgreSQL : session_replication_role est réservé au super-utilisateur, ou à un rôle qui a reçu
// GRANT SET ON PARAMETER session_replication_role (PostgreSQL 15 et plus). exigerRoleReplication éprouve cette
// capacité elle-même (SET LOCAL dans une transaction annulée), et non l'attribut rolsuper ; un fichier qui l'appelle
// échoue avec un message clair si elle manque, au lieu de s'ignorer (un SKIP serait confondu avec une réussite).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { requeteEmpreinte, tablesChangees } from './outils.mjs';

// Schéma de l'instantané, dans la base jetable du fichier (supprimé avec elle).
export const SCHEMA_INSTANTANE = 'etat_reference_matrice';
// Base jetable créée par baseJetable (outils.mjs) : « test » comme mot, partie et suffixe tiré au hasard.
const NOM_BASE_JETABLE = /^iris_test_matrice_[a-z0-9]+_[0-9a-f]{12}$/;
// Préfixe des clés de séquence dans l'empreinte (une table ne porte jamais d'espace dans son nom).
const PREFIXE_SEQUENCE = 'séquence ';
// Sonde d'immutabilité : remettre en brouillon une facture émise, refusé par le déclencheur
// interdire_modification_origine_facture_emise (migration 20261018120000_factures_emises_figees).
const REFUS_IMMUTABILITE = 'Une facture émise ne redevient jamais brouillon.';
const SONDE_SQL = 'UPDATE "Facture" SET "statut" = \'BROUILLON\' WHERE "id" = $1 AND "statut" <> \'BROUILLON\'';
const ANNULATION_SONDE = 'sonde annulée : aucune écriture conservée';
// Nombre de remises d'une table avant son VACUUM (voir `nettoyer`).
const SEUIL_VACUUM = 8;

export const MESSAGE_ROLE = 'Le rôle PostgreSQL de TEST_DATABASE_URL ne peut pas poser session_replication_role. Les matrices des écritures réelles (lot D1a-5) remettent la base à l’état de référence entre deux cas en recopiant les tables changées sous SET LOCAL session_replication_role = replica, pour que les gardes d’immutabilité des pièces émises et des journaux ne refusent pas la remise. Il faut un rôle super-utilisateur, comme en CI (.github/scripts/postgresql-runner.sh crée le rôle iris en SUPERUSER) et dans la base de test Docker de server/tests/README.md, ou, depuis PostgreSQL 15, un rôle qui a reçu GRANT SET ON PARAMETER session_replication_role. Ce fichier échoue au lieu de s’ignorer : un SKIP serait confondu avec une réussite.';

// Éprouve la capacité du rôle de `url` à poser session_replication_role, dans une transaction annulée.
export async function exigerRoleReplication(url) {
  const client = new pg.Client({ connectionString: url, application_name: 'iris-matrice-controle-role' });
  await client.connect();
  try {
    await client.query('BEGIN');
    let refus = null;
    try {
      await client.query('SET LOCAL session_replication_role = replica');
    } catch (erreur) {
      refus = erreur;
    } finally {
      await client.query('ROLLBACK');
    }
    if (refus) {
      const { rows: [{ role }] } = await client.query('SELECT current_user AS role');
      throw new Error(`${MESSAGE_ROLE}\nRôle : « ${role} ». PostgreSQL : « ${refus.message} ».`);
    }
  } finally {
    await client.end();
  }
}

const empreinteDe = (texte) => createHash('md5').update(texte).digest('hex');
const ident = (nom) => {
  assert.match(nom, /^[A-Za-z_][A-Za-z0-9_]*$/, `identifiant SQL inattendu : ${nom}`);
  return `"${nom}"`;
};

// Crée l'outil, une fois le jeu de données construit. `url` : la base jetable du fichier (base.url) ; `nomBase` : son
// nom (base.nom) ; `tables` : les tables de l'empreinte (tablesDeLaBase) ; `connexionApplication` : le client Prisma
// de l'application chargée (serveur.prisma), pour la sonde ; `factureEmiseId` : une facture émise du jeu de données.
export async function creerRemiseEnEtat({ url, nomBase, tables, connexionApplication, factureEmiseId }) {
  assert.match(String(nomBase), NOM_BASE_JETABLE, `remise en état refusée : « ${nomBase} » n’est pas le nom d’une base jetable de la matrice`);
  assert.ok(Array.isArray(tables) && tables.length > 0, 'remise en état : tables de l’empreinte absentes');
  assert.ok(connexionApplication && factureEmiseId, 'remise en état : connexion de l’application et facture émise de la sonde requises');
  const client = new pg.Client({ connectionString: url, application_name: 'iris-matrice-remise-en-etat' });
  await client.connect();
  try {
    const { rows: [{ base }] } = await client.query('SELECT current_database() AS base');
    if (base !== nomBase) {
      throw new Error(`Remise en état refusée : la connexion vise la base « ${base} », et non la base jetable « ${nomBase} » créée par ce fichier.`);
    }
    // Colonnes recopiées, dans leur ordre : toutes sauf les colonnes générées (aucune aujourd'hui), qui se recalculent.
    const colonnes = {};
    const { rows } = await client.query(`SELECT table_name, column_name, is_generated FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
    for (const table of tables) {
      const liste = rows.filter((r) => r.table_name === table && r.is_generated !== 'ALWAYS').map((r) => ident(r.column_name));
      assert.ok(liste.length, `table sans colonne : ${table}`);
      colonnes[table] = liste.join(', ');
    }
    const sequences = (await client.query(`SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`)).rows.map((r) => r.sequencename);
    // Séquences : last_value et is_called, lus dans la même requête que les tables (note N4 de #428).
    const colonnesSequences = sequences.map((sequence) => `(SELECT last_value::text || ':' || is_called::text FROM public.${ident(sequence)}) AS "${PREFIXE_SEQUENCE}${sequence}"`);
    const lireSequences = async () => (sequences.length ? (await client.query({ name: 'sequences-matrice', text: `SELECT ${colonnesSequences.join(', ')}` })).rows[0] : {});
    // Instantané des tables, puis des séquences, une seule fois.
    await client.query(`DROP SCHEMA IF EXISTS ${ident(SCHEMA_INSTANTANE)} CASCADE`);
    await client.query(`CREATE SCHEMA ${ident(SCHEMA_INSTANTANE)}`);
    for (const table of tables) await client.query(`CREATE TABLE ${ident(SCHEMA_INSTANTANE)}.${ident(table)} AS SELECT ${colonnes[table]} FROM public.${ident(table)}`);
    const sequencesReference = await lireSequences();
    // Requête préparée (nommée) : planifiée une fois, et non à chaque cas ; l'empreinte coûte alors environ 3 ms au
    // lieu de 7 ms sur le jeu de données de la matrice (mesure locale).
    const requete = [requeteEmpreinte(tables), ...colonnesSequences].join(', ');
    const empreinte = async () => ({ ...(await client.query({ name: 'empreinte-matrice', text: requete })).rows[0] });

    // Remise des tables nommées et de toutes les séquences, dans une seule transaction.
    const restaurer = async (aRemettre) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL session_replication_role = replica');
        for (const table of aRemettre) {
          await client.query(`DELETE FROM public.${ident(table)}`);
          await client.query(`INSERT INTO public.${ident(table)} (${colonnes[table]}) OVERRIDING SYSTEM VALUE SELECT ${colonnes[table]} FROM ${ident(SCHEMA_INSTANTANE)}.${ident(table)}`);
        }
        for (const sequence of sequences) {
          const [valeur, appelee] = sequencesReference[`${PREFIXE_SEQUENCE}${sequence}`].split(':');
          await client.query('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [`public.${ident(sequence)}`, valeur, appelee === 'true']);
        }
        await client.query('COMMIT');
      } catch (erreur) {
        await client.query('ROLLBACK').catch(() => {});
        throw erreur;
      }
    };

    // Sonde : la connexion de la remise est revenue à « origin », et le déclencheur d'immutabilité refuse la remise en
    // brouillon d'une facture émise, par cette connexion et par celle de l'application. Rien n'est jamais conservé.
    const sondeImmutabilite = async (contexte) => {
      const { rows: [{ session_replication_role: roleSession }] } = await client.query('SHOW session_replication_role');
      assert.equal(roleSession, 'origin', `${contexte} : session_replication_role est resté « ${roleSession} » sur la connexion de la remise après sa transaction (il ne doit être posé que par SET LOCAL)`);
      await client.query('BEGIN');
      let refusRemise = null; let lignesTouchees = null;
      try {
        lignesTouchees = (await client.query({ name: 'sonde-immutabilite', text: SONDE_SQL, values: [factureEmiseId] })).rowCount;
      } catch (erreur) {
        refusRemise = erreur;
      } finally {
        await client.query('ROLLBACK');
      }
      assert.ok(refusRemise?.message?.includes(REFUS_IMMUTABILITE), `${contexte} : par la connexion de la remise, une facture émise a pu être remise en brouillon (${refusRemise ? refusRemise.message : `${lignesTouchees} ligne(s) touchée(s), aucun refus`}) : un déclencheur d’immutabilité est coupé`);
      let refusApplication = null;
      try {
        await connexionApplication.$transaction(async (tx) => {
          const touchees = await tx.$executeRawUnsafe(SONDE_SQL, factureEmiseId);
          throw new Error(`${ANNULATION_SONDE} (${touchees} ligne(s) touchée(s))`);
        });
      } catch (erreur) {
        refusApplication = erreur;
      }
      assert.ok(String(refusApplication?.message ?? '').includes(REFUS_IMMUTABILITE), `${contexte} : par la connexion de l’application, une facture émise a pu être remise en brouillon (${refusApplication?.message ?? 'aucun refus'}) : un déclencheur d’immutabilité est coupé`);
    };

    // Première remise complète : toutes les tables recopiées depuis l'instantané (chacune est donc restaurable), puis
    // empreinte de référence. L'empreinte d'avant et celle d'après sont identiques : le contenu ne change pas.
    const avantPremiere = await empreinte();
    await restaurer(tables);
    const reference = await empreinte();
    assert.deepEqual(tablesChangees(avantPremiere, reference), [], 'la première remise complète change le contenu de la base');
    await sondeImmutabilite('après la première remise complète');

    // Chaque remise vide puis recopie ses tables : leurs anciennes lignes restent en place jusqu'au passage du VACUUM,
    // et l'empreinte, qui les relit toutes, ralentit au fil du fichier (de 3 à plus de 7 ms par empreinte, mesure
    // locale). Une table remise SEUIL_VACUUM fois est donc nettoyée par VACUUM, hors transaction, après la remise :
    // le contenu ne change pas, et la vérification qui suit le prouve.
    const remisesDepuisVacuum = new Map();
    const nettoyer = async (remisesTables) => {
      for (const table of remisesTables) {
        const n = (remisesDepuisVacuum.get(table) ?? 0) + 1;
        if (n < SEUIL_VACUUM) { remisesDepuisVacuum.set(table, n); continue; }
        remisesDepuisVacuum.set(table, 0);
        await client.query(`VACUUM public.${ident(table)}`);
      }
    };

    let remises = 0;
    const outil = {
      reference,
      sequences,
      get remises() { return remises; },
      empreinte,
      // Tables (et séquences) dont l'empreinte diffère de la référence.
      changees: (apres) => tablesChangees(reference, apres),
      // Remet les tables nommées (et toutes les séquences), puis vérifie : empreinte de toute la base égale à la
      // référence, séquences comprises, et sonde d'immutabilité. `contexte` nomme le cas (compte, route, cible).
      async remettre(changees, contexte) {
        const inconnues = changees.filter((nom) => !tables.includes(nom) && !nom.startsWith(PREFIXE_SEQUENCE));
        assert.deepEqual(inconnues, [], `${contexte} : écriture hors des tables de l’empreinte`);
        const remisesTables = changees.filter((nom) => tables.includes(nom));
        await restaurer(remisesTables);
        remises += 1;
        await nettoyer(remisesTables);
        const apres = await empreinte();
        const ecarts = tablesChangees(reference, apres);
        assert.deepEqual(ecarts, [], `Remise en état incomplète après ${contexte} : tables changées par le cas ${changees.join(', ')} ; toujours différentes de la référence après la remise : ${ecarts.join(', ')}`);
        await sondeImmutabilite(`après la remise de ${contexte}`);
      },
      sondeImmutabilite,
      // État complet, pour la preuve de l'outil : empreinte des tables et des séquences, déclencheurs et leur état
      // d'activation (pg_trigger.tgenabled, déclencheurs internes des clés étrangères compris), schéma public relu dans
      // le catalogue (relations, colonnes, contraintes, index, déclencheurs, fonctions, types, règles).
      async etatComplet() {
        const declencheurs = (await client.query(`SELECT c.relname || '.' || t.tgname || '=' || t.tgenabled::text AS d FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY 1`)).rows.map((r) => r.d);
        const schema = (await client.query(`SELECT ligne FROM (
          SELECT 'relation ' || c.relname || ' ' || c.relkind::text AS ligne FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
          UNION ALL SELECT 'colonne ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' non nulle' ELSE '' END
              || coalesce(' défaut ' || pg_get_expr(d.adbin, d.adrelid), '') || ' identité=' || a.attidentity::text || ' générée=' || a.attgenerated::text
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
          UNION ALL SELECT 'contrainte ' || c.relname || '.' || co.conname || ' ' || pg_get_constraintdef(co.oid) || ' différable=' || co.condeferrable::text || ' différée=' || co.condeferred::text
            FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
          UNION ALL SELECT 'index ' || pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
          UNION ALL SELECT 'déclencheur ' || pg_get_triggerdef(t.oid) || ' état=' || t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
          UNION ALL SELECT 'fonction ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
          UNION ALL SELECT 'type ' || t.typname || ' ' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '') FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c') AND t.typrelid = 0
          UNION ALL SELECT 'règle ' || r.tablename || '.' || r.rulename || ' ' || r.definition FROM pg_rules r WHERE r.schemaname = 'public'
          UNION ALL SELECT 'séquence ' || s.sequencename || ' ' || s.data_type::text || ' ' || s.start_value::text || ' ' || s.increment_by::text || ' ' || s.cycle::text FROM pg_sequences s WHERE s.schemaname = 'public'
        ) s ORDER BY ligne`)).rows.map((r) => r.ligne);
        return {
          empreinte: await empreinte(),
          declencheurs: empreinteDe(declencheurs.join('\n')),
          nombreDeclencheurs: declencheurs.length,
          declencheursInactifs: declencheurs.filter((d) => !d.endsWith('=O')),
          schema: empreinteDe(schema.join('\n')),
          lignesSchema: schema.length,
        };
      },
      // Attente bornée de la dernière utilisation d'une clé, écrite sans attente par la porte /api/v1
      // (http/cles-api.ts) : la base doit porter un instant postérieur à l'envoi de l'appel, avant l'empreinte (même
      // méthode que matrice-droits-cles.test.mjs).
      async attendreDernierUsage(cleId, envoi, contexte, delaiMs = 10_000) {
        const debut = Date.now();
        for (;;) {
          const { rows: [ligne] } = await client.query('SELECT (extract(epoch FROM "dernierUsageLe") * 1000)::bigint::text AS instant FROM "ApiAccessKey" WHERE "id" = $1', [cleId]);
          const instant = ligne?.instant === null || ligne?.instant === undefined ? null : Number(ligne.instant);
          if (instant !== null && instant >= envoi) return instant;
          if (Date.now() - debut > delaiMs) assert.fail(`${contexte} : la dernière utilisation de la clé n’est pas notée en base en ${delaiMs / 1000} s`);
          await new Promise((ok) => setTimeout(ok, 10));
        }
      },
      async fermer() {
        await client.end().catch(() => {});
      },
    };
    return outil;
  } catch (erreur) {
    await client.end().catch(() => {});
    throw erreur;
  }
}
