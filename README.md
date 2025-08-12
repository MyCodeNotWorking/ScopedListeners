# ScopedListeners

ScopedListeners is a lightweight, feature-rich event management library for JavaScript and the DOM.  
It supports event namespaces, object-based grouping, automatic cleanup, one-time listeners, and memory-safe binding via WeakMap or AbortController.

## Features
- **Namespaced events**: e.g., `click.ui.menu`
- **Group removal**: Remove by namespace, object, element, or specific function
- **One-time listeners**: Auto-remove after first call
- **Memory safety**: WeakMap-based tracking, optional AbortController
- **Debug mode**: Logs event bindings and removals

## Installation
```bash
npm install scoped-listeners
```

## Usage
```js
import ScopedListeners from 'scoped-listeners';

const sl = new ScopedListeners({ useAbort: true, debug: true });

// Bind event
sl.on(button, 'click.ui.menu', () => console.log('Clicked'), { object: myComponent });

// One-time listener
sl.once(window, 'resize', () => console.log('Window resized'));

// Remove specific handlers
sl.off(button, 'click.ui');

// Remove all handlers in a namespace
sl.offNamespace('ui');

// Remove handlers bound to an object
sl.offObject(myComponent);

// Inspect active events
console.log(sl.listEvents());

// Remove everything
sl.removeAll();
```

## API

### Constructor
```js
new ScopedListeners({ useAbort = false, debug = false })
```
- `useAbort` (boolean): Use AbortController for automatic cleanup
- `debug` (boolean): Enable console logs for event binding/removal

### Methods
- `.on(element, event, handler, opts)` – Add event listener
- `.once(element, event, handler, opts)` – Add one-time listener
- `.off(element, eventOrNamespace, handler)` – Remove event(s) from element
- `.offNamespace(namespace)` – Remove all events in a namespace
- `.offObject(object)` – Remove all events bound to an object
- `.offElement(element)` – Remove all events from an element
- `.removeAll()` – Remove all listeners globally
- `.listEvents()` – List all active listeners

## License
MIT
