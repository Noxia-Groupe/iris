# IRIS — ERP pour métiers techniques

**Propriété logicielle** : Noxia-Groupe / OrizonLab  
**Repo** : https://github.com/Noxia-Groupe/iris  
**VPS** : CommercePro 46.202.129.169  
**Déploiement** : /srv/iris (multi-tenant isolé sur même VPS)

## Vision
Base technique issue de marge, complètement refondue. ERP pour métiers techniques : interventions SAV, interventions travaux, facturation récurrente, abonnements télécom (4G/fibre), financeurs (Grenke, LPB), raccordement bancaire automatique, web app mobile pour techniciens, branding personnalisé par client (couleurs + logo), identités légales remplies automatiquement, multi-tenant sécurisé (clients isolés sur même VPS), propriété du logiciel conservée, pas de landing page publique ni d'inscription libre.

## Différences avec marge (audit anti-amalgame)
| Élément | Marge | Iris |
|---|---|---|
| Nom du projet | marge | iris |
| Conteneurs Docker | marge_db / marge_backend / marge_frontend | iris_db / iris_backend / iris_frontend |
| Base PG | marge | iris |
| Utilisateur PG | marge | iris |
| Auth | Microsoft (adaptable) | Microsoft (adaptable par client) |
| Client cible | chantier unique | multi-tenant, isolation par client |
| Branding | fixe | personnalisable (logo + couleurs) par client |
| Facturation | suivi financier chantier | récurrente + abonnements + financeurs |
| Rapprochement bancaire | non présent | prévu (Bridge / Powens / Budget Insight) |
| Web app mobile techno | non | prévue (planning + rapport intervention + signature) |
| Propriété logiciel | Noxia-Groupe | Noxia-Groupe (non open source client) |
| VPS | CommercePro 46.202.129.169 | même VPS, facturation VPS intégrée au coût par utilisateur / abonnement |

## Modules prévus
1. **Interventions SAV** — suivi, historique client, photos, rapports signés
2. **Interventions Travaux** — planning, heures, achats, devis, facture
3. **Contrats & Maintenance récurrente** — échéances automatiques, prorata, renouvellement
4. **Abonnements télécom** — 4G, fibre, box : cycle de facturation, suspension, résiliation
5. **Financeurs** — Grenke, LPB : suivi des financements liés aux équipements/interventions
6. **Rapprochement bancaire** — relevés automatiques + rapprochement factures / paiements
7. **Identité client** — logo, couleurs, informations légales (SIRET, adresse, conditions)
8. **Comptes & Droits** — profil technique, commercial, comptable, admin, super-admin ; isolation des données par tenant
9. **Web mobile technicien** — planning, détails intervention, saisie info, photo, signature numérique
10. **Déploiement** — Docker sur même VPS (multi-tenant isolé), coût intégré dans l'abonnement utilisateur final

## Authentification
Microsoft Entra ID — adaptée par client futur (tenant client). Pas de page d'inscription publique. Utilisateurs créés par admin du tenant.

## Stack technique
- Backend : TypeScript / Node (serveur existant marge)
- Frontend : React / Vite (client existant marge)
- Base : PostgreSQL 16 (dockerisé)
- Déploiement : Docker Compose sur VPS CommercePro 46.202.129.169
- Réseaux : `noxia-network` + `nginx-proxy` (NPM) + `backup-net` (pgBackWeb)

## Propriété
Le logiciel reste la propriété de Noxia-Groupe / OrizonLab. Les clients obtiennent un accès (abonnement utilisateur) sans accès au code source. Isolation des données garantie même sur même VPS.

## Roadmap (ordre de travail)
- [ ] Phase 0 : Nettoyage marge → iris (fait : docker-compose, .env, deploy_guide)
- [ ] Phase 1 : Audit final anti-liens marge dans le code source (grep complet)
- [ ] Phase 2 : Schéma Prisma — multi-tenant, clients isolés, profils droits, branding
- [ ] Phase 3 : Module Intervention SAV + Travaux
- [ ] Phase 4 : Facturation récurrente (contrats maintenance)
- [ ] Phase 5 : Abonnements télécom (4G, fibre)
- [ ] Phase 6 : Financeurs (Grenke, LPB)
- [ ] Phase 7 : Rapprochement bancaire (Bridge / Powens)
- [ ] Phase 8 : Web mobile technicien (planning, rapport, signature)
- [ ] Phase 9 : Branding personnalisé (logo, couleurs, infos légales)
- [ ] Phase 10 : Auth Microsoft adaptable par client + multi-tenant
- [ ] Phase 11 : Déploiement production /srv/iris sur VPS 46.202.129.169

## Détail audit anti-amalgame (à vérifier sur le code source)
- [ ] `grep -r "marge" server/ client/ --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist`
- [ ] Vérifier variables d'environnement `.env.example`, `.env` (déjà renommé)
- [ ] Vérifier références DB dans `prisma/schema.prisma` et migrations
- [ ] Vérifier noms de services dans `docker-compose.yml` (déjà renommé)
- [ ] Vérifier `package.json` (nom du projet)
- [ ] Vérifier `.agents` dans `client/` ou `server/` (références internes marge)
- [ ] Vérifier `brand/` (logo marge à remplacer par branding neutre / personnalisé client)
