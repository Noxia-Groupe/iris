# Entrer dans Iris sans passer par Microsoft

Iris n'a plus de mot de passe applicatif : la connexion normale des utilisateurs de la
société passe par **Microsoft Entra ID**. C'est un bon choix de sécurité, mais il crée une
dépendance à un service extérieur. Deux portes complètent donc l'entrée principale, chacune
pour un besoin différent.

| Porte | Pour qui | Ce qu'elle ouvre | Durée |
|---|---|---|---|
| Microsoft Entra ID | les personnes de la société | selon leur rôle | 7 jours |
| Accès de secours | le super administrateur, en panne de SSO | tous les droits | 1 heure |
| Clé d'intégration | un agent (Hermes) ou un connecteur | ses scopes, rien de plus | jusqu'à révocation |

---

## 1. Accès de secours du super administrateur

### À quoi il sert

À entrer quand Entra ID ne répond plus : panne du tenant Microsoft, application Azure
supprimée ou mal reconfigurée, migration de tenant, compte de direction verrouillé. Sans
cette porte, une instance dont le SSO tombe devient **inadministrable** — personne ne peut
plus entrer, pas même pour réparer.

Ce n'est pas une connexion de confort : c'est une porte de service.

### Activation

Dans `server/.env`, sur le VPS uniquement :

```env
BREAK_GLASS_EMAIL="direction@votre-societe.fr"
BREAK_GLASS_TOKEN="<le résultat de : openssl rand -base64 48>"
```

Puis redémarrer le backend. Au démarrage, il confirme dans ses journaux :

```
[SECOURS] Accès de secours actif pour direction@votre-societe.fr (session limitée à 1 h).
```

Si le jeton fait moins de 32 caractères, le mécanisme **reste inactif** et le dit — un
secret trop court accepté en silence serait pire que pas de secours du tout.

### Utilisation

Aller sur `https://<votre-instance>/secours` et coller le jeton.

Pour un accès en un clic, enregistrer ce signet :

```
https://<votre-instance>/secours#token=LE_JETON
```

Ce qui suit le `#` est un *fragment* : le navigateur ne l'envoie **jamais** au serveur. Il
n'apparaît donc ni dans les journaux nginx, ni dans ceux d'un proxy intermédiaire. La page
l'efface de la barre d'adresse dès qu'elle l'a lu.

### Ce qui protège cette porte

- Le jeton ne vit que dans `server/.env` sur le VPS. Il n'est ni en base, ni dans Git.
- Il n'ouvre **qu'un compte précis** (`BREAK_GLASS_EMAIL`), qui doit exister, être actif et
  être `SUPERADMIN`. Un compte rétrogradé ou désactivé referme la porte, jeton valide ou non.
- La comparaison se fait à temps constant, sur les empreintes SHA-256 des deux valeurs :
  ni la durée de la réponse ni la longueur du secret attendu ne fuient.
- Cinq tentatives par quart d'heure et par adresse IP, puis blocage.
- La session dure **1 heure**, contre 7 jours pour une connexion Microsoft.
- Chaque tentative, réussie ou non, est écrite dans les journaux du conteneur avec l'IP :
  `docker logs iris_backend | grep SECOURS`.

### Après usage

Changer le jeton (`openssl rand -base64 48`), le remplacer dans `server/.env`, redémarrer.
Un jeton utilisé est un jeton qui a circulé.

---

## 2. Clé d'intégration pour un agent (Hermes)

### Le principe

Un agent n'a pas de compte Microsoft et ne doit pas en avoir : lui en donner un
reviendrait à créer un utilisateur fantôme dans l'annuaire de la société. Il s'authentifie
avec une clé Iris, limitée à ce dont il a besoin.

### Créer une clé

Dans l'application, **API d'intégration** (menu latéral, super administrateur uniquement) :
nommer la clé, cocher ses scopes, valider. Le secret n'est affiché **qu'une fois** — il
n'est pas stocké, seule son empreinte SHA-256 l'est. Perdu, il se remplace ; il ne se
retrouve pas.

### Scopes disponibles

| Scope | Donne accès à |
|---|---|
| `clients:read` | lire les clients, leurs contacts et leurs sites |
| `clients:write` | créer et modifier clients, contacts, sites |
| `catalogue:read` | lire les prestations, articles, équipements et catégories |
| `catalogue:write` | créer et modifier les fiches catalogue |
| `company:read` | lire l'identité de la société (en-tête de documents) |
| `chantiers:read` | lire les chantiers, leurs achats et leurs heures |
| `finances:read` | ajoute les montants vendus et la marge aux chantiers |

Donnez le minimum : un agent qui rédige des devis n'a pas besoin d'écrire dans le
référentiel client.

### Pourquoi `finances:read` est séparé de `chantiers:read`

Dans l'interface, les montants vendus et la marge sont déjà réservés à certains rôles :
un conducteur de travaux ne les voit pas sur la liste des chantiers. La même règle vaut
pour une clé d'intégration — lire un chantier ne doit pas suffire à connaître ce qu'il a
rapporté. Un agent qui prépare un planning ou un rapport d'intervention travaille très
bien avec `chantiers:read` seul ; `finances:read` ne se donne qu'à un agent dont c'est
justement le sujet.

### Ce qu'un agent voit, et pourquoi ce n'est pas ce que voit un humain

Côté interface, le périmètre dépend du **rôle** : un conducteur ne voit que les chantiers
dont il est responsable, un commercial ceux qu'il a vendus, un administrateur voit tout.

Côté clé d'intégration, il dépend du **scope** : une clé ne représente personne en
particulier, elle n'a donc pas de rôle à interroger. Porter `chantiers:read` vaut
autorisation sur l'ensemble du domaine, et c'est au superadmin de ne délivrer que les
scopes utiles à l'agent.

Ce n'est pas un chemin plus permissif accordé aux robots : les deux portes exécutent le
**même handler** (cf. `routeMixte` dans `server/src/http/routes-mixtes.ts`), avec les mêmes validations et
les mêmes réponses d'erreur. Seule la façon de calculer le périmètre diffère, comme elle
diffère déjà entre un administrateur et un conducteur.

### Utilisation

```bash
curl -H "Authorization: Bearer iris_xxxxxxxx" https://<instance>/api/v1/clients
curl -H "Authorization: Bearer iris_xxxxxxxx" https://<instance>/api/v1/catalogue/articles
curl -H "Authorization: Bearer iris_xxxxxxxx" https://<instance>/api/v1/chantiers
curl -H "Authorization: Bearer iris_xxxxxxxx" https://<instance>/api/v1/achats
curl -H "Authorization: Bearer iris_xxxxxxxx" https://<instance>/api/v1/heures
```

Les routes `/api/v1/…` sont servies par **exactement les mêmes handlers** que l'interface
(cf. `routeMixte` dans `server/src/http/routes-mixtes.ts`). Un agent ne dispose donc d'aucun chemin plus
permissif qu'un humain : mêmes validations, mêmes messages d'erreur, mêmes règles métier.
Une correction faite pour l'interface vaut aussitôt pour l'agent.

### Réponses possibles

| Code | Signification |
|---|---|
| 401 | clé absente, inconnue, expirée ou révoquée |
| 403 | clé valide, mais le scope demandé lui manque |
| 400 | la requête est refusée par la validation métier (même règle que l'interface) |

### Révoquer

Bouton **Révoquer** dans le même écran : l'effet est immédiat, à la requête suivante.
La clé reste listée avec sa date de révocation, pour garder trace de ce qui a existé.

La colonne « dernière utilisation » sert à repérer une clé oubliée : jamais utilisée depuis
sa création, elle n'a probablement plus de raison d'exister.
