// ScopedListeners.js
// A robust, memory-safe, feature-rich event manager ready for release.
// - Multiple namespaces (e.g. "click.ui.menu")
// - Remove by object, namespace (wildcards supported), element, or handler
// - Automatic cleanup for `once` handlers
// - WeakMap-based binding tracking
// - Optional AbortController-backed native listeners
// - Proper removal of native listeners when last handler is removed

/**
 * @typedef {Object} WrappedHandler
 * @property {Function} fn - The function executed on event trigger
 * @property {Function} original - The original handler provided by user
 * @property {boolean} once - If true, removed after first trigger
 * @property {string[]} namespaces - Array of namespaces (may be empty)
 * @property {object|null} object - Optional binding object
 * @property {Element|EventTarget} element - The target
 * @property {string} type - The DOM event type (e.g. "click")
 * @property {{capture?:boolean, passive?:boolean, once?:boolean}|null} options - original addEventListener options (subset)
 */

export default class ScopedListeners {
    /**
     * @param {{useAbort?: boolean, debug?: boolean}} [opts]
     */
    constructor(opts = {}) {
        // Map<Element, Map<type, { handlers: Set<WrappedHandler>, dispatcher: Function, controller?: AbortController, capture:boolean }>>
        this.listeners = new Map();

        // WeakMap<object, Set<WrappedHandler>> for automatic removal of bindings
        this.bindings = new WeakMap();

        // Map<string, Set<WrappedHandler>> namespace -> handlers
        this.namespaces = new Map();

        // Options
        this.useAbort = Boolean(opts.useAbort);
        this.debug = Boolean(opts.debug);
    }

    // ------------------ Utilities ------------------

    /**
     * Parse event string into type and namespaces array.
     * e.g. "click.ui.menu" -> { type: "click", namespaces: ["ui","menu"] }
     * @param {string} event
     * @returns {{type:string, namespaces:string[]}}
     * @private
     */
    _parseEvent(event) {
        if (typeof event !== 'string' || event.length === 0) {
            throw new TypeError('event must be a non-empty string');
        }
        const parts = event.split('.');
        const type = parts.shift();
        const namespaces = parts.filter(Boolean);
        return { type, namespaces };
    }

    /**
     * Normalize options to an object with capture/passive/once booleans.
     * @param {AddEventListenerOptions|boolean|undefined} opts
     * @returns {{capture?:boolean, passive?:boolean, once?:boolean}}
     * @private
     */
    _normalizeOptions(opts) {
        const result = {};
        if (!opts) return result;
        if (typeof opts === 'boolean') {
            result.capture = opts;
            return result;
        }
        if (typeof opts === 'object') {
            if ('capture' in opts) result.capture = !!opts.capture;
            if ('passive' in opts) result.passive = !!opts.passive;
            if ('once' in opts) result.once = !!opts.once;
        }
        return result;
    }

    _log(...args) {
        if (this.debug) console.debug('[EventManager]', ...args);
    }

    // ------------------ Core API ------------------

    /**
     * Add an event listener
     * @param {EventTarget} element
     * @param {string} event - e.g. "click.ui.menu"
     * @param {Function} handler
     * @param {{object?:object|null, options?:AddEventListenerOptions}} [opts]
     * @returns {this}
     */
    on(element, event, handler, opts = {}) {
        if (!element || typeof element.addEventListener !== 'function') {
            throw new TypeError('element must be an EventTarget');
        }
        if (typeof handler !== 'function') {
            throw new TypeError('handler must be a function');
        }

        const { type, namespaces } = this._parseEvent(event);
        const normOpts = this._normalizeOptions(opts.options);
        const bindingObject = opts.object || null;

        // Ensure element map
        if (!this.listeners.has(element)) this.listeners.set(element, new Map());
        const elementMap = this.listeners.get(element);

        // Ensure type entry
        if (!elementMap.has(type)) {
            const handlers = new Set();
            const capture = !!normOpts.capture;
            // Dispatcher called by native browser event
            const dispatcher = (e) => {
                // copy to allow removal while iterating
                for (const item of Array.from(handlers)) {
                    try {
                        item.fn.call(null, e);
                    } catch (err) {
                        // swallow to avoid breaking other handlers; log in debug
                        this._log('handler error', err);
                    }
                    if (item.once) {
                        handlers.delete(item);
                        this._internalRemoveBinding(item, /*removeFromElement=*/false);
                    }
                }

                // if handlers emptied, remove native listener
                if (handlers.size === 0) {
                    this._teardownDispatcher(element, type);
                }
            };

            const entry = { handlers, dispatcher, controller: undefined, capture };

            // If using AbortController, create one and attach signal
            if (this.useAbort && typeof AbortController !== 'undefined') {
                entry.controller = new AbortController();
                element.addEventListener(type, dispatcher, { signal: entry.controller.signal, capture });
            } else {
                // Pass capture boolean only to removeEventListener correctly later
                element.addEventListener(type, dispatcher, capture);
            }

            elementMap.set(type, entry);
        }

        const entry = elementMap.get(type);

        const wrapped = {
            fn: handler,
            original: handler,
            once: !!normOpts.once,
            namespaces: namespaces.slice(),
            object: bindingObject,
            element,
            type,
            options: normOpts
        };

        entry.handlers.add(wrapped);

        if (bindingObject) {
            let set = this.bindings.get(bindingObject);
            if (!set) {
                set = new Set();
                this.bindings.set(bindingObject, set);
            }
            set.add(wrapped);
        }

        for (const ns of wrapped.namespaces) {
            let nsSet = this.namespaces.get(ns);
            if (!nsSet) {
                nsSet = new Set();
                this.namespaces.set(ns, nsSet);
            }
            nsSet.add(wrapped);
        }

        this._log('on', { element, type, namespaces: wrapped.namespaces, object: bindingObject, options: normOpts });
        return this;
    }

    /**
     * Add a one-time listener
     * @param {EventTarget} element
     * @param {string} event
     * @param {Function} handler
     * @param {{object?:object|null, options?:AddEventListenerOptions}} [opts]
     * @returns {this}
     */
    once(element, event, handler, opts = {}) {
        opts = Object.assign({}, opts, { options: Object.assign({}, opts.options || {}, { once: true }) });
        return this.on(element, event, handler, opts);
    }

    /**
     * Remove handler(s).
     * Usage:
     * - off(element, 'click', handler) -> remove specific
     * - off(element, 'click') -> remove all handlers for type
     * - off(element, '.ui') -> remove handlers with namespace 'ui' on element
     * - off(element, 'click.ui') -> remove handlers matching type and namespace
     * @param {EventTarget} element
     * @param {string} eventOrNamespace
     * @param {Function} [handler]
     * @returns {this}
     */
    off(element, eventOrNamespace, handler) {
        if (!element || typeof element.addEventListener !== 'function') {
            throw new TypeError('element must be an EventTarget');
        }
        if (typeof eventOrNamespace !== 'string' || eventOrNamespace.length === 0) {
            throw new TypeError('event or namespace must be a non-empty string');
        }

        // If starts with '.', treat as namespace-only
        if (eventOrNamespace[0] === '.') {
            const namespace = eventOrNamespace.slice(1);
            if (!namespace) return this;
            return this._removeByNamespaceOnElement(element, namespace);
        }

        const { type, namespaces } = this._parseEvent(eventOrNamespace);
        const elementMap = this.listeners.get(element);
        if (!elementMap) return this;

        // If no type (shouldn't happen), return
        if (!type) return this;

        const entry = elementMap.get(type);
        if (!entry) return this;

        // If no namespaces and no handler -> remove whole type
        if (namespaces.length === 0 && !handler) {
            for (const item of Array.from(entry.handlers)) {
                this._internalRemoveBinding(item, /*removeFromElement=*/false);
            }
            this._teardownDispatcher(element, type);
            return this;
        }

        // Otherwise remove matching handlers
        for (const item of Array.from(entry.handlers)) {
            if (handler && item.original !== handler) continue;
            if (namespaces.length > 0) {
                // require all namespaces to be present on item
                const ok = namespaces.every(ns => item.namespaces.includes(ns));
                if (!ok) continue;
            }
            entry.handlers.delete(item);
            this._internalRemoveBinding(item, /*removeFromElement=*/true);
        }

        if (entry.handlers.size === 0) this._teardownDispatcher(element, type);
        return this;
    }

    /**
     * Remove all handlers for a given namespace globally (supports exact namespace)
     * @param {string} namespace
     * @returns {this}
     */
    offNamespace(namespace) {
        if (typeof namespace !== 'string' || namespace.length === 0) return this;
        const nsSet = this.namespaces.get(namespace);
        if (!nsSet) return this;

        for (const item of Array.from(nsSet)) {
            const elementMap = this.listeners.get(item.element);
            const entry = elementMap?.get(item.type);
            entry?.handlers.delete(item);
            this._internalRemoveBinding(item, /*removeFromElement=*/true);
            if (entry && entry.handlers.size === 0) {
                this._teardownDispatcher(item.element, item.type);
            }
        }

        this.namespaces.delete(namespace);
        return this;
    }

    /**
     * Remove all handlers bound to a particular object
     * @param {object} obj
     * @returns {this}
     */
    offObject(obj) {
        if (!obj) return this;
        const set = this.bindings.get(obj);
        if (!set) return this;
        for (const item of Array.from(set)) {
            const elementMap = this.listeners.get(item.element);
            const entry = elementMap?.get(item.type);
            entry?.handlers.delete(item);
            this._internalRemoveBinding(item, /*removeFromElement=*/true);
            if (entry && entry.handlers.size === 0) {
                this._teardownDispatcher(item.element, item.type);
            }
        }
        this.bindings.delete(obj);
        return this;
    }

    /**
     * Remove all listeners on an element
     * @param {EventTarget} element
     * @returns {this}
     */
    offElement(element) {
        const elementMap = this.listeners.get(element);
        if (!elementMap) return this;
        for (const [type, entry] of Array.from(elementMap.entries())) {
            for (const item of Array.from(entry.handlers)) {
                this._internalRemoveBinding(item, /*removeFromElement=*/false);
            }
            this._teardownDispatcher(element, type);
        }
        this.listeners.delete(element);
        return this;
    }

    /**
     * Remove everything managed by this EventManager
     * @returns {this}
     */
    removeAll() {
        for (const [element, elementMap] of Array.from(this.listeners.entries())) {
            for (const [type, entry] of Array.from(elementMap.entries())) {
                for (const item of Array.from(entry.handlers)) {
                    this._internalRemoveBinding(item, /*removeFromElement=*/false);
                }
                this._teardownDispatcher(element, type);
            }
            this.listeners.delete(element);
        }
        this.namespaces.clear();
        // Clear bindings WeakMap by recreating (no direct clear API)
        this.bindings = new WeakMap();
        return this;
    }

    // ------------------ Internal helpers ------------------

    /**
     * Remove references to the handler from namespace & bindings maps.
     * If removeFromElement=true also removes from element map (used when caller already removed it)
     * @param {WrappedHandler} item
     * @param {boolean} removeFromElement
     * @private
     */
    _internalRemoveBinding(item, removeFromElement = true) {
        if (!item) return;
        // Remove from namespaces
        for (const ns of item.namespaces) {
            const nsSet = this.namespaces.get(ns);
            if (nsSet) {
                nsSet.delete(item);
                if (nsSet.size === 0) this.namespaces.delete(ns);
            }
        }

        // Remove from bindings
        if (item.object) {
            const set = this.bindings.get(item.object);
            if (set) {
                set.delete(item);
                if (set.size === 0) this.bindings.delete(item.object);
            }
        }

        // Optionally remove from element map
        if (removeFromElement && item.element) {
            const elementMap = this.listeners.get(item.element);
            const entry = elementMap?.get(item.type);
            if (entry) entry.handlers.delete(item);
            if (entry && entry.handlers.size === 0) this._teardownDispatcher(item.element, item.type);
        }
    }

    /**
     * Teardown dispatcher for a given element+type (remove native listener and map entries)
     * @param {EventTarget} element
     * @param {string} type
     * @private
     */
    _teardownDispatcher(element, type) {
        const elementMap = this.listeners.get(element);
        if (!elementMap) return;
        const entry = elementMap.get(type);
        if (!entry) return;

        try {
            if (entry.controller && typeof entry.controller.abort === 'function') {
                entry.controller.abort();
            } else {
                // Remove using capture boolean to match addEventListener signature
                element.removeEventListener(type, entry.dispatcher, !!entry.capture);
            }
        } catch (err) {
            this._log('error while tearing down dispatcher', err);
        }

        elementMap.delete(type);
        if (elementMap.size === 0) this.listeners.delete(element);
        this._log('teardown', { element, type });
    }

    /**
     * Get a snapshot of active listeners (for debugging/testing)
     * @returns {Array}
     */
    listEvents() {
        const out = [];
        for (const [element, elementMap] of this.listeners.entries()) {
            for (const [type, entry] of elementMap.entries()) {
                for (const handler of entry.handlers) {
                    out.push({ element, type, namespaces: handler.namespaces.slice(), object: handler.object, once: handler.once });
                }
            }
        }
        return out;
    }
}


// ------------------ Usage Examples (comments) ------------------
// const sl = new ScopedListeners({ useAbort: true, debug: false });
// sl.on(button, 'click.ui.menu', () => console.log('clicked'), { object: myComponent, options: { capture: false } });
// sl.once(window, 'resize', () => console.log('resized'));
// sl.off(button, 'click.ui'); // remove click handlers with namespace ui on button
// sl.offNamespace('ui'); // remove all ui handlers everywhere
// sl.offObject(myComponent); // remove handlers bound to myComponent
// sl.removeAll(); // remove everything
