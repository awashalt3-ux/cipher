# Cipher Mail

Gestionnaire de boîtes **temp mail** (eztempmail.com) avec boîte de réception,
stockage permanent de toutes les adresses et de leurs messages, et compte sécurisé.

[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.5-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dépendances](https://img.shields.io/badge/d%C3%A9pendances-0-blue)](#)
[![Licence](https://img.shields.io/badge/licence-MIT-black)](#licence)

```bash
git clone https://github.com/awashalt3-ux/cipher.git
cd cipher
npm start          # http://127.0.0.1:4317
```

Aucune dépendance : Node.js ≥ 22.5 (SQLite natif, `node:sqlite`). La base, la clé de chiffrement et
l'outbox sont créés automatiquement dans `data/` au premier démarrage.

---

## Ce que fait l'application

| Fonction | Détail |
|---|---|
| **Création de boîtes** | Génère une adresse chez eztempmail (nom aléatoire ou personnalisé, choix du domaine). |
| **Conservation permanente** | La session eztempmail de chaque boîte (cookies + CSRF) est chiffrée en AES-256-GCM et stockée. C'est elle qui « possède » la boîte côté eztempmail : en la conservant, on retrouve l'adresse et ses messages indéfiniment. |
| **Relève automatique** | Une boucle serveur interroge les boîtes en continu ; les nouveaux messages sont archivés en SQLite. L'interface se met à jour en direct. |
| **Détection de codes** | Les codes de vérification sont extraits de l'objet et du corps, affichés dans la liste et copiables en un clic. |
| **Import** | Récupère une adresse déjà créée en la déclarant comme adresse personnalisée sur une session neuve. |
| **Changement d'adresse** | Renomme une boîte existante sans perdre les messages déjà archivés. |
| **Export** | Téléchargement XML complet d'une boîte (métadonnées + HTML des messages). |
| **Compte sécurisé** | Hachage scrypt, confirmation d'adresse, TOTP + codes de secours, gestion des sessions, journal d'audit. |
| **Session persistante** | « Rester connecté » : cookie 90 jours prolongé à chaque visite. Pas de reconnexion à répétition. |
| **Rendu des emails** | Shadow DOM isolé, scripts neutralisés, images distantes bloquées par défaut. |

---

## Sécurité

**Comptes**
- Mots de passe hachés avec **scrypt** (N=16384, sel aléatoire, comparaison à temps constant).
- Politique : 10 caractères minimum, majuscule + minuscule + chiffre.
- Confirmation d'adresse obligatoire avant connexion (lien signé, valable 24 h).
- Limitation de débit par IP : inscription, connexion, renvoi d'email.

**Double authentification**
- TOTP standard (SHA-1, 6 chiffres, 30 s), compatible Google Authenticator, Aegis, 1Password.
- 8 codes de secours à usage unique (hachés, consommmés à l'emploi).
- Activation/désactivation confirmée par mot de passe, notification par email.

**Sessions**
- Jeton opaque de 32 octets ; seul son SHA-256 est stocké.
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` automatique en HTTPS (détecté via `X-Forwarded-Proto`).
- **« Rester connecté »** coché par défaut : cookie persistant **90 jours**, prolongé automatiquement
  à chaque visite (aucune reconnexion tant que le site est utilisé). Décoché : cookie de session,
  effacé à la fermeture du navigateur.
- Jeton CSRF par session, exigé sur toutes les mutations (`X-CSRF-Token`).
- Liste des sessions avec IP/agent, révocation à distance, purge au changement de mot de passe.

**Durcissement**
- Requêtes SQL 100 % paramétrées ; en-têtes CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- Les secrets (sessions eztempmail, TOTP, codes de secours) sont chiffrés au repos.
- Emails rendus en Shadow DOM : scripts, iframes, `on*` et `javascript:` supprimés.

---

## Configuration

Tout est optionnel en local : sans variable, l'app utilise SQLite et fonctionne hors ligne.

### Base de données

| Contexte | Moteur | Déclencheur |
|---|---|---|
| Local | SQLite (`node:sqlite`) | aucune variable `DB_*` |
| Wasmer Edge / hébergé | **PostgreSQL** | `DB_HOST` ou `DATABASE_URL` |

Sur Wasmer Edge, `app.yaml` active `capabilities.database: postgres` : la plateforme provisionne
la base et injecte `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`. Le schéma est
créé automatiquement au premier démarrage.

> SQLite natif n'existe pas sur le runtime WebAssembly de Wasmer Edge (pas de binding `sqlite`).
> C'est pourquoi l'import est dynamique : en local il réussit, sur Edge il bascule sur Postgres
> au lieu de faire planter le processus.

### Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` / `HOST` | `4317` / `0.0.0.0` | Écoute HTTP |
| `CIPHER_APP_URL` | déduit | URL publique (liens de confirmation, cookies `Secure`) |
| `CIPHER_SECRET` | généré dans `data/secret.key` | Clé de chiffrement au repos |
| `CIPHER_DATA_DIR` | `./data` | Emplacement de la base SQLite et de l'outbox |
| `CIPHER_SKIP_VERIFICATION` | — | `1` pour désactiver la confirmation d'email (déconseillé) |
| `POLL_INTERVAL_MS` | `8000` | Fréquence de relève des boîtes |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | — | Postgres managé (injecté par la plateforme) |
| `DB_USERNAME` / `DB_PASSWORD` | — | Identifiants Postgres |
| `DATABASE_URL` | — | Alternative complète à `DB_*` |
| `DB_SSL` | `on` | `off` pour désactiver TLS (déconseillé) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | — | Serveur SMTP d'envoi |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | Identifiants et expéditeur |

### Email sans SMTP

Sans SMTP, les messages sortants (confirmation, alertes) sont écrits dans `data/outbox/`, affichés
dans la console, et le lien de confirmation est renvoyé dans la réponse d'inscription — l'app reste
entièrement testable hors ligne.

```powershell
$env:SMTP_HOST="smtp.exemple.com"; $env:SMTP_PORT="587"
$env:SMTP_USER="no-reply@exemple.com"; $env:SMTP_PASS="motdepasse"
$env:SMTP_FROM="Cipher Mail <no-reply@exemple.com>"
npm start
```

---

## Architecture

```
server/
  index.js            routeur HTTP, CSP, desserte des pages, démarrage
  main.js             point d'entrée explicite (plateformes type Wasmer)
  paths.js            chemins + bascule vers un dossier inscriptible
  db.js               Postgres (pg) ou SQLite (node:sqlite) + schéma
  auth.js             sessions, CSRF, limitation de débit, audit
  routes.auth.js      inscription, confirmation, connexion, TOTP, sessions
  routes.mailboxes.js boîtes, messages, export
  sync.js             stockage chiffré, insertion des messages, boucle de relève
  eztempmail.js       client du site (session, création, changement, domaines)
  mailer.js           envoi SMTP natif + templates d'emails
  util.js             scrypt, TOTP, AES-GCM, extraction de codes
  config.js           configuration par variables d'environnement
public/
  landing.html        page d'accueil
  login.html register.html verify.html notfound.html
  app.html            boîte de réception (liste + lecteur)
  assets/css/         base.css · app.css · public.css
  assets/js/          common.js · app.js
data/                 base SQLite, clé, outbox (créé au démarrage)
app.yaml              configuration de déploiement Wasmer Edge
```

## Comment le stockage fonctionne

eztempmail associe une boîte à la **session** (cookie `ez_temp_mail_session`), pas à un mot de passe.
`recover-email` et le lien `go-to-email` ne restaurent pas la boîte de façon fiable.

Cipher Mail conserve donc pour chaque boîte :
1. le cookie jar complet,
2. le jeton CSRF courant,

chiffrés en AES-256-GCM avec `CIPHER_SECRET`. À chaque relève, la session est réouverte, `POST /get_messages`
est appelé et les nouveaux messages (dont le **corps HTML**, fourni directement par l'API) sont insérés en base.
Comme la session est immuable, l'accès survit aux redémarrages et aux fermetures de navigateur.

> Une boîte n'est récupérable que si sa session a été enregistrée au moment de sa création.
> Importer une adresse crée une nouvelle session : elle récupère l'adresse si elle est libre, pas ses anciens messages.

## Raccourcis clavier

`N` nouvelle boîte · `R` actualiser · `/` rechercher · `Échap` fermer le lecteur

---

## Développement

```bash
npm run dev        # redémarrage automatique (node --watch)
```

Les pages sont servies en statique depuis `public/` ; toute la logique est côté serveur (`server/`).
Pour tester hors ligne, aucun SMTP n'est requis : voir [Email sans SMTP](#email-sans-smtp).

## Déploiement (Wasmer Edge)

```bash
wasmer login
wasmer deploy          # lit app.yaml : app « ciphermail », Postgres managé, un volume non requis
```

`app.yaml` demande une base **Postgres** : Wasmer l'injecte via `DB_*`, le schéma se crée tout seul.
Le serveur écoute sur `0.0.0.0:$PORT` et `CIPHER_APP_URL` fixe l'URL publique (liens + cookies `Secure`).

## Licence

MIT.

