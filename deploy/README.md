# Déploiement de WorkForce

Deux méthodes, toutes deux testées : **Docker Compose** (recommandée : application + HTTPS automatique) ou **systemd** (Node installé sur le serveur).

## Prérequis
- Un serveur Linux avec les ports **80 et 443** ouverts (Let's Encrypt a besoin du 80).
- Un **nom de domaine** dont l'enregistrement DNS `A` pointe vers l'IP du serveur.
- Docker et Docker Compose (méthode 1) ou Node.js ≥ 24 (méthode 2).

## Méthode 1 — Docker Compose (application + Caddy)

```bash
git clone https://github.com/sealkrach/Workforce.git && cd Workforce
cp .env.example .env
```
Éditez `.env` (au minimum) :
```bash
DOMAIN=workforce.entreprise.fr
```
puis choisissez **comment protéger l'accès** :

**A. Mot de passe devant l'application (démarrage rapide).** À remplacer par Keycloak avant d'inviter l'équipe.
```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'UnMotDePasseSolide'   # copiez le hachage
```
```bash
# dans .env — le hachage contient des « $ » : gardez les apostrophes
CADDYFILE=./deploy/Caddyfile.basicauth
BASIC_AUTH_USER=equipe
BASIC_AUTH_HASH='$2a$14$...'
```
**B. Keycloak et/ou Google** (recommandé pour une vraie équipe) : renseignez `KEYCLOAK_*` ou `GOOGLE_*`, `ADMIN_EMAILS` et `ALLOWED_EMAIL_DOMAINS` dans `.env` (voir le README principal, section « Connexion »). Laissez `CADDYFILE` vide : Caddy ne fait alors que le HTTPS. `PUBLIC_URL` et `ALLOWED_HOSTS` sont posés automatiquement à partir de `DOMAIN`.

Démarrage :
```bash
docker compose up -d --build
docker compose logs -f workforce        # IA / SmartUC / authentification : l'état est affiché au démarrage
```
Ouvrez `https://<DOMAIN>` : le certificat est émis automatiquement au premier accès. La base est vide : l'écran d'accueil guide la création de l'organisation (ou charge la démo).

### Ce que le déploiement garantit
- Seul Caddy est exposé (80/443) ; l'application n'a aucun port publié.
- Les données vivent dans le volume `workforce-data` (base SQLite) : l'image peut être reconstruite sans perte.
- Conteneur non root, redémarrage automatique, sonde de santé (`/api/health`).
- HTTPS, HSTS, en-têtes de sécurité de l'application (CSP, anti-framing), refus des écritures venant d'un autre site.

### Sauvegardes
```bash
docker compose exec -T workforce node scripts/backup.mjs        # → /data/backups/workforce-<date>.db, 14 conservées
```
Planifiez-la chaque nuit (`crontab -e`) et **copiez les sauvegardes hors du serveur** :
```cron
15 3 * * * cd /opt/Workforce && docker compose exec -T workforce node scripts/backup.mjs >> /var/log/workforce-backup.log 2>&1
```
Restauration : arrêtez l'application (`docker compose stop workforce`), remplacez `workforce.db` du volume par la sauvegarde, redémarrez.

### Mise à jour
```bash
git pull && docker compose up -d --build        # la base est migrée automatiquement au démarrage
```

### Configuration facultative (`.env`)
| Variable | Rôle |
|---|---|
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | assistant (ou configuration depuis le badge « IA ») |
| `SMARTUC_MCP_URL`, `SMARTUC_API_KEY` | lien avec SmartUC (compte de service « requester » recommandé) |
| `SEED_DEMO=1` | charge la démonstration au démarrage d'une base **vide** |
| `ADMIN_EMAILS` | administrateurs (indispensable avec Keycloak/Google) |

## Méthode 2 — systemd (sans Docker)
Voir `deploy/workforce.service` (commandes en en-tête). L'application écoute sur `127.0.0.1:3000` ; placez Caddy ou nginx devant et déclarez le domaine :
```bash
HOST=127.0.0.1
ALLOWED_HOSTS=workforce.entreprise.fr
PUBLIC_URL=https://workforce.entreprise.fr
```
Pour nginx, réécrivant l'en-tête `Host` : ajoutez aussi `TRUST_PROXY=1` et `proxy_set_header X-Forwarded-Host $host;`.

## Dépannage
| Symptôme | Cause probable |
|---|---|
| `403 Hôte « … » non autorisé` | le domaine n'est pas dans `ALLOWED_HOSTS` (avec Docker : vérifiez `DOMAIN`) |
| Certificat non émis | DNS qui ne pointe pas vers le serveur, ou port 80 fermé : `docker compose logs caddy` |
| « Connexion impossible : le compte … n'est pas enregistré » | ajoutez l'e-mail dans Réglages › Personnes, ou `ALLOWED_EMAIL_DOMAINS` / `ADMIN_EMAILS` |
| Personne ne peut se connecter après avoir activé Keycloak | renseignez `ADMIN_EMAILS` : une base neuve n'a aucun compte |
| Micro indisponible | l'accès doit se faire en HTTPS (ou `localhost`) |
