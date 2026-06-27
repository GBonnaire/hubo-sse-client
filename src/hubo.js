/**
 * HuboManager
 * Gestion d'une connexion au hub Hubo avec renouvellement automatique de token.
 *
 * Callbacks disponibles (dans options du constructeur) :
 *   onOpen()                          — connexion SSE établie
 *   onMessage(data, event)            — chaque message reçu (event 'message' générique)
 *   on([{ event, handler }])          — écoute d'events nommés spécifiques
 *   onTokenExpired()                  — token expiré (avant renouvellement automatique)
 *   onServerShutdown()                — le hub s'est arrêté
 *   onStatusChange(state, label)      — changement d'état : 'connecting'|'connected'|'disconnected'
 *   onError(error)                    — HuboError (connexion fermée de façon inattendue)
 *
 * Usage :
 *   const hubo = new HuboManager({
 *     hubUrl:    window.HUBO_URL,
 *     tokenUrl:  '/dashboard?token=1',
 *     topics:    ['demo:events'],
 *     token:     window.HUBO_TOKEN,
 *     onOpen:    () => console.log('Connecté'),
 *     onMessage: (data) => console.log(data),
 *     on: [
 *       { event: 'lead.new', handler: (data) => handleLead(data) },
 *     ],
 *     onStatusChange: (state) => badge.dataset.state = state,
 *   });
 *
 *   hubo.connect();
 *
 *   hubo.publish('/publish', ['demo:events'], { hello: 'world' })
 *       .then(id => console.log('Publié, id:', id));
 *
 *   hubo.disconnect();
 *   hubo.destroy();
 */
class HuboManager {
    /**
     * @param {Object}   options
     * @param {string}   options.hubUrl                        URL de base du hub Mercure
     * @param {string}   options.tokenUrl                      URL pour obtenir un token frais (GET, retourne { token })
     * @param {string[]} [options.topics=[]]                   Topics auxquels souscrire
     * @param {string}   [options.token='']                    Token initial
     * @param {boolean}  [options.autoRefreshToken=true]       Renouvellement auto sur token.expired
     * @param {boolean}  [options.disconnectOnNavigation=true] Déconnecte automatiquement sur changement d'URL
     * @param {Function} [options.onOpen=null]                 ()
     * @param {Function} [options.onMessage=null]              (data: any, event: MessageEvent)
     * @param {Array}    [options.on=[]]                       [{ event: string, handler: Function }]
     * @param {Function} [options.onTokenExpired=null]         ()
     * @param {Function} [options.onServerShutdown=null]       ()
     * @param {Function} [options.onStatusChange=null]         (state: string, label: string)
     * @param {Function} [options.onError=null]                (error: HuboError)
     */
    constructor(options = {}) {
        this.hubUrl                 = options.hubUrl                 ?? '';
        this.tokenUrl               = options.tokenUrl               ?? '';
        this.topics                 = options.topics                 ?? [];
        this.autoRefreshToken       = options.autoRefreshToken       ?? true;
        this.disconnectOnNavigation = options.disconnectOnNavigation ?? true;
        this.onOpen                 = options.onOpen                 ?? null;
        this.onMessage              = options.onMessage              ?? null;
        this.on                     = options.on                     ?? [];
        this.onTokenExpired         = options.onTokenExpired         ?? null;
        this.onServerShutdown       = options.onServerShutdown       ?? null;
        this.onStatusChange         = options.onStatusChange         ?? null;
        this.onError                = options.onError                ?? null;

        this._token        = options.token ?? '';
        this._es           = null;
        this._state        = 'disconnected';
        this._closed       = false;
        this._onPopState   = null;
        this._connectionId = null;

        if (this.disconnectOnNavigation) {
            this._bindNavigationEvents();
        }
    }

    // ─────────────────────────────────────────────
    // API publique
    // ─────────────────────────────────────────────

    /**
     * Ouvre la connexion SSE avec le token courant.
     * Si un token est passé en paramètre, il remplace le token stocké.
     * @param {string} [token]
     */
    connect(token) {
        if (token !== undefined) this._token = token;

        if (this._es) this._es.close();

        this._closed = false;
        this._setStatus('connecting', 'Connexion…');

        const url = new URL(this.hubUrl + '/subscribe');
        this.topics.forEach(t => url.searchParams.append('topics', t));
        url.searchParams.set('authorization', this._token);

        const es = new EventSource(url.toString());
        this._es = es;

        es.onopen = () => {
            this._setStatus('connected', 'Connecté');
            if (typeof this.onOpen === 'function') this.onOpen();
        };

        es.addEventListener('connected', (e) => {
            this._connectionId = this._parse(e.data)?.id ?? null;
        });

        if (typeof this.onMessage === 'function') {
            es.onmessage = (e) => this.onMessage(this._parse(e.data), e);
        }

        for (const { event, handler } of this.on) {
            if (typeof handler === 'function') {
                es.addEventListener(event, (e) => handler(this._parse(e.data), e));
            }
        }

        es.addEventListener('token.expired', () => {
            if (typeof this.onTokenExpired === 'function') this.onTokenExpired();
            es.close();
            if (this.autoRefreshToken) this.refreshToken();
        });

        es.addEventListener('server.shutdown', () => {
            this._setStatus('disconnected', 'Déconnecté');
            if (typeof this.onServerShutdown === 'function') this.onServerShutdown();
            es.close();
            this._es = null;
        });

        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) {
                this._es = null;
                if (this._closed) return;
                this._setStatus('disconnected', 'Déconnecté');
                const err = new HuboError('Connexion fermée par le serveur', url.toString());
                if (typeof this.onError === 'function') this.onError(err);
            }
        };
    }

    /**
     * Ferme la connexion manuellement et notifie le serveur.
     */
    disconnect() {
        this._closed = true;
        if (this._es) {
            if (this._connectionId) {
                navigator.sendBeacon(
                    this.hubUrl + '/unsubscribe',
                    new Blob([JSON.stringify({ connectionId: this._connectionId })], { type: 'application/json' })
                );
                this._connectionId = null;
            }
            this._es.close();
            this._es = null;
        }
        this._setStatus('disconnected', 'Déconnecté');
    }

    /**
     * Rafraîchit le token via tokenUrl puis reconnecte.
     * @returns {Promise<void>}
     */
    refreshToken() {
        this._setStatus('connecting', 'Connexion…');
        return fetch(this.tokenUrl)
            .then(r => r.json())
            .then(({ token }) => {
                this._token = token;
                this.connect();
            })
            .catch(() => {
                this._setStatus('disconnected', 'Erreur token');
                const err = new HuboError('Impossible de renouveler le token', this.tokenUrl);
                if (typeof this.onError === 'function') this.onError(err);
            });
    }

    /**
     * Reconnecte en rafraîchissant le token.
     * @returns {Promise<void>}
     */
    reconnect() {
        return this.refreshToken();
    }

    /**
     * Publie un message sur un ou plusieurs topics.
     * @param {string}   publishUrl  URL du endpoint de publication
     * @param {string[]} topics      Topics cibles
     * @param {any}      data        Données à envoyer (sérialisées en JSON)
     * @returns {Promise<string>} Identifiant du message publié
     */
    publish(publishUrl, topics, data) {
        return fetch(publishUrl, {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${this._token}`,
            },
            body:    JSON.stringify({ topics, data }),
        })
            .then(r => r.json())
            .then(res => {
                if (res.id) return res.id;
                throw new HuboError(res.error ?? 'Erreur inconnue', publishUrl);
            });
    }

    /** @returns {'connecting'|'connected'|'disconnected'} État courant de la connexion */
    get state() {
        return this._state;
    }

    /** @returns {string} Token courant */
    get token() {
        return this._token;
    }

    /** Ferme la connexion et libère les ressources. */
    destroy() {
        this._closed = true;
        window.removeEventListener('popstate', this._onPopState);
        if (this._es) {
            if (this._connectionId) {
                navigator.sendBeacon(
                    this.hubUrl + '/unsubscribe',
                    new Blob([JSON.stringify({ connectionId: this._connectionId })], { type: 'application/json' })
                );
                this._connectionId = null;
            }
            this._es.close();
            this._es = null;
        }
    }

    // ─────────────────────────────────────────────
    // Helpers privés
    // ─────────────────────────────────────────────

    /**
     * Met à jour l'état interne et notifie onStatusChange.
     * @param {'connecting'|'connected'|'disconnected'} state
     * @param {string} label
     * @private
     */
    _setStatus(state, label) {
        this._state = state;
        if (typeof this.onStatusChange === 'function') this.onStatusChange(state, label);
    }

    /**
     * Tente un JSON.parse, retourne la chaîne brute si échec.
     * @param {string} raw
     * @returns {any}
     * @private
     */
    _parse(raw) {
        try { return JSON.parse(raw); } catch { return raw; }
    }

    /**
     * Écoute les événements de navigation — même logique que SseManager.
     * @private
     */
    _bindNavigationEvents() {
        this._patchHistoryMethod('pushState');
        this._patchHistoryMethod('replaceState');

        this._onPopState = () => this.disconnect();
        window.addEventListener('popstate', this._onPopState);

        window.addEventListener('hashchange', () => {
            this.disconnect();
        });

        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[href]');
            if (!link) return;

            const href        = link.getAttribute('href');
            const isExternal  = link.hostname !== location.hostname;
            const isDownload  = link.hasAttribute('download');
            const isMailOrTel = /^(mailto|tel):/.test(href);
            const isBlank     = link.target === '_blank';

            if (isExternal || isDownload || isMailOrTel || isBlank) return;

            this.disconnect();
        });
    }

    /**
     * Monkey-patch history.pushState / history.replaceState.
     * @param {'pushState'|'replaceState'} method
     * @private
     */
    _patchHistoryMethod(method) {
        const original = history[method].bind(history);
        history[method] = (...args) => {
            const oldUrl = location.href;
            const result = original(...args);
            const newUrl = location.href;
            if (newUrl !== oldUrl) this.disconnect();
            return result;
        };
    }
}

// ─────────────────────────────────────────────
// Erreur typée
// ─────────────────────────────────────────────

class HuboError extends Error {
    /**
     * @param {string} message
     * @param {string} url     URL concernée (hub ou tokenUrl)
     */
    constructor(message, url) {
        super(message);
        this.name = 'HuboError';
        this.url  = url;
    }
}
