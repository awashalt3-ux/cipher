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
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` automatique en HTTPS.
- Jeton CSRF par session, exigé sur toutes les mutations (`X-CSRF-Token`).
- Liste des sessions avec IP/agent, révocation à distance, purge au changement de mot de passe.

**Durcissement**
- Requêtes SQL 100 % paramétrées ; en-têtes CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- Les secrets (sessions eztempmail, TOTP, codes de secours) sont chiffrés au repos.
- Emails rendus en Shadow DOM : scripts, iframes, `on*` et `javascript:` supprimés.

---

## Configuration

Tout est optionnel : sans variable, l'app fonctionne en local.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` / `HOST` | `4317` / `127.0.0.1` | Écoute HTTP |
| `CIPHER_APP_URL` | `http://127.0.0.1:4317` | URL publique (liens de confirmation) |
| `CIPHER_SECRET` | généré dans `data/secret.key` | Clé de chiffrement au repos |
| `CIPHER_DATA_DIR` | `./data` | Emplacement de la base et des fichiers |
| `CIPHER_SKIP_VERIFICATION` | — | `1` pour désactiver la confirmation d'email (déconseillé) |
| `POLL_INTERVAL_MS` | `8000` | Fréquence de relève des boîtes |
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
  index.js            routeur HTTP, CSP, desserte des pages
  db.js               schéma SQLite + helpers (WAL, transactions)
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

## Licence

MIT.

