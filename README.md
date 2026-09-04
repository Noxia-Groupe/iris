# IRIS — ERP pour métiers techniques

**Propriété logicielle** : Noxia-Groupe / OrizonLab  
**Repo** : https://github.com/Noxia-Groupe/iris  
**VPS** : CommercePro 46.202.129.169  
**Déploiement** : une instance Iris dédiée par société cliente, avec sa propre base PostgreSQL

## Vision
Base technique reprise de marge, en cours de refonte module par module. ERP pour métiers techniques : interventions SAV, interventions travaux, facturation récurrente, abonnements télécom (4G/fibre), financeurs (Grenke, LPB), raccordement bancaire automatique, web app mobile pour techniciens, branding personnalisé (couleurs + logo) et identité légale de la société exploitante. Une installation Iris correspond à une seule société : déploiement à la demande, sans inscription publique ni mutualisation de base de données.

## Différences avec marge (audit anti-amalgame)
| Élément | Marge | Iris |
|---|---|---|
| Nom du projet | marge | iris |
| Conteneurs Docker | marge_db / marge_backend / marge_frontend | iris_db / iris_backend / iris_frontend |
| Base PG | marge | iris |
| Utilisateur PG | marge | iris |
| Auth | Microsoft (adaptable) | Microsoft (adaptable par client) |
| Client cible | chantier unique | une société par installation Iris |
| Branding | fixe | personnalisable pour la société installée |
| Facturation | suivi financier chantier | récurrente + abonnements + financeurs |
| Rapprochement bancaire | non présent | prévu (Bridge / Powens / Budget Insight) |
| Web app mobile techno | non | prévue (planning + rapport intervention + signature) |
| Propriété logiciel | Noxia-Groupe | Noxia-Groupe (non open source client) |
| VPS | CommercePro 46.202.129.169 | VPS ou stack Docker dédiée par client, base PostgreSQL propre |

## Modules prévus

> Référence fonctionnelle et UX : [`docs/PRODUCT-VISION-ERP-TECHNIQUE.md`](docs/PRODUCT-VISION-ERP-TECHNIQUE.md). Iris possède son propre référentiel clients, contacts, sites, devis, interventions, contrats et factures ; les intégrations externes ne sont jamais sa source de vérité.

1. **Interventions SAV** — suivi, historique client, rapports signés
2. **Interventions Travaux** — planning, heures, achats, devis, facture
3. **Contrats & Maintenance récurrente** — échéances automatiques, prorata, renouvellement
4. **Abonnements télécom** — 4G, fibre, box : cycle de facturation, suspension, résiliation
5. **Financeurs** — Grenke, LPB : suivi des financements liés aux équipements/interventions
6. **Rapprochement bancaire** — relevés automatiques + rapprochement factures / paiements
7. **Identité client** — logo, couleurs, informations légales (SIRET, adresse, conditions)
8. **Comptes & Droits** — profil technique, commercial, comptable, admin, super-admin ; séparation stricte plateforme/client
9. **Web mobile technicien** — planning, détails intervention, saisie info, signature numérique
10. **Déploiement** — Docker/VPS dédiée par société ; instance et base de données propres

## Règles métier : aucune valeur de société dans le code

Les barèmes de commission, objectifs mensuels, primes et le libellé du barème réduit sont
stockés en base (`ParametresRemuneration`) et s'éditent depuis **Administration >
Rémunération commerciale** par un super administrateur. Ils étaient auparavant écrits en
dur dans `server/index.ts` : changer un taux imposait un redéploiement, et chaque instance
livrée portait les règles de rémunération d'une autre société.

De même, aucun email d'administration n'est codé en dur : `SUPERADMIN_EMAILS` est
obligatoire au premier démarrage d'une instance neuve, faute de quoi aucun compte
d'administration n'est créé.

## Hors périmètre

- **Dépôt et galerie de photos.** Héritée de marge, la galerie photos de chantier a été
  retirée : Iris n'a pas vocation à héberger des médias, ni sur le suivi de chantier, ni
  sur les modules à venir. Cela supprime du même coup un volume disque à sauvegarder, un
  service de fichiers statiques et une route d'envoi de fichiers à sécuriser.

## Authentification
Microsoft Entra ID uniquement — adaptée par client futur (tenant client). Pas de page d'inscription publique, de connexion locale ni de mot de passe applicatif. L'application SPA utilise MSAL ; le backend vérifie la signature Microsoft (JWKS/RS256), l'issuer et l'audience avant d'appliquer sa liste blanche locale. Utilisateurs créés par un admin du tenant.

L'application n'a plus aucun mot de passe. Deux portes complètent Entra ID sans le
remplacer — voir [`docs/ACCES-SANS-MICROSOFT.md`](docs/ACCES-SANS-MICROSOFT.md) :

- **Accès de secours** (`/secours`) : réservé au super administrateur, pour entrer quand le
  SSO est indisponible ou mal configuré. Jeton dans `server/.env`, session d'une heure,
  tentatives journalisées. Sans lui, une instance dont le SSO tombe est inadministrable.
- **Clés d'intégration** : pour un agent (Hermes) ou un connecteur, avec des scopes
  restreints et une révocation immédiate. Aucun compte Microsoft n'est créé pour un robot.

### Configuration Entra ID à réaliser
- Type d'application : **Single-page application (SPA)**.
- URI de redirection : `https://iris.noxia-groupe.fr/auth/callback`.
- Renseigner ensuite `AZURE_TENANT_ID` et `AZURE_CLIENT_ID` uniquement dans `server/.env` sur le VPS ; ces valeurs sont publiques par nature pour une SPA.
- Ne pas créer de secret client pour ce flux SPA. Aucun secret Microsoft ne doit être ajouté au dépôt.

## Stack technique
- Backend : TypeScript / Node (serveur existant marge)
- Frontend : React / Vite (client existant marge)
- Base : PostgreSQL 16 (dockerisé)
- Déploiement : Docker Compose sur VPS CommercePro 46.202.129.169
- Réseaux : `noxia-network` + `nginx-proxy` (NPM) + `backup-net` (pgBackWeb)

## Propriété
Le logiciel reste la propriété de Noxia-Groupe / OrizonLab. Les clients obtiennent un accès à leur instance sans accès au code source. Chaque client dispose de son propre déploiement et de sa propre base de données ; aucune donnée métier n'est partagée entre sociétés.

## Roadmap (ordre de travail)
- [x] Phase 0 : Nettoyage marge → iris (docker-compose, `.env.example`, guide de déploiement)
- [ ] Phase 1 : Audit final anti-liens marge dans le code source (grep complet)
- [x] Authentification : Microsoft Entra ID uniquement (suppression connexion locale, mots de passe, seed de comptes locaux)
- [x] Phase 2 : Paramétrage de l’instance — société (écran + registre des entreprises), modules, profils et rôles ; clés API d’intégration et accès de secours superadmin
- [x] Phase 3 : Référentiel clients natif — clients, contacts, sites de facturation et d’intervention
- [ ] Phase 4 : Catalogue — fait : modèles, migrations, catégories, API et écran de gestion ; reste le parc d’équipements installé (`EquipementInstalle` existe en base, sans écran)
- [ ] Phase 5 : Devis versionnés et conversion contrôlée vers intervention, chantier, contrat ou facture
- [ ] Phase 6 : Interventions SAV + travaux, planning et application mobile technicien
- [ ] Phase 7 : Contrats et maintenance cyclique — génération des interventions à planifier avec durée prévisionnelle
- [ ] Phase 8 : Facturation française, exports comptables et conformité facturation électronique
- [ ] Phase 9 : Paiements, abonnements télécom, financeurs et rapprochement bancaire
- [ ] Phase 10 : Connecteurs Microsoft 365 (Outlook/Graph) et branding complet
- [ ] Phase 11 : Auth Microsoft configurable à l'installation + accès plateforme de secours Noxia/OrizonLab
- [ ] Phase 12 : Déploiement production dédié par client (VPS ou stack Docker + base PostgreSQL propre)

## Tests

```bash
cd server && npm test
```

Les tests appellent le code : fonctions de validation exécutées directement, requêtes HTTP
réelles sur l'application montée en mémoire. Les tests HTTP ont besoin d'une base jetable
via `TEST_DATABASE_URL` et s'annoncent ignorés sans elle — voir
[`server/tests/README.md`](server/tests/README.md).

Un test qui relit le code source en texte n'en est pas un : il reste vert sur une branche
qui ne compile même pas. Cette règle est la seule qui compte ici.

## Détail audit anti-amalgame (à vérifier sur le code source)
- [ ] `grep -r "marge" server/ client/ --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist`
- [ ] Vérifier variables d'environnement `.env.example`, `.env` (déjà renommé)
- [ ] Vérifier références DB dans `prisma/schema.prisma` et migrations
- [ ] Vérifier noms de services dans `docker-compose.yml` (déjà renommé)
- [ ] Vérifier `package.json` (nom du projet)
- [ ] Vérifier `.agents` dans `client/` ou `server/` (références internes marge)
- [ ] Vérifier `brand/` (logo marge à remplacer par branding neutre / personnalisé client)
