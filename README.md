# hubo-sse-client

Client JavaScript navigateur pour **[Hubo](https://github.com/GBonnaire/hubo-sse)** — un hub Server-Sent Events auto-hébergé et multi-tenant.

Gère la connexion SSE, le renouvellement automatique du token, les listeners d'événements nommés, la déconnexion propre lors de la navigation, et la publication de messages — en un seul fichier sans dépendance (~4 Ko minifié).

---

## Projets associés

| Projet | Description |
|--------|-------------|
| [hubo-sse](https://github.com/GBonnaire/hubo-sse) | Le serveur hub SSE (Node.js / Fastify) |
| [hubo-sse-client-php](https://github.com/GBonnaire/hubo-sse-client-php) | Client PHP backend — génère les tokens subscribe/publish |
| **hubo-sse-client** *(ce dépôt)* | Client JS navigateur |

---

## Démarrage rapide

### 1. Ajouter le script

**Via CDN (unpkg / jsDelivr)**

```html
<script src="https://unpkg.com/hubo-sse-client/dist/hubo.min.js"></script>
```

**Via npm**

```bash
npm install hubo-sse-client
```

```js
import { HuboManager } from 'hubo-sse-client'
// ou, sans bundler :
// <script src="node_modules/hubo-sse-client/dist/hubo.min.js"></script>
```

### 2. Obtenir un token de souscription depuis votre backend

Votre backend (PHP, Node, etc.) signe un JWT avec `mode: "subscribe"` et le transmet au navigateur.

**Exemple PHP (via [hubo-sse-client-php](https://github.com/GBonnaire/hubo-sse-client-php))**

```php
$hubo  = new HuboClient(appId: 'mon-app', secret: 'votre-secret-32-chars-minimum');
$token = $hubo->subscribeToken(topics: ['commandes:*'], ttl: 3600);

// Exposez-le à la page, par exemple via une balise meta ou un endpoint JSON
```

**Exemple Node.js**

```js
import { SignJWT } from 'jose'

const secret = new TextEncoder().encode('votre-secret-32-chars-minimum')
const token  = await new SignJWT({ iss: 'mon-app', mode: 'subscribe', topics: ['commandes:*'] })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(secret)
```

### 3. Se connecter dans le navigateur

```html
<script src="https://unpkg.com/hubo-sse-client/dist/hubo.min.js"></script>
<script>
  const hubo = new HuboManager({
    hubUrl:   'https://hubo.exemple.com',
    tokenUrl: '/api/hubo-token',           // endpoint qui retourne { token }
    topics:   ['commandes:*'],
    token:    '/* token fourni par votre backend */',

    onOpen:    ()     => console.log('Connecté'),
    onMessage: (data) => console.log('Message :', data),

    on: [
      { event: 'commande.expediee', handler: (data) => mettreAJourUI(data) },
    ],

    onStatusChange: (state) => {
      document.getElementById('badge').dataset.state = state
    },

    onError: (err) => console.error(err.message, err.url),
  });

  hubo.connect();
</script>
```

---

## Référence API

### `new HuboManager(options)`

| Option | Type | Défaut | Description |
|--------|------|--------|-------------|
| `hubUrl` | `string` | `''` | URL de base du hub Hubo (ex : `https://hubo.exemple.com`) |
| `tokenUrl` | `string` | `''` | URL appelée pour obtenir un token frais — doit retourner `{ token: string }` |
| `topics` | `string[]` | `[]` | Topics auxquels souscrire |
| `token` | `string` | `''` | JWT de souscription initial |
| `autoRefreshToken` | `boolean` | `true` | Renouvelle automatiquement le token et se reconnecte sur `token.expired` |
| `disconnectOnNavigation` | `boolean` | `true` | Se déconnecte automatiquement lors de la navigation (compatible SPA) |
| `onOpen` | `() => void` | `null` | Appelé à l'ouverture de la connexion SSE |
| `onMessage` | `(data, event) => void` | `null` | Appelé pour chaque message SSE générique (événement `message`) |
| `on` | `Array<{ event: string, handler: (data, event) => void }>` | `[]` | Listeners d'événements nommés |
| `onTokenExpired` | `() => void` | `null` | Appelé juste avant le renouvellement automatique du token |
| `onServerShutdown` | `() => void` | `null` | Appelé quand le hub envoie `server.shutdown` |
| `onStatusChange` | `(state, label) => void` | `null` | Appelé lors des changements d'état : `'connecting'`, `'connected'`, `'disconnected'` |
| `onError` | `(error: HuboError) => void` | `null` | Appelé en cas de fermeture inattendue de la connexion |

---

### Méthodes

#### `hubo.connect(token?)`

Ouvre la connexion SSE. Si `token` est fourni, il remplace le token stocké.

```js
hubo.connect()
hubo.connect(tokenFrais)
```

#### `hubo.disconnect()`

Ferme la connexion proprement et notifie le hub via `POST /unsubscribe`.

```js
hubo.disconnect()
```

#### `hubo.reconnect()`

Récupère un nouveau token via `tokenUrl` puis se reconnecte. Alias de `refreshToken()`.

```js
await hubo.reconnect()
```

#### `hubo.refreshToken()`

Récupère un token frais depuis `tokenUrl` puis se reconnecte. Appelé automatiquement sur `token.expired` quand `autoRefreshToken` est `true`.

```js
await hubo.refreshToken()
```

#### `hubo.publish(publishUrl, topics, data)`

Publie un message sur le hub. Le token courant est envoyé en `Authorization: Bearer <token>` — le token doit avoir `mode: "publish"`.

> **Note de sécurité :** Le token de publication doit être différent du token de souscription. Il est généralement obtenu depuis un endpoint backend protégé et non stocké durablement dans le navigateur.

```js
const id = await hubo.publish('/api/hubo-publish', ['commandes:42:statut'], {
  statut:       'expédié',
  transporteur: 'Colissimo',
})
console.log('Publié, id :', id)
```

| Paramètre | Type | Description |
|-----------|------|-------------|
| `publishUrl` | `string` | URL de l'endpoint de publication (votre backend ou `hubUrl + '/publish'`) |
| `topics` | `string[]` | Topics destinataires |
| `data` | `any` | Données sérialisables en JSON |

Retourne une `Promise<string>` qui se résout avec l'identifiant du message, ou lève une `HuboError`.

#### `hubo.destroy()`

Ferme la connexion, retire tous les listeners de navigation et libère les ressources. À utiliser quand l'instance n'est plus nécessaire (ex : démontage d'un composant).

```js
hubo.destroy()
```

---

### Propriétés

| Propriété | Type | Description |
|-----------|------|-------------|
| `hubo.state` | `'connecting' \| 'connected' \| 'disconnected'` | État courant de la connexion |
| `hubo.token` | `string` | JWT courant |

---

### `HuboError`

Étend `Error` avec une propriété `url` indiquant l'URL concernée par l'erreur.

```js
onError: (err) => {
  console.error(err.name)    // 'HuboError'
  console.error(err.message) // ex : 'Connexion fermée par le serveur'
  console.error(err.url)     // ex : 'https://hubo.exemple.com/subscribe?...'
}
```

---

## Utilisation avancée

### SPA — désactiver la déconnexion automatique à la navigation

Si vous gérez la navigation vous-même (ex : `router.beforeEach` qui appelle `disconnect()`), passez `disconnectOnNavigation: false` :

```js
const hubo = new HuboManager({
  // ...
  disconnectOnNavigation: false,
})

router.beforeEach((to, from, next) => {
  hubo.disconnect()
  next()
})
```

### Renouvellement manuel du token

```js
const hubo = new HuboManager({
  hubUrl:           'https://hubo.exemple.com',
  tokenUrl:         '/api/hubo-token',
  topics:           ['commandes:*'],
  token:            tokenInitial,
  autoRefreshToken: false,        // gérez le renouvellement vous-même

  onTokenExpired: async () => {
    const { token } = await fetch('/api/hubo-token').then(r => r.json())
    hubo.connect(token)
  },
})
```

### Événements nommés

```js
const hubo = new HuboManager({
  hubUrl:  'https://hubo.exemple.com',
  topics:  ['commandes:*', 'alertes'],
  token:   tokenSouscription,

  on: [
    { event: 'commande.expediee',  handler: (data) => afficherExpedition(data) },
    { event: 'commande.annulee',   handler: (data) => afficherAnnulation(data) },
    { event: 'alerte.critique',    handler: (data) => afficherAlerte(data) },
  ],
})

hubo.connect()
```

---

## Génération du token côté serveur

Les tokens doivent être générés **côté serveur**. N'exposez jamais votre `secret` dans le navigateur.

### PHP ([hubo-sse-client-php](https://github.com/GBonnaire/hubo-sse-client-php))

```php
$hubo = new HuboClient(
    appId:  'mon-app',
    secret: 'votre-secret-32-chars-minimum'
);

// Token de souscription
$tokenSouscription = $hubo->subscribeToken(
    topics: ['commandes:*'],
    ttl:    3600
);

// Token de publication
$tokenPublication = $hubo->publishToken(
    topics: ['commandes:*'],
    ttl:    60
);
```

### Node.js

```js
import { SignJWT } from 'jose'

const secret = new TextEncoder().encode('votre-secret-32-chars-minimum')

async function creerToken(mode, topics, ttlSecondes = 3600) {
  return new SignJWT({ iss: 'mon-app', mode, topics })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSecondes)
    .setJti(crypto.randomUUID())
    .sign(secret)
}

// Dans votre route :
app.get('/api/hubo-token', async (req, res) => {
  const token = await creerToken('subscribe', ['commandes:*'])
  res.json({ token })
})
```

---

## Comment ça fonctionne

```
Navigateur                       Votre backend              Hub Hubo
  │                                   │                        │
  │── GET /api/hubo-token ──────────► │                        │
  │◄── { token } ──────────────────── │                        │
  │                                   │                        │
  │── GET /subscribe?topics=…&authorization=<token> ─────────► │
  │◄──────────────── Flux SSE (persistant) ───────────────────  │
  │                                   │                        │
  │         (token.expired)           │                        │
  │── GET /api/hubo-token ──────────► │                        │
  │◄── { token } ──────────────────── │                        │
  │── GET /subscribe (reconnexion) ──────────────────────────► │
  │                                   │                        │
  │── POST /unsubscribe (déconnexion) ──────────────────────── │
```

1. Le navigateur récupère un **token de souscription** depuis votre backend.
2. `HuboManager` ouvre une connexion SSE persistante vers `hubUrl/subscribe`.
3. Le hub envoie un événement `connected` avec un `connectionId` utilisé pour la déconnexion explicite.
4. Sur `token.expired`, le client récupère automatiquement un nouveau token et se reconnecte.
5. À la navigation ou sur appel de `disconnect()`, le client envoie un beacon `POST /unsubscribe` pour que le hub libère les ressources immédiatement.

---

## Compatibilité navigateurs

Fonctionne dans tous les navigateurs supportant [`EventSource`](https://caniuse.com/eventsource) et [`fetch`](https://caniuse.com/fetch) (Chrome 42+, Firefox 53+, Safari 10.1+, Edge 79+). Aucun polyfill ni bundler requis.

---

## Licence

[MIT](./LICENSE) © Guillaume Bonnaire
