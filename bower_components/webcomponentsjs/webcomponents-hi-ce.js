(function () {
'use strict';

/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
(scope => {

  /********************* base setup *********************/
  const useNative = Boolean('import' in document.createElement('link'));

  // Polyfill `currentScript` for browsers without it.
  let currentScript = null;
  if ('currentScript' in document === false) {
    Object.defineProperty(document, 'currentScript', {
      get() {
        return currentScript ||
          // NOTE: only works when called in synchronously executing code.
          // readyState should check if `loading` but IE10 is
          // interactive when scripts run so we cheat. This is not needed by
          // html-imports polyfill but helps generally polyfill `currentScript`.
          (document.readyState !== 'complete' ?
            document.scripts[document.scripts.length - 1] : null);
      },
      configurable: true
    });
  }

  /**
   * @param {Array|NodeList|NamedNodeMap} list
   * @param {!Function} callback
   * @param {boolean=} inverseOrder
   */
  const forEach = (list, callback, inverseOrder) => {
    const length = list ? list.length : 0;
    const increment = inverseOrder ? -1 : 1;
    let i = inverseOrder ? length - 1 : 0;
    for (; i < length && i >= 0; i = i + increment) {
      callback(list[i], i);
    }
  };

  /********************* path fixup *********************/
  const ABS_URL_TEST = /(^\/)|(^#)|(^[\w-\d]*:)/;
  const CSS_URL_REGEXP = /(url\()([^)]*)(\))/g;
  const CSS_IMPORT_REGEXP = /(@import[\s]+(?!url\())([^;]*)(;)/g;
  const STYLESHEET_REGEXP = /(<link[^>]*)(rel=['|"]?stylesheet['|"]?[^>]*>)/g;

  // path fixup: style elements in imports must be made relative to the main
  // document. We fixup url's in url() and @import.
  const Path = {

    fixUrls(element, base) {
      if (element.href) {
        element.setAttribute('href',
          Path.replaceAttrUrl(element.getAttribute('href'), base));
      }
      if (element.src) {
        element.setAttribute('src',
          Path.replaceAttrUrl(element.getAttribute('src'), base));
      }
      if (element.localName === 'style') {
        const r = Path.replaceUrls(element.textContent, base, CSS_URL_REGEXP);
        element.textContent = Path.replaceUrls(r, base, CSS_IMPORT_REGEXP);
      }
    },

    replaceUrls(text, linkUrl, regexp) {
      return text.replace(regexp, (m, pre, url, post) => {
        let urlPath = url.replace(/["']/g, '');
        if (linkUrl) {
          urlPath = Path.resolveUrl(urlPath, linkUrl);
        }
        return pre + '\'' + urlPath + '\'' + post;
      });
    },

    replaceAttrUrl(text, linkUrl) {
      if (text && ABS_URL_TEST.test(text)) {
        return text;
      } else {
        return Path.resolveUrl(text, linkUrl);
      }
    },

    resolveUrl(url, base) {
      // Lazy feature detection.
      if (Path.__workingURL === undefined) {
        Path.__workingURL = false;
        try {
          const u = new URL('b', 'http://a');
          u.pathname = 'c%20d';
          Path.__workingURL = (u.href === 'http://a/c%20d');
        } catch (e) {}
      }

      if (Path.__workingURL) {
        return (new URL(url, base)).href;
      }

      // Fallback to creating an anchor into a disconnected document.
      let doc = Path.__tempDoc;
      if (!doc) {
        doc = document.implementation.createHTMLDocument('temp');
        Path.__tempDoc = doc;
        doc.__base = doc.createElement('base');
        doc.head.appendChild(doc.__base);
        doc.__anchor = doc.createElement('a');
      }
      doc.__base.href = base;
      doc.__anchor.href = url;
      return doc.__anchor.href || url;
    }
  };

  /********************* Xhr processor *********************/
  const Xhr = {

    async: true,

    /**
     * @param {!string} url
     * @param {!function(!string, string=)} success
     * @param {!function(!string)} fail
     */
    load(url, success, fail) {
      if (!url) {
        fail('error: href must be specified');
      } else if (url.match(/^data:/)) {
        // Handle Data URI Scheme
        const pieces = url.split(',');
        const header = pieces[0];
        let resource = pieces[1];
        if (header.indexOf(';base64') > -1) {
          resource = atob(resource);
        } else {
          resource = decodeURIComponent(resource);
        }
        success(resource);
      } else {
        const request = new XMLHttpRequest();
        request.open('GET', url, Xhr.async);
        request.onload = () => {
          // Servers redirecting an import can add a Location header to help us
          // polyfill correctly. Handle relative and full paths.
          // Prefer responseURL which already resolves redirects
          // https://xhr.spec.whatwg.org/#the-responseurl-attribute
          let redirectedUrl = request.responseURL || request.getResponseHeader('Location');
          if (redirectedUrl && redirectedUrl.indexOf('/') === 0) {
            // In IE location.origin might not work
            // https://connect.microsoft.com/IE/feedback/details/1763802/location-origin-is-undefined-in-ie-11-on-windows-10-but-works-on-windows-7
            const origin = (location.origin || location.protocol + '//' + location.host);
            redirectedUrl = origin + redirectedUrl;
          }
          const resource = /** @type {string} */ (request.response || request.responseText);
          if (request.status === 304 || request.status === 0 ||
            request.status >= 200 && request.status < 300) {
            success(resource, redirectedUrl);
          } else {
            fail(resource);
          }
        };
        request.send();
      }
    }
  };

  /********************* importer *********************/

  const isIE = /Trident/.test(navigator.userAgent) ||
    /Edge\/\d./i.test(navigator.userAgent);

  const importSelector = 'link[rel=import]';

  // Used to disable loading of resources.
  const importDisableType = 'import-disable';

  const disabledLinkSelector = `link[rel=stylesheet][href][type=${importDisableType}]`;

  const importDependenciesSelector = `${importSelector}, ${disabledLinkSelector},
    style:not([type]), link[rel=stylesheet][href]:not([type]),
    script:not([type]), script[type="application/javascript"],
    script[type="text/javascript"]`;

  const importDependencyAttr = 'import-dependency';

  const rootImportSelector = `${importSelector}:not([${importDependencyAttr}])`;

  const pendingScriptsSelector = `script[${importDependencyAttr}]`;

  const pendingStylesSelector = `style[${importDependencyAttr}],
    link[rel=stylesheet][${importDependencyAttr}]`;

  /**
   * Importer will:
   * - load any linked import documents (with deduping)
   * - whenever an import is loaded, prompt the parser to try to parse
   * - observe imported documents for new elements (these are handled via the
   *   dynamic importer)
   */
  class Importer {
    constructor() {
      this.documents = {};
      // Used to keep track of pending loads, so that flattening and firing of
      // events can be done when all resources are ready.
      this.inflight = 0;
      this.dynamicImportsMO = new MutationObserver(m => this.handleMutations(m));
      // Observe changes on <head>.
      this.dynamicImportsMO.observe(document.head, {
        childList: true,
        subtree: true
      });
      // 1. Load imports contents
      // 2. Assign them to first import links on the document
      // 3. Wait for import styles & scripts to be done loading/running
      // 4. Fire load/error events
      this.loadImports(document);
    }

    /**
     * @param {!(HTMLDocument|DocumentFragment|Element)} doc
     */
    loadImports(doc) {
      const links = /** @type {!NodeList<!HTMLLinkElement>} */
        (doc.querySelectorAll(importSelector));
      forEach(links, link => this.loadImport(link));
    }

    /**
     * @param {!HTMLLinkElement} link
     */
    loadImport(link) {
      const url = link.href;
      // This resource is already being handled by another import.
      if (this.documents[url] !== undefined) {
        // If import is already loaded, we can safely associate it to the link
        // and fire the load/error event.
        const imp = this.documents[url];
        if (imp && imp['__loaded']) {
          link.import = imp;
          this.fireEventIfNeeded(link);
        }
        return;
      }
      this.inflight++;
      // Mark it as pending to notify others this url is being loaded.
      this.documents[url] = 'pending';
      Xhr.load(url, (resource, redirectedUrl) => {
        const doc = this.makeDocument(resource, redirectedUrl || url);
        this.documents[url] = doc;
        this.inflight--;
        // Load subtree.
        this.loadImports(doc);
        this.processImportsIfLoadingDone();
      }, () => {
        // If load fails, handle error.
        this.documents[url] = null;
        this.inflight--;
        this.processImportsIfLoadingDone();
      });
    }

    /**
     * Creates a new document containing resource and normalizes urls accordingly.
     * @param {string=} resource
     * @param {string=} url
     * @return {!DocumentFragment}
     */
    makeDocument(resource, url) {
      if (!resource) {
        return document.createDocumentFragment();
      }

      if (isIE) {
        // <link rel=stylesheet> should be appended to <head>. Not doing so
        // in IE/Edge breaks the cascading order. We disable the loading by
        // setting the type before setting innerHTML to avoid loading
        // resources twice.
        resource = resource.replace(STYLESHEET_REGEXP, (match, p1, p2) => {
          if (match.indexOf('type=') === -1) {
            return `${p1} type=${importDisableType} ${p2}`;
          }
          return match;
        });
      }

      let content;
      const template = /** @type {!HTMLTemplateElement} */
        (document.createElement('template'));
      template.innerHTML = resource;
      if (template.content) {
        // This creates issues in Safari10 when used with shadydom (see #12).
        content = template.content;
      } else {
        // <template> not supported, create fragment and move content into it.
        content = document.createDocumentFragment();
        while (template.firstChild) {
          content.appendChild(template.firstChild);
        }
      }

      // Support <base> in imported docs. Resolve url and remove its href.
      const baseEl = content.querySelector('base');
      if (baseEl) {
        url = Path.replaceAttrUrl(baseEl.getAttribute('href'), url);
        baseEl.removeAttribute('href');
      }

      const n$ = /** @type {!NodeList<!(HTMLLinkElement|HTMLScriptElement|HTMLStyleElement)>} */
        (content.querySelectorAll(importDependenciesSelector));
      // For source map hints.
      let inlineScriptIndex = 0;
      forEach(n$, n => {
        // Listen for load/error events, then fix urls.
        whenElementLoaded(n);
        Path.fixUrls(n, url);
        // Mark for easier selectors.
        n.setAttribute(importDependencyAttr, '');
        // Generate source map hints for inline scripts.
        if (n.localName === 'script' && !n.src && n.textContent) {
          const num = inlineScriptIndex ? `-${inlineScriptIndex}` : '';
          const content = n.textContent + `\n//# sourceURL=${url}${num}.js\n`;
          // We use the src attribute so it triggers load/error events, and it's
          // easier to capture errors (e.g. parsing) like this.
          n.setAttribute('src', 'data:text/javascript;charset=utf-8,' + encodeURIComponent(content));
          n.textContent = '';
          inlineScriptIndex++;
        }
      });
      return content;
    }

    /**
     * Waits for loaded imports to finish loading scripts and styles, then fires
     * the load/error events.
     */
    processImportsIfLoadingDone() {
      // Wait until all resources are ready, then load import resources.
      if (this.inflight) return;

      // Stop observing, flatten & load resource, then restart observing <head>.
      this.dynamicImportsMO.disconnect();
      this.flatten(document);
      // We wait for styles to load, and at the same time we execute the scripts,
      // then fire the load/error events for imports to have faster whenReady
      // callback execution.
      // NOTE: This is different for native behavior where scripts would be
      // executed after the styles before them are loaded.
      // To achieve that, we could select pending styles and scripts in the
      // document and execute them sequentially in their dom order.
      let scriptsOk = false,
        stylesOk = false;
      const onLoadingDone = () => {
        if (stylesOk && scriptsOk) {
          // Catch any imports that might have been added while we
          // weren't looking, wait for them as well.
          this.loadImports(document);
          if (this.inflight) return;

          // Restart observing.
          this.dynamicImportsMO.observe(document.head, {
            childList: true,
            subtree: true
          });
          this.fireEvents();
        }
      };
      this.waitForStyles(() => {
        stylesOk = true;
        onLoadingDone();
      });
      this.runScripts(() => {
        scriptsOk = true;
        onLoadingDone();
      });
    }

    /**
     * @param {!HTMLDocument} doc
     */
    flatten(doc) {
      const n$ = /** @type {!NodeList<!HTMLLinkElement>} */
        (doc.querySelectorAll(importSelector));
      forEach(n$, n => {
        const imp = this.documents[n.href];
        n.import = /** @type {!Document} */ (imp);
        if (imp && imp.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
          // We set the .import to be the link itself, and update its readyState.
          // Other links with the same href will point to this link.
          this.documents[n.href] = n;
          n.readyState = 'loading';
          // Suppress Closure warning about incompatible subtype assignment.
          ( /** @type {!HTMLElement} */ (n).import = n);
          this.flatten(imp);
          n.appendChild(imp);
        }
      });
    }

    /**
     * Replaces all the imported scripts with a clone in order to execute them.
     * Updates the `currentScript`.
     * @param {!function()} callback
     */
    runScripts(callback) {
      const s$ = document.querySelectorAll(pendingScriptsSelector);
      const l = s$.length;
      const cloneScript = i => {
        if (i < l) {
          // The pending scripts have been generated through innerHTML and
          // browsers won't execute them for security reasons. We cannot use
          // s.cloneNode(true) either, the only way to run the script is manually
          // creating a new element and copying its attributes.
          const s = s$[i];
          const clone = /** @type {!HTMLScriptElement} */
            (document.createElement('script'));
          // Remove import-dependency attribute to avoid double cloning.
          s.removeAttribute(importDependencyAttr);
          forEach(s.attributes, attr => clone.setAttribute(attr.name, attr.value));
          // Update currentScript and replace original with clone script.
          currentScript = clone;
          s.parentNode.replaceChild(clone, s);
          whenElementLoaded(clone, () => {
            currentScript = null;
            cloneScript(i + 1);
          });
        } else {
          callback();
        }
      };
      cloneScript(0);
    }

    /**
     * Waits for all the imported stylesheets/styles to be loaded.
     * @param {!function()} callback
     */
    waitForStyles(callback) {
      const s$ = /** @type {!NodeList<!(HTMLLinkElement|HTMLStyleElement)>} */
        (document.querySelectorAll(pendingStylesSelector));
      let pending = s$.length;
      if (!pending) {
        callback();
        return;
      }
      // <link rel=stylesheet> should be appended to <head>. Not doing so
      // in IE/Edge breaks the cascading order
      // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/10472273/
      // If there is one <link rel=stylesheet> imported, we must move all imported
      // links and styles to <head>.
      const needsMove = isIE && !!document.querySelector(disabledLinkSelector);
      forEach(s$, s => {
        // Listen for load/error events, remove selector once is done loading.
        whenElementLoaded(s, () => {
          s.removeAttribute(importDependencyAttr);
          if (--pending === 0) {
            callback();
          }
        });
        // Check if was already moved to head, to handle the case where the element
        // has already been moved but it is still loading.
        if (needsMove && s.parentNode !== document.head) {
          // Replace the element we're about to move with a placeholder.
          const placeholder = document.createElement(s.localName);
          // Add reference of the moved element.
          placeholder['__appliedElement'] = s;
          // Disable this from appearing in document.styleSheets.
          placeholder.setAttribute('type', 'import-placeholder');
          // Append placeholder next to the sibling, and move original to <head>.
          s.parentNode.insertBefore(placeholder, s.nextSibling);
          let newSibling = importForElement(s);
          while (newSibling && importForElement(newSibling)) {
            newSibling = importForElement(newSibling);
          }
          if (newSibling.parentNode !== document.head) {
            newSibling = null;
          }
          document.head.insertBefore(s, newSibling);
          // Enable the loading of <link rel=stylesheet>.
          s.removeAttribute('type');
        }
      });
    }

    /**
     * Fires load/error events for imports in the right order .
     */
    fireEvents() {
      const n$ = /** @type {!NodeList<!HTMLLinkElement>} */
        (document.querySelectorAll(importSelector));
      // Inverse order to have events firing bottom-up.
      forEach(n$, n => this.fireEventIfNeeded(n), true);
    }

    /**
     * Fires load/error event for the import if this wasn't done already.
     * @param {!HTMLLinkElement} link
     */
    fireEventIfNeeded(link) {
      // Don't fire twice same event.
      if (!link['__loaded']) {
        link['__loaded'] = true;
        // Update link's import readyState.
        link.import && (link.import.readyState = 'complete');
        const eventType = link.import ? 'load' : 'error';
        link.dispatchEvent(newCustomEvent(eventType, {
          bubbles: false,
          cancelable: false,
          detail: undefined
        }));
      }
    }

    /**
     * @param {Array<MutationRecord>} mutations
     */
    handleMutations(mutations) {
      forEach(mutations, m => forEach(m.addedNodes, elem => {
        if (elem && elem.nodeType === Node.ELEMENT_NODE) {
          // NOTE: added scripts are not updating currentScript in IE.
          if (isImportLink(elem)) {
            this.loadImport( /** @type {!HTMLLinkElement} */ (elem));
          } else {
            this.loadImports( /** @type {!Element} */ (elem));
          }
        }
      }));
    }
  }

  /**
   * @param {!Node} node
   * @return {boolean}
   */
  const isImportLink = node => {
    return node.nodeType === Node.ELEMENT_NODE && node.localName === 'link' &&
      ( /** @type {!HTMLLinkElement} */ (node).rel === 'import');
  };

  /**
   * Waits for an element to finish loading. If already done loading, it will
   * mark the element accordingly.
   * @param {!(HTMLLinkElement|HTMLScriptElement|HTMLStyleElement)} element
   * @param {function()=} callback
   */
  const whenElementLoaded = (element, callback) => {
    if (element['__loaded']) {
      callback && callback();
    } else if ((element.localName === 'script' && !element.src) ||
      (element.localName === 'style' && !element.firstChild)) {
      // Inline scripts and empty styles don't trigger load/error events,
      // consider them already loaded.
      element['__loaded'] = true;
      callback && callback();
    } else {
      const onLoadingDone = event => {
        element.removeEventListener(event.type, onLoadingDone);
        element['__loaded'] = true;
        callback && callback();
      };
      element.addEventListener('load', onLoadingDone);
      // NOTE: We listen only for load events in IE/Edge, because in IE/Edge
      // <style> with @import will fire error events for each failing @import,
      // and finally will trigger the load event when all @import are
      // finished (even if all fail).
      if (!isIE || element.localName !== 'style') {
        element.addEventListener('error', onLoadingDone);
      }
    }
  };

  /**
   * Calls the callback when all imports in the document at call time
   * (or at least document ready) have loaded. Callback is called synchronously
   * if imports are already done loading.
   * @param {function()=} callback
   */
  const whenReady = callback => {
    // 1. ensure the document is in a ready state (has dom), then
    // 2. watch for loading of imports and call callback when done
    whenDocumentReady(() => whenImportsReady(() => callback && callback()));
  };

  /**
   * Invokes the callback when document is in ready state. Callback is called
   *  synchronously if document is already done loading.
   * @param {!function()} callback
   */
  const whenDocumentReady = callback => {
    const stateChanged = () => {
      // NOTE: Firefox can hit readystate interactive without document.body existing.
      // This is anti-spec, but we handle it here anyways by waiting for next change.
      if (document.readyState !== 'loading' && !!document.body) {
        document.removeEventListener('readystatechange', stateChanged);
        callback();
      }
    };
    document.addEventListener('readystatechange', stateChanged);
    stateChanged();
  };

  /**
   * Invokes the callback after all imports are loaded. Callback is called
   * synchronously if imports are already done loading.
   * @param {!function()} callback
   */
  const whenImportsReady = callback => {
    let imports = /** @type {!NodeList<!HTMLLinkElement>} */
      (document.querySelectorAll(rootImportSelector));
    let pending = imports.length;
    if (!pending) {
      callback();
      return;
    }
    forEach(imports, imp => whenElementLoaded(imp, () => {
      if (--pending === 0) {
        callback();
      }
    }));
  };

  /**
   * Returns the import document containing the element.
   * @param {!Node} element
   * @return {HTMLLinkElement|Document|undefined}
   */
  const importForElement = element => {
    if (useNative) {
      // Return only if not in the main doc!
      return element.ownerDocument !== document ? element.ownerDocument : null;
    }
    let doc = element['__importDoc'];
    if (!doc && element.parentNode) {
      doc = /** @type {!Element} */ (element.parentNode);
      if (typeof doc.closest === 'function') {
        // Element.closest returns the element itself if it matches the selector,
        // so we search the closest import starting from the parent.
        doc = doc.closest(importSelector);
      } else {
        // Walk up the parent tree until we find an import.
        while (!isImportLink(doc) && (doc = doc.parentNode)) {}
      }
      element['__importDoc'] = doc;
    }
    return doc;
  };

  const newCustomEvent = (type, params) => {
    if (typeof window.CustomEvent === 'function') {
      return new CustomEvent(type, params);
    }
    const event = /** @type {!CustomEvent} */ (document.createEvent('CustomEvent'));
    event.initCustomEvent(type, Boolean(params.bubbles), Boolean(params.cancelable), params.detail);
    return event;
  };

  if (useNative) {
    // Check for imports that might already be done loading by the time this
    // script is actually executed. Native imports are blocking, so the ones
    // available in the document by this time should already have failed
    // or have .import defined.
    const imps = /** @type {!NodeList<!HTMLLinkElement>} */
      (document.querySelectorAll(importSelector));
    forEach(imps, imp => {
      if (!imp.import || imp.import.readyState !== 'loading') {
        imp['__loaded'] = true;
      }
    });
    // Listen for load/error events to capture dynamically added scripts.
    /**
     * @type {!function(!Event)}
     */
    const onLoadingDone = event => {
      const elem = /** @type {!Element} */ (event.target);
      if (isImportLink(elem)) {
        elem['__loaded'] = true;
      }
    };
    document.addEventListener('load', onLoadingDone, true /* useCapture */ );
    document.addEventListener('error', onLoadingDone, true /* useCapture */ );
  } else {
    // Override baseURI so that imported elements' baseURI can be used seemlessly
    // on native or polyfilled html-imports.
    // NOTE: a <link rel=import> will have `link.baseURI === link.href`, as the link
    // itself is used as the `import` document.
    /** @type {Object|undefined} */
    const native_baseURI = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI');
    // NOTE: if not configurable (e.g. safari9), set it on the Element prototype. 
    const klass = !native_baseURI || native_baseURI.configurable ? Node : Element;
    Object.defineProperty(klass.prototype, 'baseURI', {
      get() {
        const ownerDoc = /** @type {HTMLLinkElement} */ (isImportLink(this) ? this : importForElement(this));
        if (ownerDoc) return ownerDoc.href;
        // Use native baseURI if possible.
        if (native_baseURI && native_baseURI.get) return native_baseURI.get.call(this);
        // Polyfill it if not available.
        const base = /** @type {HTMLBaseElement} */ (document.querySelector('base'));
        return (base || window.location).href;
      },
      configurable: true,
      enumerable: true
    });

    whenDocumentReady(() => new Importer());
  }

  /**
    Add support for the `HTMLImportsLoaded` event and the `HTMLImports.whenReady`
    method. This api is necessary because unlike the native implementation,
    script elements do not force imports to resolve. Instead, users should wrap
    code in either an `HTMLImportsLoaded` handler or after load time in an
    `HTMLImports.whenReady(callback)` call.

    NOTE: This module also supports these apis under the native implementation.
    Therefore, if this file is loaded, the same code can be used under both
    the polyfill and native implementation.
   */
  whenReady(() => document.dispatchEvent(newCustomEvent('HTMLImportsLoaded', {
    cancelable: true,
    bubbles: true,
    detail: undefined
  })));

  // exports
  scope.useNative = useNative;
  scope.whenReady = whenReady;
  scope.importForElement = importForElement;

})(window.HTMLImports = (window.HTMLImports || {}));

const reservedTagList = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
]);

/**
 * @param {string} localName
 * @returns {boolean}
 */
function isValidCustomElementName(localName) {
  const reserved = reservedTagList.has(localName);
  const validForm = /^[a-z][.0-9_a-z]*-[\-.0-9_a-z]*$/.test(localName);
  return !reserved && validForm;
}

/**
 * @private
 * @param {!Node} node
 * @return {boolean}
 */
function isConnected(node) {
  // Use `Node#isConnected`, if defined.
  const nativeValue = node.isConnected;
  if (nativeValue !== undefined) {
    return nativeValue;
  }

  /** @type {?Node|undefined} */
  let current = node;
  while (current && !(current.__CE_isImportDocument || current instanceof Document)) {
    current = current.parentNode || (window.ShadowRoot && current instanceof ShadowRoot ? current.host : undefined);
  }
  return !!(current && (current.__CE_isImportDocument || current instanceof Document));
}

/**
 * @param {!Node} root
 * @param {!Node} start
 * @return {?Node}
 */
function nextSiblingOrAncestorSibling(root, start) {
  let node = start;
  while (node && node !== root && !node.nextSibling) {
    node = node.parentNode;
  }
  return (!node || node === root) ? null : node.nextSibling;
}

/**
 * @param {!Node} root
 * @param {!Node} start
 * @return {?Node}
 */
function nextNode(root, start) {
  return start.firstChild ? start.firstChild : nextSiblingOrAncestorSibling(root, start);
}

/**
 * @param {!Node} root
 * @param {!function(!Element)} callback
 * @param {!Set<Node>=} visitedImports
 */
function walkDeepDescendantElements(root, callback, visitedImports = new Set()) {
  let node = root;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {!Element} */(node);

      callback(element);

      const localName = element.localName;
      if (localName === 'link' && element.getAttribute('rel') === 'import') {
        // If this import (polyfilled or not) has it's root node available,
        // walk it.
        const importNode = /** @type {!Node} */ (element.import);
        if (importNode instanceof Node && !visitedImports.has(importNode)) {
          // Prevent multiple walks of the same import root.
          visitedImports.add(importNode);

          for (let child = importNode.firstChild; child; child = child.nextSibling) {
            walkDeepDescendantElements(child, callback, visitedImports);
          }
        }

        // Ignore descendants of import links to prevent attempting to walk the
        // elements created by the HTML Imports polyfill that we just walked
        // above.
        node = nextSiblingOrAncestorSibling(root, element);
        continue;
      } else if (localName === 'template') {
        // Ignore descendants of templates. There shouldn't be any descendants
        // because they will be moved into `.content` during construction in
        // browsers that support template but, in case they exist and are still
        // waiting to be moved by a polyfill, they will be ignored.
        node = nextSiblingOrAncestorSibling(root, element);
        continue;
      }

      // Walk shadow roots.
      const shadowRoot = element.__CE_shadowRoot;
      if (shadowRoot) {
        for (let child = shadowRoot.firstChild; child; child = child.nextSibling) {
          walkDeepDescendantElements(child, callback, visitedImports);
        }
      }
    }

    node = nextNode(root, node);
  }
}

/**
 * Used to suppress Closure's "Modifying the prototype is only allowed if the
 * constructor is in the same scope" warning without using
 * `@suppress {newCheckTypes, duplicate}` because `newCheckTypes` is too broad.
 *
 * @param {!Object} destination
 * @param {string} name
 * @param {*} value
 */
function setPropertyUnchecked(destination, name, value) {
  destination[name] = value;
}

/**
 * @enum {number}
 */
const CustomElementState = {
  custom: 1,
  failed: 2,
};

class CustomElementInternals {
  constructor() {
    /** @type {!Map<string, !CustomElementDefinition>} */
    this._localNameToDefinition = new Map();

    /** @type {!Map<!Function, !CustomElementDefinition>} */
    this._constructorToDefinition = new Map();

    /** @type {!Array<!function(!Node)>} */
    this._patches = [];

    /** @type {boolean} */
    this._hasPatches = false;
  }

  /**
   * @param {string} localName
   * @param {!CustomElementDefinition} definition
   */
  setDefinition(localName, definition) {
    this._localNameToDefinition.set(localName, definition);
    this._constructorToDefinition.set(definition.constructor, definition);
  }

  /**
   * @param {string} localName
   * @return {!CustomElementDefinition|undefined}
   */
  localNameToDefinition(localName) {
    return this._localNameToDefinition.get(localName);
  }

  /**
   * @param {!Function} constructor
   * @return {!CustomElementDefinition|undefined}
   */
  constructorToDefinition(constructor) {
    return this._constructorToDefinition.get(constructor);
  }

  /**
   * @param {!function(!Node)} listener
   */
  addPatch(listener) {
    this._hasPatches = true;
    this._patches.push(listener);
  }

  /**
   * @param {!Node} node
   */
  patchTree(node) {
    if (!this._hasPatches) return;

    walkDeepDescendantElements(node, element => this.patch(element));
  }

  /**
   * @param {!Node} node
   */
  patch(node) {
    if (!this._hasPatches) return;

    if (node.__CE_patched) return;
    node.__CE_patched = true;

    for (let i = 0; i < this._patches.length; i++) {
      this._patches[i](node);
    }
  }

  /**
   * @param {!Node} root
   */
  connectTree(root) {
    const elements = [];

    walkDeepDescendantElements(root, element => elements.push(element));

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element.__CE_state === CustomElementState.custom) {
        this.connectedCallback(element);
      } else {
        this.upgradeElement(element);
      }
    }
  }

  /**
   * @param {!Node} root
   */
  disconnectTree(root) {
    const elements = [];

    walkDeepDescendantElements(root, element => elements.push(element));

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (element.__CE_state === CustomElementState.custom) {
        this.disconnectedCallback(element);
      }
    }
  }

  /**
   * Upgrades all uncustomized custom elements at and below a root node for
   * which there is a definition. When custom element reaction callbacks are
   * assumed to be called synchronously (which, by the current DOM / HTML spec
   * definitions, they are *not*), callbacks for both elements customized
   * synchronously by the parser and elements being upgraded occur in the same
   * relative order.
   *
   * NOTE: This function, when used to simulate the construction of a tree that
   * is already created but not customized (i.e. by the parser), does *not*
   * prevent the element from reading the 'final' (true) state of the tree. For
   * example, the element, during truly synchronous parsing / construction would
   * see that it contains no children as they have not yet been inserted.
   * However, this function does not modify the tree, the element will
   * (incorrectly) have children. Additionally, self-modification restrictions
   * for custom element constructors imposed by the DOM spec are *not* enforced.
   *
   *
   * The following nested list shows the steps extending down from the HTML
   * spec's parsing section that cause elements to be synchronously created and
   * upgraded:
   *
   * The "in body" insertion mode:
   * https://html.spec.whatwg.org/multipage/syntax.html#parsing-main-inbody
   * - Switch on token:
   *   .. other cases ..
   *   -> Any other start tag
   *      - [Insert an HTML element](below) for the token.
   *
   * Insert an HTML element:
   * https://html.spec.whatwg.org/multipage/syntax.html#insert-an-html-element
   * - Insert a foreign element for the token in the HTML namespace:
   *   https://html.spec.whatwg.org/multipage/syntax.html#insert-a-foreign-element
   *   - Create an element for a token:
   *     https://html.spec.whatwg.org/multipage/syntax.html#create-an-element-for-the-token
   *     - Will execute script flag is true?
   *       - (Element queue pushed to the custom element reactions stack.)
   *     - Create an element:
   *       https://dom.spec.whatwg.org/#concept-create-element
   *       - Sync CE flag is true?
   *         - Constructor called.
   *         - Self-modification restrictions enforced.
   *       - Sync CE flag is false?
   *         - (Upgrade reaction enqueued.)
   *     - Attributes appended to element.
   *       (`attributeChangedCallback` reactions enqueued.)
   *     - Will execute script flag is true?
   *       - (Element queue popped from the custom element reactions stack.
   *         Reactions in the popped stack are invoked.)
   *   - (Element queue pushed to the custom element reactions stack.)
   *   - Insert the element:
   *     https://dom.spec.whatwg.org/#concept-node-insert
   *     - Shadow-including descendants are connected. During parsing
   *       construction, there are no shadow-*excluding* descendants.
   *       However, the constructor may have validly attached a shadow
   *       tree to itself and added descendants to that shadow tree.
   *       (`connectedCallback` reactions enqueued.)
   *   - (Element queue popped from the custom element reactions stack.
   *     Reactions in the popped stack are invoked.)
   *
   * @param {!Node} root
   * @param {{
   *   visitedImports: (!Set<!Node>|undefined),
   *   upgrade: (!function(!Element)|undefined),
   * }=} options
   */
  patchAndUpgradeTree(root, options = {}) {
    const visitedImports = options.visitedImports || new Set();
    const upgrade = options.upgrade || (element => this.upgradeElement(element));

    const elements = [];

    const gatherElements = element => {
      if (element.localName === 'link' && element.getAttribute('rel') === 'import') {
        // The HTML Imports polyfill sets a descendant element of the link to
        // the `import` property, specifically this is *not* a Document.
        const importNode = /** @type {?Node} */ (element.import);

        if (importNode instanceof Node && importNode.readyState === 'complete') {
          importNode.__CE_isImportDocument = true;

          // Connected links are associated with the registry.
          importNode.__CE_hasRegistry = true;
        } else {
          // If this link's import root is not available, its contents can't be
          // walked. Wait for 'load' and walk it when it's ready.
          element.addEventListener('load', () => {
            const importNode = /** @type {!Node} */ (element.import);

            if (importNode.__CE_documentLoadHandled) return;
            importNode.__CE_documentLoadHandled = true;

            importNode.__CE_isImportDocument = true;

            // Connected links are associated with the registry.
            importNode.__CE_hasRegistry = true;

            // Clone the `visitedImports` set that was populated sync during
            // the `patchAndUpgradeTree` call that caused this 'load' handler to
            // be added. Then, remove *this* link's import node so that we can
            // walk that import again, even if it was partially walked later
            // during the same `patchAndUpgradeTree` call.
            const clonedVisitedImports = new Set(visitedImports);
            clonedVisitedImports.delete(importNode);

            this.patchAndUpgradeTree(importNode, {visitedImports: clonedVisitedImports, upgrade});
          });
        }
      } else {
        elements.push(element);
      }
    };

    // `walkDeepDescendantElements` populates (and internally checks against)
    // `visitedImports` when traversing a loaded import.
    walkDeepDescendantElements(root, gatherElements, visitedImports);

    if (this._hasPatches) {
      for (let i = 0; i < elements.length; i++) {
        this.patch(elements[i]);
      }
    }

    for (let i = 0; i < elements.length; i++) {
      upgrade(elements[i]);
    }
  }

  /**
   * @param {!Element} element
   */
  upgradeElement(element) {
    const currentState = element.__CE_state;
    if (currentState !== undefined) return;

    const definition = this.localNameToDefinition(element.localName);
    if (!definition) return;

    definition.constructionStack.push(element);

    const constructor = definition.constructor;
    try {
      try {
        let result = new (constructor)();
        if (result !== element) {
          throw new Error('The custom element constructor did not produce the element being upgraded.');
        }
      } finally {
        definition.constructionStack.pop();
      }
    } catch (e) {
      element.__CE_state = CustomElementState.failed;
      throw e;
    }

    element.__CE_state = CustomElementState.custom;
    element.__CE_definition = definition;

    if (definition.attributeChangedCallback) {
      const observedAttributes = definition.observedAttributes;
      for (let i = 0; i < observedAttributes.length; i++) {
        const name = observedAttributes[i];
        const value = element.getAttribute(name);
        if (value !== null) {
          this.attributeChangedCallback(element, name, null, value, null);
        }
      }
    }

    if (isConnected(element)) {
      this.connectedCallback(element);
    }
  }

  /**
   * @param {!Element} element
   */
  connectedCallback(element) {
    const definition = element.__CE_definition;
    if (definition.connectedCallback) {
      definition.connectedCallback.call(element);
    }
  }

  /**
   * @param {!Element} element
   */
  disconnectedCallback(element) {
    const definition = element.__CE_definition;
    if (definition.disconnectedCallback) {
      definition.disconnectedCallback.call(element);
    }
  }

  /**
   * @param {!Element} element
   * @param {string} name
   * @param {?string} oldValue
   * @param {?string} newValue
   * @param {?string} namespace
   */
  attributeChangedCallback(element, name, oldValue, newValue, namespace) {
    const definition = element.__CE_definition;
    if (
      definition.attributeChangedCallback &&
      definition.observedAttributes.indexOf(name) > -1
    ) {
      definition.attributeChangedCallback.call(element, name, oldValue, newValue, namespace);
    }
  }
}

class DocumentConstructionObserver {
  constructor(internals, doc) {
    /**
     * @type {!CustomElementInternals}
     */
    this._internals = internals;

    /**
     * @type {!Document}
     */
    this._document = doc;

    /**
     * @type {MutationObserver|undefined}
     */
    this._observer = undefined;


    // Simulate tree construction for all currently accessible nodes in the
    // document.
    this._internals.patchAndUpgradeTree(this._document);

    if (this._document.readyState === 'loading') {
      this._observer = new MutationObserver(this._handleMutations.bind(this));

      // Nodes created by the parser are given to the observer *before* the next
      // task runs. Inline scripts are run in a new task. This means that the
      // observer will be able to handle the newly parsed nodes before the inline
      // script is run.
      this._observer.observe(this._document, {
        childList: true,
        subtree: true,
      });
    }
  }

  disconnect() {
    if (this._observer) {
      this._observer.disconnect();
    }
  }

  /**
   * @param {!Array<!MutationRecord>} mutations
   */
  _handleMutations(mutations) {
    // Once the document's `readyState` is 'interactive' or 'complete', all new
    // nodes created within that document will be the result of script and
    // should be handled by patching.
    const readyState = this._document.readyState;
    if (readyState === 'interactive' || readyState === 'complete') {
      this.disconnect();
    }

    for (let i = 0; i < mutations.length; i++) {
      const addedNodes = mutations[i].addedNodes;
      for (let j = 0; j < addedNodes.length; j++) {
        const node = addedNodes[j];
        this._internals.patchAndUpgradeTree(node);
      }
    }
  }
}

/**
 * @template T
 */
class Deferred {
  constructor() {
    /**
     * @private
     * @type {T|undefined}
     */
    this._value = undefined;

    /**
     * @private
     * @type {Function|undefined}
     */
    this._resolve = undefined;

    /**
     * @private
     * @type {!Promise<T>}
     */
    this._promise = new Promise(resolve => {
      this._resolve = resolve;

      if (this._value) {
        resolve(this._value);
      }
    });
  }

  /**
   * @param {T} value
   */
  resolve(value) {
    if (this._value) {
      throw new Error('Already resolved.');
    }

    this._value = value;

    if (this._resolve) {
      this._resolve(value);
    }
  }

  /**
   * @return {!Promise<T>}
   */
  toPromise() {
    return this._promise;
  }
}

/**
 * @unrestricted
 */
class CustomElementRegistry {

  /**
   * @param {!CustomElementInternals} internals
   */
  constructor(internals) {
    /**
     * @private
     * @type {boolean}
     */
    this._elementDefinitionIsRunning = false;

    /**
     * @private
     * @type {!CustomElementInternals}
     */
    this._internals = internals;

    /**
     * @private
     * @type {!Map<string, !Deferred<undefined>>}
     */
    this._whenDefinedDeferred = new Map();

    /**
     * The default flush callback triggers the document walk synchronously.
     * @private
     * @type {!Function}
     */
    this._flushCallback = fn => fn();

    /**
     * @private
     * @type {boolean}
     */
    this._flushPending = false;

    /**
     * @private
     * @type {!Array<!CustomElementDefinition>}
     */
    this._pendingDefinitions = [];

    /**
     * @private
     * @type {!DocumentConstructionObserver}
     */
    this._documentConstructionObserver = new DocumentConstructionObserver(internals, document);
  }

  /**
   * @param {string} localName
   * @param {!Function} constructor
   */
  define(localName, constructor) {
    if (!(constructor instanceof Function)) {
      throw new TypeError('Custom element constructors must be functions.');
    }

    if (!isValidCustomElementName(localName)) {
      throw new SyntaxError(`The element name '${localName}' is not valid.`);
    }

    if (this._internals.localNameToDefinition(localName)) {
      throw new Error(`A custom element with name '${localName}' has already been defined.`);
    }

    if (this._elementDefinitionIsRunning) {
      throw new Error('A custom element is already being defined.');
    }
    this._elementDefinitionIsRunning = true;

    let connectedCallback;
    let disconnectedCallback;
    let adoptedCallback;
    let attributeChangedCallback;
    let observedAttributes;
    try {
      /** @type {!Object} */
      const prototype = constructor.prototype;
      if (!(prototype instanceof Object)) {
        throw new TypeError('The custom element constructor\'s prototype is not an object.');
      }

      function getCallback(name) {
        const callbackValue = prototype[name];
        if (callbackValue !== undefined && !(callbackValue instanceof Function)) {
          throw new Error(`The '${name}' callback must be a function.`);
        }
        return callbackValue;
      }

      connectedCallback = getCallback('connectedCallback');
      disconnectedCallback = getCallback('disconnectedCallback');
      adoptedCallback = getCallback('adoptedCallback');
      attributeChangedCallback = getCallback('attributeChangedCallback');
      observedAttributes = constructor['observedAttributes'] || [];
    } catch (e) {
      return;
    } finally {
      this._elementDefinitionIsRunning = false;
    }

    const definition = {
      localName,
      constructor,
      connectedCallback,
      disconnectedCallback,
      adoptedCallback,
      attributeChangedCallback,
      observedAttributes,
      constructionStack: [],
    };

    this._internals.setDefinition(localName, definition);
    this._pendingDefinitions.push(definition);

    // If we've already called the flush callback and it hasn't called back yet,
    // don't call it again.
    if (!this._flushPending) {
      this._flushPending = true;
      this._flushCallback(() => this._flush());
    }
  }

  _flush() {
    // If no new definitions were defined, don't attempt to flush. This could
    // happen if a flush callback keeps the function it is given and calls it
    // multiple times.
    if (this._flushPending === false) return;
    this._flushPending = false;

    const pendingDefinitions = this._pendingDefinitions;

    /**
     * Unupgraded elements with definitions that were defined *before* the last
     * flush, in document order.
     * @type {!Array<!Element>}
     */
    const elementsWithStableDefinitions = [];

    /**
     * A map from `localName`s of definitions that were defined *after* the last
     * flush to unupgraded elements matching that definition, in document order.
     * @type {!Map<string, !Array<!Element>>}
     */
    const elementsWithPendingDefinitions = new Map();
    for (let i = 0; i < pendingDefinitions.length; i++) {
      elementsWithPendingDefinitions.set(pendingDefinitions[i].localName, []);
    }

    this._internals.patchAndUpgradeTree(document, {
      upgrade: element => {
        // Ignore the element if it has already upgraded or failed to upgrade.
        if (element.__CE_state !== undefined) return;

        const localName = element.localName;

        // If there is an applicable pending definition for the element, add the
        // element to the list of elements to be upgraded with that definition.
        const pendingElements = elementsWithPendingDefinitions.get(localName);
        if (pendingElements) {
          pendingElements.push(element);
        // If there is *any other* applicable definition for the element, add it
        // to the list of elements with stable definitions that need to be upgraded.
        } else if (this._internals.localNameToDefinition(localName)) {
          elementsWithStableDefinitions.push(element);
        }
      },
    });

    // Upgrade elements with 'stable' definitions first.
    for (let i = 0; i < elementsWithStableDefinitions.length; i++) {
      this._internals.upgradeElement(elementsWithStableDefinitions[i]);
    }

    // Upgrade elements with 'pending' definitions in the order they were defined.
    while (pendingDefinitions.length > 0) {
      const definition = pendingDefinitions.shift();
      const localName = definition.localName;

      // Attempt to upgrade all applicable elements.
      const pendingUpgradableElements = elementsWithPendingDefinitions.get(definition.localName);
      for (let i = 0; i < pendingUpgradableElements.length; i++) {
        this._internals.upgradeElement(pendingUpgradableElements[i]);
      }

      // Resolve any promises created by `whenDefined` for the definition.
      const deferred = this._whenDefinedDeferred.get(localName);
      if (deferred) {
        deferred.resolve(undefined);
      }
    }
  }

  /**
   * @param {string} localName
   * @return {Function|undefined}
   */
  get(localName) {
    const definition = this._internals.localNameToDefinition(localName);
    if (definition) {
      return definition.constructor;
    }

    return undefined;
  }

  /**
   * @param {string} localName
   * @return {!Promise<undefined>}
   */
  whenDefined(localName) {
    if (!isValidCustomElementName(localName)) {
      return Promise.reject(new SyntaxError(`'${localName}' is not a valid custom element name.`));
    }

    const prior = this._whenDefinedDeferred.get(localName);
    if (prior) {
      return prior.toPromise();
    }

    const deferred = new Deferred();
    this._whenDefinedDeferred.set(localName, deferred);

    const definition = this._internals.localNameToDefinition(localName);
    // Resolve immediately only if the given local name has a definition *and*
    // the full document walk to upgrade elements with that local name has
    // already happened.
    if (definition && !this._pendingDefinitions.some(d => d.localName === localName)) {
      deferred.resolve(undefined);
    }

    return deferred.toPromise();
  }

  polyfillWrapFlushCallback(outer) {
    this._documentConstructionObserver.disconnect();
    const inner = this._flushCallback;
    this._flushCallback = flush => outer(() => inner(flush));
  }
}

// Closure compiler exports.
window['CustomElementRegistry'] = CustomElementRegistry;
CustomElementRegistry.prototype['define'] = CustomElementRegistry.prototype.define;
CustomElementRegistry.prototype['get'] = CustomElementRegistry.prototype.get;
CustomElementRegistry.prototype['whenDefined'] = CustomElementRegistry.prototype.whenDefined;
CustomElementRegistry.prototype['polyfillWrapFlushCallback'] = CustomElementRegistry.prototype.polyfillWrapFlushCallback;

var Native = {
  Document_createElement: window.Document.prototype.createElement,
  Document_createElementNS: window.Document.prototype.createElementNS,
  Document_importNode: window.Document.prototype.importNode,
  Document_prepend: window.Document.prototype['prepend'],
  Document_append: window.Document.prototype['append'],
  DocumentFragment_prepend: window.DocumentFragment.prototype['prepend'],
  DocumentFragment_append: window.DocumentFragment.prototype['append'],
  Node_cloneNode: window.Node.prototype.cloneNode,
  Node_appendChild: window.Node.prototype.appendChild,
  Node_insertBefore: window.Node.prototype.insertBefore,
  Node_removeChild: window.Node.prototype.removeChild,
  Node_replaceChild: window.Node.prototype.replaceChild,
  Node_textContent: Object.getOwnPropertyDescriptor(window.Node.prototype, 'textContent'),
  Element_attachShadow: window.Element.prototype['attachShadow'],
  Element_innerHTML: Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML'),
  Element_getAttribute: window.Element.prototype.getAttribute,
  Element_setAttribute: window.Element.prototype.setAttribute,
  Element_removeAttribute: window.Element.prototype.removeAttribute,
  Element_getAttributeNS: window.Element.prototype.getAttributeNS,
  Element_setAttributeNS: window.Element.prototype.setAttributeNS,
  Element_removeAttributeNS: window.Element.prototype.removeAttributeNS,
  Element_insertAdjacentElement: window.Element.prototype['insertAdjacentElement'],
  Element_prepend: window.Element.prototype['prepend'],
  Element_append: window.Element.prototype['append'],
  Element_before: window.Element.prototype['before'],
  Element_after: window.Element.prototype['after'],
  Element_replaceWith: window.Element.prototype['replaceWith'],
  Element_remove: window.Element.prototype['remove'],
  HTMLElement: window.HTMLElement,
  HTMLElement_innerHTML: Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerHTML'),
  HTMLElement_insertAdjacentElement: window.HTMLElement.prototype['insertAdjacentElement'],
};

/**
 * This class exists only to work around Closure's lack of a way to describe
 * singletons. It represents the 'already constructed marker' used in custom
 * element construction stacks.
 *
 * https://html.spec.whatwg.org/#concept-already-constructed-marker
 */
class AlreadyConstructedMarker {}

var AlreadyConstructedMarker$1 = new AlreadyConstructedMarker();

/**
 * @param {!CustomElementInternals} internals
 */
var PatchHTMLElement = function(internals) {
  window['HTMLElement'] = (function() {
    /**
     * @type {function(new: HTMLElement): !HTMLElement}
     */
    function HTMLElement() {
      // This should really be `new.target` but `new.target` can't be emulated
      // in ES5. Assuming the user keeps the default value of the constructor's
      // prototype's `constructor` property, this is equivalent.
      /** @type {!Function} */
      const constructor = this.constructor;

      const definition = internals.constructorToDefinition(constructor);
      if (!definition) {
        throw new Error('The custom element being constructed was not registered with `customElements`.');
      }

      const constructionStack = definition.constructionStack;

      if (constructionStack.length === 0) {
        const element = Native.Document_createElement.call(document, definition.localName);
        Object.setPrototypeOf(element, constructor.prototype);
        element.__CE_state = CustomElementState.custom;
        element.__CE_definition = definition;
        internals.patch(element);
        return element;
      }

      const lastIndex = constructionStack.length - 1;
      const element = constructionStack[lastIndex];
      if (element === AlreadyConstructedMarker$1) {
        throw new Error('The HTMLElement constructor was either called reentrantly for this constructor or called multiple times.');
      }
      constructionStack[lastIndex] = AlreadyConstructedMarker$1;

      Object.setPrototypeOf(element, constructor.prototype);
      internals.patch(/** @type {!HTMLElement} */ (element));

      return element;
    }

    HTMLElement.prototype = Native.HTMLElement.prototype;

    return HTMLElement;
  })();
};

/**
 * @param {!CustomElementInternals} internals
 * @param {!Object} destination
 * @param {!ParentNodeNativeMethods} builtIn
 */
var PatchParentNode = function(internals, destination, builtIn) {
  /**
   * @param {!function(...(!Node|string))} builtInMethod
   * @return {!function(...(!Node|string))}
   */
  function appendPrependPatch(builtInMethod) {
    return function(...nodes) {
      /**
       * A copy of `nodes`, with any DocumentFragment replaced by its children.
       * @type {!Array<!Node>}
       */
      const flattenedNodes = [];

      /**
       * Elements in `nodes` that were connected before this call.
       * @type {!Array<!Node>}
       */
      const connectedElements = [];

      for (var i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        if (node instanceof Element && isConnected(node)) {
          connectedElements.push(node);
        }

        if (node instanceof DocumentFragment) {
          for (let child = node.firstChild; child; child = child.nextSibling) {
            flattenedNodes.push(child);
          }
        } else {
          flattenedNodes.push(node);
        }
      }

      builtInMethod.apply(this, nodes);

      for (let i = 0; i < connectedElements.length; i++) {
        internals.disconnectTree(connectedElements[i]);
      }

      if (isConnected(this)) {
        for (let i = 0; i < flattenedNodes.length; i++) {
          const node = flattenedNodes[i];
          if (node instanceof Element) {
            internals.connectTree(node);
          }
        }
      }
    };
  }

  if (builtIn.prepend !== undefined) {
    setPropertyUnchecked(destination, 'prepend', appendPrependPatch(builtIn.prepend));
  }

  if (builtIn.append !== undefined) {
    setPropertyUnchecked(destination, 'append', appendPrependPatch(builtIn.append));
  }
};

/**
 * @param {!CustomElementInternals} internals
 */
var PatchDocument = function(internals) {
  setPropertyUnchecked(Document.prototype, 'createElement',
    /**
     * @this {Document}
     * @param {string} localName
     * @return {!Element}
     */
    function(localName) {
      // Only create custom elements if this document is associated with the registry.
      if (this.__CE_hasRegistry) {
        const definition = internals.localNameToDefinition(localName);
        if (definition) {
          return new (definition.constructor)();
        }
      }

      const result = /** @type {!Element} */
        (Native.Document_createElement.call(this, localName));
      internals.patch(result);
      return result;
    });

  setPropertyUnchecked(Document.prototype, 'importNode',
    /**
     * @this {Document}
     * @param {!Node} node
     * @param {boolean=} deep
     * @return {!Node}
     */
    function(node, deep) {
      const clone = Native.Document_importNode.call(this, node, deep);
      // Only create custom elements if this document is associated with the registry.
      if (!this.__CE_hasRegistry) {
        internals.patchTree(clone);
      } else {
        internals.patchAndUpgradeTree(clone);
      }
      return clone;
    });

  const NS_HTML = "http://www.w3.org/1999/xhtml";

  setPropertyUnchecked(Document.prototype, 'createElementNS',
    /**
     * @this {Document}
     * @param {?string} namespace
     * @param {string} localName
     * @return {!Element}
     */
    function(namespace, localName) {
      // Only create custom elements if this document is associated with the registry.
      if (this.__CE_hasRegistry && (namespace === null || namespace === NS_HTML)) {
        const definition = internals.localNameToDefinition(localName);
        if (definition) {
          return new (definition.constructor)();
        }
      }

      const result = /** @type {!Element} */
        (Native.Document_createElementNS.call(this, namespace, localName));
      internals.patch(result);
      return result;
    });

  PatchParentNode(internals, Document.prototype, {
    prepend: Native.Document_prepend,
    append: Native.Document_append,
  });
};

/**
 * @param {!CustomElementInternals} internals
 */
var PatchDocumentFragment = function(internals) {
  PatchParentNode(internals, DocumentFragment.prototype, {
    prepend: Native.DocumentFragment_prepend,
    append: Native.DocumentFragment_append,
  });
};

/**
 * @param {!CustomElementInternals} internals
 */
var PatchNode = function(internals) {
  // `Node#nodeValue` is implemented on `Attr`.
  // `Node#textContent` is implemented on `Attr`, `Element`.

  setPropertyUnchecked(Node.prototype, 'insertBefore',
    /**
     * @this {Node}
     * @param {!Node} node
     * @param {?Node} refNode
     * @return {!Node}
     */
    function(node, refNode) {
      if (node instanceof DocumentFragment) {
        const insertedNodes = Array.prototype.slice.apply(node.childNodes);
        const nativeResult = Native.Node_insertBefore.call(this, node, refNode);

        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (isConnected(this)) {
          for (let i = 0; i < insertedNodes.length; i++) {
            internals.connectTree(insertedNodes[i]);
          }
        }

        return nativeResult;
      }

      const nodeWasConnected = isConnected(node);
      const nativeResult = Native.Node_insertBefore.call(this, node, refNode);

      if (nodeWasConnected) {
        internals.disconnectTree(node);
      }

      if (isConnected(this)) {
        internals.connectTree(node);
      }

      return nativeResult;
    });

  setPropertyUnchecked(Node.prototype, 'appendChild',
    /**
     * @this {Node}
     * @param {!Node} node
     * @return {!Node}
     */
    function(node) {
      if (node instanceof DocumentFragment) {
        const insertedNodes = Array.prototype.slice.apply(node.childNodes);
        const nativeResult = Native.Node_appendChild.call(this, node);

        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (isConnected(this)) {
          for (let i = 0; i < insertedNodes.length; i++) {
            internals.connectTree(insertedNodes[i]);
          }
        }

        return nativeResult;
      }

      const nodeWasConnected = isConnected(node);
      const nativeResult = Native.Node_appendChild.call(this, node);

      if (nodeWasConnected) {
        internals.disconnectTree(node);
      }

      if (isConnected(this)) {
        internals.connectTree(node);
      }

      return nativeResult;
    });

  setPropertyUnchecked(Node.prototype, 'cloneNode',
    /**
     * @this {Node}
     * @param {boolean=} deep
     * @return {!Node}
     */
    function(deep) {
      const clone = Native.Node_cloneNode.call(this, deep);
      // Only create custom elements if this element's owner document is
      // associated with the registry.
      if (!this.ownerDocument.__CE_hasRegistry) {
        internals.patchTree(clone);
      } else {
        internals.patchAndUpgradeTree(clone);
      }
      return clone;
    });

  setPropertyUnchecked(Node.prototype, 'removeChild',
    /**
     * @this {Node}
     * @param {!Node} node
     * @return {!Node}
     */
    function(node) {
      const nodeWasConnected = isConnected(node);
      const nativeResult = Native.Node_removeChild.call(this, node);

      if (nodeWasConnected) {
        internals.disconnectTree(node);
      }

      return nativeResult;
    });

  setPropertyUnchecked(Node.prototype, 'replaceChild',
    /**
     * @this {Node}
     * @param {!Node} nodeToInsert
     * @param {!Node} nodeToRemove
     * @return {!Node}
     */
    function(nodeToInsert, nodeToRemove) {
      if (nodeToInsert instanceof DocumentFragment) {
        const insertedNodes = Array.prototype.slice.apply(nodeToInsert.childNodes);
        const nativeResult = Native.Node_replaceChild.call(this, nodeToInsert, nodeToRemove);

        // DocumentFragments can't be connected, so `disconnectTree` will never
        // need to be called on a DocumentFragment's children after inserting it.

        if (isConnected(this)) {
          internals.disconnectTree(nodeToRemove);
          for (let i = 0; i < insertedNodes.length; i++) {
            internals.connectTree(insertedNodes[i]);
          }
        }

        return nativeResult;
      }

      const nodeToInsertWasConnected = isConnected(nodeToInsert);
      const nativeResult = Native.Node_replaceChild.call(this, nodeToInsert, nodeToRemove);
      const thisIsConnected = isConnected(this);

      if (thisIsConnected) {
        internals.disconnectTree(nodeToRemove);
      }

      if (nodeToInsertWasConnected) {
        internals.disconnectTree(nodeToInsert);
      }

      if (thisIsConnected) {
        internals.connectTree(nodeToInsert);
      }

      return nativeResult;
    });


  function patch_textContent(destination, baseDescriptor) {
    Object.defineProperty(destination, 'textContent', {
      enumerable: baseDescriptor.enumerable,
      configurable: true,
      get: baseDescriptor.get,
      set: /** @this {Node} */ function(assignedValue) {
        // If this is a text node then there are no nodes to disconnect.
        if (this.nodeType === Node.TEXT_NODE) {
          baseDescriptor.set.call(this, assignedValue);
          return;
        }

        let removedNodes = undefined;
        // Checking for `firstChild` is faster than reading `childNodes.length`
        // to compare with 0.
        if (this.firstChild) {
          // Using `childNodes` is faster than `children`, even though we only
          // care about elements.
          const childNodes = this.childNodes;
          const childNodesLength = childNodes.length;
          if (childNodesLength > 0 && isConnected(this)) {
            // Copying an array by iterating is faster than using slice.
            removedNodes = new Array(childNodesLength);
            for (let i = 0; i < childNodesLength; i++) {
              removedNodes[i] = childNodes[i];
            }
          }
        }

        baseDescriptor.set.call(this, assignedValue);

        if (removedNodes) {
          for (let i = 0; i < removedNodes.length; i++) {
            internals.disconnectTree(removedNodes[i]);
          }
        }
      },
    });
  }

  if (Native.Node_textContent && Native.Node_textContent.get) {
    patch_textContent(Node.prototype, Native.Node_textContent);
  } else {
    internals.addPatch(function(element) {
      patch_textContent(element, {
        enumerable: true,
        configurable: true,
        // NOTE: This implementation of the `textContent` getter assumes that
        // text nodes' `textContent` getter will not be patched.
        get: /** @this {Node} */ function() {
          /** @type {!Array<string>} */
          const parts = [];

          for (let i = 0; i < this.childNodes.length; i++) {
            parts.push(this.childNodes[i].textContent);
          }

          return parts.join('');
        },
        set: /** @this {Node} */ function(assignedValue) {
          while (this.firstChild) {
            Native.Node_removeChild.call(this, this.firstChild);
          }
          Native.Node_appendChild.call(this, document.createTextNode(assignedValue));
        },
      });
    });
  }
};

/**
 * @param {!CustomElementInternals} internals
 * @param {!Object} destination
 * @param {!ChildNodeNativeMethods} builtIn
 */
var PatchChildNode = function(internals, destination, builtIn) {
  /**
   * @param {!function(...(!Node|string))} builtInMethod
   * @return {!function(...(!Node|string))}
   */
  function beforeAfterPatch(builtInMethod) {
    return function(...nodes) {
      /**
       * A copy of `nodes`, with any DocumentFragment replaced by its children.
       * @type {!Array<!Node>}
       */
      const flattenedNodes = [];

      /**
       * Elements in `nodes` that were connected before this call.
       * @type {!Array<!Node>}
       */
      const connectedElements = [];

      for (var i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        if (node instanceof Element && isConnected(node)) {
          connectedElements.push(node);
        }

        if (node instanceof DocumentFragment) {
          for (let child = node.firstChild; child; child = child.nextSibling) {
            flattenedNodes.push(child);
          }
        } else {
          flattenedNodes.push(node);
        }
      }

      builtInMethod.apply(this, nodes);

      for (let i = 0; i < connectedElements.length; i++) {
        internals.disconnectTree(connectedElements[i]);
      }

      if (isConnected(this)) {
        for (let i = 0; i < flattenedNodes.length; i++) {
          const node = flattenedNodes[i];
          if (node instanceof Element) {
            internals.connectTree(node);
          }
        }
      }
    };
  }

  if (builtIn.before !== undefined) {
    setPropertyUnchecked(destination, 'before', beforeAfterPatch(builtIn.before));
  }

  if (builtIn.before !== undefined) {
    setPropertyUnchecked(destination, 'after', beforeAfterPatch(builtIn.after));
  }

  if (builtIn.replaceWith !== undefined) {
    setPropertyUnchecked(destination, 'replaceWith',
      /**
       * @param {...(!Node|string)} nodes
       */
      function(...nodes) {
        /**
         * A copy of `nodes`, with any DocumentFragment replaced by its children.
         * @type {!Array<!Node>}
         */
        const flattenedNodes = [];

        /**
         * Elements in `nodes` that were connected before this call.
         * @type {!Array<!Node>}
         */
        const connectedElements = [];

        for (var i = 0; i < nodes.length; i++) {
          const node = nodes[i];

          if (node instanceof Element && isConnected(node)) {
            connectedElements.push(node);
          }

          if (node instanceof DocumentFragment) {
            for (let child = node.firstChild; child; child = child.nextSibling) {
              flattenedNodes.push(child);
            }
          } else {
            flattenedNodes.push(node);
          }
        }

        const wasConnected = isConnected(this);

        builtIn.replaceWith.apply(this, nodes);

        for (let i = 0; i < connectedElements.length; i++) {
          internals.disconnectTree(connectedElements[i]);
        }

        if (wasConnected) {
          internals.disconnectTree(this);
          for (let i = 0; i < flattenedNodes.length; i++) {
            const node = flattenedNodes[i];
            if (node instanceof Element) {
              internals.connectTree(node);
            }
          }
        }
      });
    }

  if (builtIn.remove !== undefined) {
    setPropertyUnchecked(destination, 'remove',
      function() {
        const wasConnected = isConnected(this);

        builtIn.remove.call(this);

        if (wasConnected) {
          internals.disconnectTree(this);
        }
      });
  }
};

/**
 * @param {!CustomElementInternals} internals
 */
var PatchElement = function(internals) {
  if (Native.Element_attachShadow) {
    setPropertyUnchecked(Element.prototype, 'attachShadow',
      /**
       * @this {Element}
       * @param {!{mode: string}} init
       * @return {ShadowRoot}
       */
      function(init) {
        const shadowRoot = Native.Element_attachShadow.call(this, init);
        this.__CE_shadowRoot = shadowRoot;
        return shadowRoot;
      });
  }


  function patch_innerHTML(destination, baseDescriptor) {
    Object.defineProperty(destination, 'innerHTML', {
      enumerable: baseDescriptor.enumerable,
      configurable: true,
      get: baseDescriptor.get,
      set: /** @this {Element} */ function(htmlString) {
        const isConnected$$1 = isConnected(this);

        // NOTE: In IE11, when using the native `innerHTML` setter, all nodes
        // that were previously descendants of the context element have all of
        // their children removed as part of the set - the entire subtree is
        // 'disassembled'. This work around walks the subtree *before* using the
        // native setter.
        /** @type {!Array<!Element>|undefined} */
        let removedElements = undefined;
        if (isConnected$$1) {
          removedElements = [];
          walkDeepDescendantElements(this, element => {
            if (element !== this) {
              removedElements.push(element);
            }
          });
        }

        baseDescriptor.set.call(this, htmlString);

        if (removedElements) {
          for (let i = 0; i < removedElements.length; i++) {
            const element = removedElements[i];
            if (element.__CE_state === CustomElementState.custom) {
              internals.disconnectedCallback(element);
            }
          }
        }

        // Only create custom elements if this element's owner document is
        // associated with the registry.
        if (!this.ownerDocument.__CE_hasRegistry) {
          internals.patchTree(this);
        } else {
          internals.patchAndUpgradeTree(this);
        }
        return htmlString;
      },
    });
  }

  if (Native.Element_innerHTML && Native.Element_innerHTML.get) {
    patch_innerHTML(Element.prototype, Native.Element_innerHTML);
  } else if (Native.HTMLElement_innerHTML && Native.HTMLElement_innerHTML.get) {
    patch_innerHTML(HTMLElement.prototype, Native.HTMLElement_innerHTML);
  } else {

    /** @type {HTMLDivElement} */
    const rawDiv = Native.Document_createElement.call(document, 'div');

    internals.addPatch(function(element) {
      patch_innerHTML(element, {
        enumerable: true,
        configurable: true,
        // Implements getting `innerHTML` by performing an unpatched `cloneNode`
        // of the element and returning the resulting element's `innerHTML`.
        // TODO: Is this too expensive?
        get: /** @this {Element} */ function() {
          return Native.Node_cloneNode.call(this, true).innerHTML;
        },
        // Implements setting `innerHTML` by creating an unpatched element,
        // setting `innerHTML` of that element and replacing the target
        // element's children with those of the unpatched element.
        set: /** @this {Element} */ function(assignedValue) {
          // NOTE: re-route to `content` for `template` elements.
          // We need to do this because `template.appendChild` does not
          // route into `template.content`.
          /** @type {!Node} */
          const content = this.localName === 'template' ? (/** @type {!HTMLTemplateElement} */ (this)).content : this;
          rawDiv.innerHTML = assignedValue;

          while (content.childNodes.length > 0) {
            Native.Node_removeChild.call(content, content.childNodes[0]);
          }
          while (rawDiv.childNodes.length > 0) {
            Native.Node_appendChild.call(content, rawDiv.childNodes[0]);
          }
        },
      });
    });
  }


  setPropertyUnchecked(Element.prototype, 'setAttribute',
    /**
     * @this {Element}
     * @param {string} name
     * @param {string} newValue
     */
    function(name, newValue) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CustomElementState.custom) {
        return Native.Element_setAttribute.call(this, name, newValue);
      }

      const oldValue = Native.Element_getAttribute.call(this, name);
      Native.Element_setAttribute.call(this, name, newValue);
      newValue = Native.Element_getAttribute.call(this, name);
      internals.attributeChangedCallback(this, name, oldValue, newValue, null);
    });

  setPropertyUnchecked(Element.prototype, 'setAttributeNS',
    /**
     * @this {Element}
     * @param {?string} namespace
     * @param {string} name
     * @param {string} newValue
     */
    function(namespace, name, newValue) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CustomElementState.custom) {
        return Native.Element_setAttributeNS.call(this, namespace, name, newValue);
      }

      const oldValue = Native.Element_getAttributeNS.call(this, namespace, name);
      Native.Element_setAttributeNS.call(this, namespace, name, newValue);
      newValue = Native.Element_getAttributeNS.call(this, namespace, name);
      internals.attributeChangedCallback(this, name, oldValue, newValue, namespace);
    });

  setPropertyUnchecked(Element.prototype, 'removeAttribute',
    /**
     * @this {Element}
     * @param {string} name
     */
    function(name) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CustomElementState.custom) {
        return Native.Element_removeAttribute.call(this, name);
      }

      const oldValue = Native.Element_getAttribute.call(this, name);
      Native.Element_removeAttribute.call(this, name);
      if (oldValue !== null) {
        internals.attributeChangedCallback(this, name, oldValue, null, null);
      }
    });

  setPropertyUnchecked(Element.prototype, 'removeAttributeNS',
    /**
     * @this {Element}
     * @param {?string} namespace
     * @param {string} name
     */
    function(namespace, name) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CustomElementState.custom) {
        return Native.Element_removeAttributeNS.call(this, namespace, name);
      }

      const oldValue = Native.Element_getAttributeNS.call(this, namespace, name);
      Native.Element_removeAttributeNS.call(this, namespace, name);
      // In older browsers, `Element#getAttributeNS` may return the empty string
      // instead of null if the attribute does not exist. For details, see;
      // https://developer.mozilla.org/en-US/docs/Web/API/Element/getAttributeNS#Notes
      const newValue = Native.Element_getAttributeNS.call(this, namespace, name);
      if (oldValue !== newValue) {
        internals.attributeChangedCallback(this, name, oldValue, newValue, namespace);
      }
    });


  function patch_insertAdjacentElement(destination, baseMethod) {
    setPropertyUnchecked(destination, 'insertAdjacentElement',
      /**
       * @this {Element}
       * @param {string} where
       * @param {!Element} element
       * @return {?Element}
       */
      function(where, element) {
        const wasConnected = isConnected(element);
        const insertedElement = /** @type {!Element} */
          (baseMethod.call(this, where, element));

        if (wasConnected) {
          internals.disconnectTree(element);
        }

        if (isConnected(insertedElement)) {
          internals.connectTree(element);
        }
        return insertedElement;
      });
  }

  if (Native.HTMLElement_insertAdjacentElement) {
    patch_insertAdjacentElement(HTMLElement.prototype, Native.HTMLElement_insertAdjacentElement);
  } else if (Native.Element_insertAdjacentElement) {
    patch_insertAdjacentElement(Element.prototype, Native.Element_insertAdjacentElement);
  } else {
    console.warn('Custom Elements: `Element#insertAdjacentElement` was not patched.');
  }


  PatchParentNode(internals, Element.prototype, {
    prepend: Native.Element_prepend,
    append: Native.Element_append,
  });

  PatchChildNode(internals, Element.prototype, {
    before: Native.Element_before,
    after: Native.Element_after,
    replaceWith: Native.Element_replaceWith,
    remove: Native.Element_remove,
  });
};

/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

const priorCustomElements = window['customElements'];

if (!priorCustomElements ||
     priorCustomElements['forcePolyfill'] ||
     (typeof priorCustomElements['define'] != 'function') ||
     (typeof priorCustomElements['get'] != 'function')) {
  /** @type {!CustomElementInternals} */
  const internals = new CustomElementInternals();

  PatchHTMLElement(internals);
  PatchDocument(internals);
  PatchDocumentFragment(internals);
  PatchNode(internals);
  PatchElement(internals);

  // The main document is always associated with the registry.
  document.__CE_hasRegistry = true;

  /** @type {!CustomElementRegistry} */
  const customElements = new CustomElementRegistry(internals);

  Object.defineProperty(window, 'customElements', {
    configurable: true,
    enumerable: true,
    value: customElements,
  });
}

/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

let customElements = window['customElements'];
let HTMLImports = window['HTMLImports'];
// global for (1) existence means `WebComponentsReady` will file,
// (2) WebComponents.ready == true means event has fired.
window.WebComponents = window.WebComponents || {};

if (customElements && customElements['polyfillWrapFlushCallback']) {
  // Here we ensure that the public `HTMLImports.whenReady`
  // always comes *after* custom elements have upgraded.
  let flushCallback;
  let runAndClearCallback = function runAndClearCallback() {
    if (flushCallback) {
      let cb = flushCallback;
      flushCallback = null;
      cb();
      return true;
    }
  };
  let origWhenReady = HTMLImports['whenReady'];
  customElements['polyfillWrapFlushCallback'](function(cb) {
    flushCallback = cb;
    origWhenReady(runAndClearCallback);
  });

  HTMLImports['whenReady'] = function(cb) {
    origWhenReady(function() {
      // custom element code may add dynamic imports
      // to match processing of native custom elements before
      // domContentLoaded, we wait for these imports to resolve first.
      if (runAndClearCallback()) {
        HTMLImports['whenReady'](cb);
      } else {
        cb();
      }
    });
  };

}

HTMLImports['whenReady'](function() {
  requestAnimationFrame(function() {
    window.WebComponents.ready = true;
    document.dispatchEvent(new CustomEvent('WebComponentsReady', {bubbles: true}));
  });
});

/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

// It's desireable to provide a default stylesheet
// that's convenient for styling unresolved elements, but
// it's cumbersome to have to include this manually in every page.
// It would make sense to put inside some HTMLImport but
// the HTMLImports polyfill does not allow loading of stylesheets
// that block rendering. Therefore this injection is tolerated here.
//
// NOTE: position: relative fixes IE's failure to inherit opacity
// when a child is not statically positioned.
let style = document.createElement('style');
style.textContent = ''
    + 'body {'
    + 'transition: opacity ease-in 0.2s;'
    + ' } \n'
    + 'body[unresolved] {'
    + 'opacity: 0; display: block; overflow: hidden; position: relative;'
    + ' } \n'
    ;
let head = document.querySelector('head');
head.insertBefore(style, head.firstChild);

/**
@license
Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/
/*
 * Polyfills loaded: HTML Imports, Custom Elements
 * Used in: Safari 10, Firefox once SD is shipped
 */

}());
