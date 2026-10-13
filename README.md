# WorkForce

Gestion de projets IT et d'équipes transverses, pilotée en langage naturel (chat + voix).
Zéro dépendance : Node ≥ 24 suffit (`node:sqlite`, `fetch` natifs ; testé avec Node 25.9), pas de build.

```bash
npm start            # http://127.0.0.1:3000 — base vide au premier démarrage : l'interface guide la création de l'organisation
npm test             # 68 tests (chat, annulation, OpenAI simulé, réglages LLM, squads & features, durcissement)
```

## Vérifier votre LLM
`npm run llm:check` envoie 7 demandes réalistes en français (création, mise à jour par description, deux tâches d'un coup, charge, recherche, politesse, hors périmètre) à votre modèle, sur une base de démonstration **en mémoire**, et affiche ce que l'assistant proposerait. C'est le meilleur premier test d'une vraie clé.

## Brancher un LLM
Copier `.env.example` en `.env` et renseigner `LLM_API_KEY` (+ `LLM_BASE_URL` / `LLM_MODEL` pour Azure, Ollama, vLLM, OpenRouter…).
Sans clé : **mode local**, un analyseur simplifié (badge orange) qui permet de tout essayer hors-ligne mais comprend bien moins qu'un vrai modèle.

## Organisation : l'équipe suit la feature
`Projet / initiative → Feature → Tâche`, et `Squad = 3 à 5 personnes + 1 lead`, propriétaire de ses features.
- **Une feature appartient à une seule squad** ; les tâches sans feature tombent dans l'**Inbox** que les leads trient (glisser-déposer ou liste).
- **Fonction** (Dev, Infra, Sécurité…) = compétence de la personne ; **squad** = équipe qui livre. Une personne a une squad principale et peut prêter 5 à 50 % de son temps à une autre.
- **Santé d'une feature calculée et expliquée** (vert / orange / rouge) : retards, blocages, tâches sans responsable, dépendance vers une autre squad, squad surchargée.
- **Garde-fous** : squad hors de 3–5, pas de lead, trop de features en parallèle, couplage entre squads (≥ 2 dépendances), tâches non triées. Le lead ne peut pas être déplacé sans successeur.
- **Vues** : *Features* (accueil du lead), *Tableau* (une ligne par feature), *Squads* (effectifs, carte des dépendances, glisser une personne pour la déplacer), *Charge*.

## Principes
- **Le chat propose, l'humain confirme** : le LLM n'écrit jamais en base. Chaque lot confirmé est journalisé et annulable (bouton *Annuler*).
- **Classement automatique** : projet, équipe, priorité, échéance, étiquettes déduits du message (badge *auto* sur les valeurs déduites).
- **Recoupement** : pré-filtre FTS5 des tâches proches, puis jugement du LLM (doublon / lié / bloquant), proposé sous forme de cases à cocher.
- **Workflow fixe** (À faire → En cours → En revue → Terminé), « bloquée » calculé depuis les liens : aucune configuration.
- **Vues** : tableau (glisser-déposer), liste, charge d'équipe + dépendances inter-équipes, journal.

## Voix
- Navigateurs Chromium/Safari : reconnaissance vocale native (fr-FR), envoi automatique à la fin de la phrase.
- Autres navigateurs : enregistrement + transcription via `/audio/transcriptions` de votre fournisseur.
- ⚠️ Le micro exige `localhost` ou **HTTPS** : en HTTP sur le réseau local, le navigateur le bloque.
- 🔈 active la lecture à voix haute des réponses.

## Premier démarrage (équipe réelle)
Aucune donnée de démonstration n'est imposée : sur une base vide, l'écran d'accueil propose **d'ajouter les personnes** (Réglages) ou de **charger la démo** pour explorer. Réglages permet aussi de gérer personnes, projets, fonctions, d'**exporter** en JSON et d'**effacer toutes les données** (sauvegarde automatique dans `data/backups/` avant). `SEED_DEMO=1` charge la démo au démarrage, uniquement si la base est vide.

## Connexion (Keycloak et/ou Google)
Un seul moteur **OpenID Connect** (flux « authorization code » + PKCE, `state` et `nonce` à usage unique, `id_token` vérifié : signature RS256 par JWKS, émetteur, audience, expiration) couvre Keycloak, Google et tout fournisseur OIDC. Dès qu'un fournisseur est configuré, l'application exige une connexion et ignore le sélecteur d'utilisateur. Les sessions sont stockées en base (14 jours, cookie `HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS).

```bash
PUBLIC_URL=https://workforce.entreprise.fr        # adresse que voient les utilisateurs (sert aux redirections)
# Keycloak : client « confidentiel », flux standard activé, URI de redirection valide = PUBLIC_URL/auth/callback/keycloak
KEYCLOAK_ISSUER=https://sso.entreprise.fr/realms/entreprise
KEYCLOAK_CLIENT_ID=workforce
KEYCLOAK_CLIENT_SECRET=...
# Google : identifiants OAuth « Application Web », URI de redirection = PUBLIC_URL/auth/callback/google
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
ALLOWED_EMAIL_DOMAINS=entreprise.fr               # domaines autorisés à créer leur compte à la première connexion
ADMIN_EMAILS=prenom.nom@entreprise.fr             # administrateurs
```
- **Correspondance par e-mail** : un utilisateur est rattaché à la personne de WorkForce dont l'e-mail est identique (Réglages › Personnes, champ « E-mail »). Inconnu et domaine non autorisé : refusé avec un message clair. Domaine autorisé : compte créé automatiquement (sans squad) et les administrateurs sont notifiés.
- **Google** exige un e-mail vérifié. Restreignez aussi l'écran de consentement à votre organisation côté Google.
- **Rôles** : *administrateur* (réglages, personnes, projets, fonctions, LLM, export, effacement, création/suppression de squads, changement de lead) ; *lead* (modifie **sa** squad, ses features, leurs dépendances, l'appartenance et le prêt de temps de ses membres) ; *membre* (tâches, chat, sa propre fiche). Sans fournisseur configuré, tout le monde est administrateur.
- Sans `ADMIN_EMAILS` ni administrateur existant, le **premier compte autorisé** à se connecter devient administrateur : renseignez `ADMIN_EMAILS` en production.
- Testé contre un faux fournisseur OIDC qui vérifie réellement PKCE et signe de vrais jetons, **pas contre une instance Keycloak ou Google réelle** : faites une première connexion de contrôle avant d'inviter l'équipe.

## Use cases IA : lien avec SmartUC
WorkForce se connecte à [SmartUC](https://github.com/sealkrach/SmartUC) (registre des use cases IA, gouvernance à portes) par **MCP**, en **lecture seule** : SmartUC reste la source de vérité des UC, WorkForce porte la livraison.
- **Un use case ↔ une ou plusieurs features** (une par squad qui en livre une partie). Les UC liés s'affichent sur les features (puce colorée par statut, fiche détaillée, lien « Ouvrir dans SmartUC »).
- **Synchronisation** toutes les 5 min (SmartUC n'émet pas de webhook) : cache local, détails lus pour les UC approuvés, en construction ou liés. Si SmartUC est indisponible, le cache daté reste affiché.
- **« Use cases à planifier »** (vue Features, leads et administrateurs) : les UC approuvés sans feature. *Planifier* crée la feature préremplie (titre, résultat attendu, échéance, statut), la **rattache à l'UC** et propose un **paquet de tâches propre à l'IA** (accès et qualité des données, intégrations, prototype, validation humaine, jeu d'évaluation, KPIs, mitigations, documentation EU AI Act si haut risque, suivi, revue de go-live), dimensionné par l'effort S/M/L/XL.
- **Squad suggérée, avec ses raisons** : porteur du UC présent dans la squad (rapprochement par e-mail, même Keycloak), équipes citées, entités partagées avec les UC qu'elle porte déjà, compétences, puis pénalités de capacité.
- **Garde-fous de gouvernance** : feature « en réalisation » alors que l'UC n'est pas approuvé, rejeté ou retiré, tier EU AI Act non validé en livraison, UC supprimé, feature « en ligne » alors que l'UC n'est pas en production. Santé des features et notifications (changement de statut, tier validé, nouvelle relation confirmée, nouvel UC à planifier) en découlent.
- **Aucune écriture vers SmartUC** : les passages de porte restent humains, dans SmartUC.

Configuration : Réglages › Intégrations › SmartUC (URL MCP, clé, test de connexion avec rôle du compte et nombre d'UC), ou `SMARTUC_MCP_URL` / `SMARTUC_API_KEY`. Créez dans SmartUC un compte de service « reviewer » ou « admin » (un « requester » ne voit que ses propres UC) et une clé via *MCP & API*. `npm run smartuc:check` teste la liaison et montre ce qui serait proposé, sans rien modifier. La clé reste côté serveur et n'est jamais envoyée vers une autre URL que celle saisie ni suivie dans une redirection.

## Notifications et Inbox
- **Cloche** 🔔 (en-tête) : vous êtes prévenu quand une tâche vous est assignée ou retirée, que sa priorité, son statut ou son échéance change (par quelqu'un d'autre), qu'elle devient bloquée ou débloquée, ou supprimée ; qu'une tâche à trier arrive dans l'Inbox de votre squad ; qu'une dépendance est déclarée sur votre feature ; qu'on vous place dans une squad ; qu'un nouveau compte attend d'être rangé (administrateurs). Jamais pour vos propres actions. Alertes du navigateur optionnelles (onglet en arrière-plan). Pas d'e-mail ni de Slack pour l'instant.
- **Inbox par squad** : une tâche sans feature est adressée à la squad de son assigné, à défaut à celle de son auteur. Le lead de cette squad la rattache à une feature ou la renvoie vers la bonne squad (liste, glisser-déposer, ou fiche de la tâche). La rattacher à une feature la sort de l'Inbox.

## Mobile
Le glisser-déposer fonctionne au doigt : **appui long (~0,3 s)** sur une carte, une tâche ou une personne, puis déplacement ; le défilement se fait automatiquement près des bords. Le tableau se parcourt en colonnes à faire défiler horizontalement. Sur écran tactile le glisser natif du navigateur est désactivé (il entrerait en conflit) : la souris continue d'utiliser le glisser natif.

## Déploiement pour l'équipe
- **Réseau** : par défaut le serveur n'écoute que sur `127.0.0.1`. Pour l'ouvrir à l'équipe : `HOST=0.0.0.0 npm start`.
- ⚠️ **Sans fournisseur de connexion configuré** (voir ci-dessous), le sélecteur « Connecté en tant que » est une commodité, pas une sécurité : n'importe qui peut en changer, et modifier la configuration du LLM. À n'utiliser que sur un réseau de confiance. **Pour une vraie équipe, activez Keycloak et/ou Google.** La clé du LLM reste côté serveur, n'est jamais renvoyée au navigateur ni envoyée vers une autre URL que celle pour laquelle elle a été saisie.
- **Protections intégrées** : corps limités à 1 Mo, JSON uniquement, refus des requêtes provenant d'un autre site (Origin), en-têtes CSP / anti-framing, validation de tous les champs, écritures transactionnelles.
- **HTTPS / reverse proxy** : le micro exige `localhost` ou HTTPS. Placez un reverse proxy HTTPS (Caddy, nginx) devant l'outil et déclarez son adresse, sinon les requêtes sont refusées (403) :
  - `ALLOWED_HOSTS=workforce.entreprise.fr` (liste séparée par des virgules) ;
  - `TRUST_PROXY=1` si le proxy réécrit l'en-tête `Host` (nginx par défaut) : il doit alors transmettre `X-Forwarded-Host` (`proxy_set_header X-Forwarded-Host $host;`).
  - Caddy (`reverse_proxy 127.0.0.1:3000`) conserve `Host` : `ALLOWED_HOSTS` suffit.
- **Disponibilité** : lancez-le sous `pm2` ou `systemd` pour un redémarrage automatique.
- **Sauvegarde** : copiez `data/workforce.db` (et `-wal` si présent) ou utilisez Réglages › Exporter.
- **Dates** : calculées dans le fuseau horaire du serveur (variable `TZ` si besoin).
- **Confidentialité de la voix** : la reconnaissance vocale de Chrome envoie l'audio au service de Google ; la transcription de secours envoie l'audio à votre fournisseur LLM.

## Limites actuelles
Pas de commentaires ni de mentions, notifications dans l'application uniquement (pas d'e-mail), pas de déconnexion centralisée (Keycloak back-channel), réponses non streamées, pas de sous-tâches ni de sprints. Les vues se resynchronisent toutes les 15 s (pas de temps réel).
