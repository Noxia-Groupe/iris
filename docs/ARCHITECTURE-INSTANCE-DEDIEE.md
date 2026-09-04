# Iris — Architecture par instance dédiée

## Décision

Une installation Iris sert **une seule société**. Il n'existe ni tenant métier, ni inscription publique, ni partage de base de données entre clients.

Chaque client dispose de :

- sa propre stack Docker ou son propre VPS ;
- son propre conteneur PostgreSQL et ses volumes ;
- sa configuration Microsoft Entra ID ;
- son identité légale, son logo, ses couleurs et ses modules ;
- ses sauvegardes et secrets propres.

## Rôles

### Utilisateurs de la société cliente

Tous passent par Microsoft Entra ID configuré pour cette installation.

- `TECHNICIEN`
- `RESPONSABLE_TRAVAUX`
- `COMMERCIAL`
- `COMPTABLE`
- `ADMIN`

Un `ADMIN` gère les utilisateurs standards et les opérations métier, mais ne voit pas les comptes plateforme ni les réglages réservés.

### Super administrateurs plateforme

Le rôle `SUPERADMIN` est réservé à Noxia-Groupe / OrizonLab. Il peut :

- voir tous les comptes de l'instance ;
- créer, promouvoir et révoquer les autres super administrateurs ;
- activer/désactiver les modules ;
- administrer les réglages sensibles et intervenir pour le support.

Un `ADMIN` client ne peut ni voir l'existence des super administrateurs, ni les créer, modifier, désactiver ou supprimer.

## Accès plateforme hors Microsoft client

L'accès utilisateur normal reste exclusivement Microsoft Entra ID. L'accès plateforme Noxia/OrizonLab sera une voie distincte, jamais un mot de passe local partagé :

1. route dédiée `/api/platform/*`, séparée des routes client ;
2. authentification par passkey WebAuthn pour les super administrateurs plateforme ;
3. protection réseau complémentaire : mTLS ou allowlist IP/VPN de gestion ;
4. sessions courtes, scopes explicites et journal d'audit complet ;
5. compte et clé d'urgence (« break-glass ») créés à l'installation, chiffrés hors Git et conservés sous contrôle Noxia/OrizonLab ;
6. aucune donnée de connexion de secours dans les fichiers du client ou le dépôt Git.

L'API de diagnostic Hermes suivra le même modèle machine-à-machine : clé dédiée à portée minimale, rotation/révocation, journal d'audit et accès réseau limité. Elle ne sera pas assimilée à un compte utilisateur `SUPERADMIN`.

## Ordre de construction

1. `CompanySettings` singleton : identité légale, logo, couleurs, coordonnées et préférences de facturation.
2. Rôles applicatifs et garde-fous `SUPERADMIN` invisibles aux admins client.
3. Registre de modules activables exclusivement par les super administrateurs.
4. Auth Microsoft configurée à l'installation pour la société cliente.
5. Voie d'administration plateforme WebAuthn + couche réseau de gestion.
6. API interne Hermes à privilèges minimaux.