#!/usr/bin/env bash
# Démarre le PostgreSQL préinstallé d'un runner GitHub Ubuntu 24.04 et crée la base de la CI.
# Usage : postgresql-runner.sh <base>
# Rôle `iris` (mot de passe `iris_test`, superutilisateur comme le POSTGRES_USER de l'image
# officielle), base en UTF-8 et C.UTF-8. Échoue si le serveur n'est pas en version 16.
set -euo pipefail
base="${1:?nom de la base attendu}"

sudo systemctl start postgresql.service
for _ in $(seq 1 30); do
  pg_isready -h localhost -p 5432 -q && break
  sleep 1
done
pg_isready -h localhost -p 5432

version="$(sudo -u postgres psql -tAc 'SHOW server_version_num')"
if [ "${version:0:2}" != "16" ]; then
  echo "::error::PostgreSQL 16 attendu sur le runner, version trouvée : ${version}."
  exit 1
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE iris LOGIN SUPERUSER PASSWORD 'iris_test';"
sudo -u postgres createdb --owner=iris --encoding=UTF8 --locale=C.UTF-8 --template=template0 "$base"
PGPASSWORD=iris_test psql -h localhost -U iris -d "$base" -tAc 'SELECT version()'
