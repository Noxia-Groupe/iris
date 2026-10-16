#!/usr/bin/env bash
# Démarre le PostgreSQL préinstallé d'un runner GitHub Ubuntu 24.04 et crée la base de la CI.
# Usage : postgresql-runner.sh <base>
# Rôle `iris` (mot de passe `iris_test`, superutilisateur comme le POSTGRES_USER de l'image
# officielle), base en UTF-8 et C.UTF-8. Échoue si le serveur n'est pas en version 16, si son
# fuseau n'est pas UTC, ou si la base ou template1 ne sont pas en UTF-8 et C.UTF-8.
set -euo pipefail
base="${1:?nom de la base attendu}"

sudo systemctl start postgresql.service
for essai in $(seq 1 30); do
  if pg_isready -h localhost -p 5432 -q; then break; fi
  if [ "$essai" -lt 30 ]; then sleep 1; fi
done
pg_isready -h localhost -p 5432

version="$(sudo -u postgres psql -tAc 'SHOW server_version_num')"
if [ "$((version / 10000))" -ne 16 ]; then
  echo "::error::PostgreSQL 16 attendu sur le runner, version trouvée : ${version}."
  exit 1
fi

sudo -u postgres psql -c "CREATE ROLE iris LOGIN SUPERUSER PASSWORD 'iris_test';"
sudo -u postgres createdb --owner=iris --encoding=UTF8 --locale=C.UTF-8 --template=template0 "$base"

# Équivalence avec l'ancien conteneur, affichée puis vérifiée :
# - fuseau UTC : les colonnes DEFAULT CURRENT_TIMESTAMP en dépendent ;
# - UTF-8 et C.UTF-8 (tri par point de code), pour la base créée comme pour template1, dont
#   héritent les bases que des tests de migration créent sans TEMPLATE.
export PGPASSWORD=iris_test
requete() { psql -h localhost -U iris -d "$base" -tAc "$1"; }
requete 'SELECT version()'
fuseau="$(requete 'SHOW TimeZone')"
echo "Fuseau du serveur : ${fuseau}"
if [ "$fuseau" != "UTC" ] && [ "$fuseau" != "Etc/UTC" ]; then
  echo "::error::Fuseau UTC attendu pour PostgreSQL, fuseau trouvé : ${fuseau}."
  exit 1
fi
for nom in "$base" template1; do
  reglages="$(requete "SELECT pg_encoding_to_char(encoding) || ' ' || datcollate || ' ' || datctype FROM pg_database WHERE datname = '${nom}'")"
  echo "${nom} : ${reglages}"
  if [ "$reglages" != "UTF8 C.UTF-8 C.UTF-8" ]; then
    echo "::error::${nom} doit être en UTF8 et C.UTF-8 (encodage, collation, ctype) : ${reglages}."
    exit 1
  fi
done
