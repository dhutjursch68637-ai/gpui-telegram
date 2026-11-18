/**
 * MV3 Content-Script DOM/ARIA Agent (`dist/content.js` — bundled as self-contained IIFE).
 * Implements `[ref=eN]` element indexing, CSS selector queries, React 18 `_valueTracker`-safe
 * input typing & form submission, hover/click/scroll/select/key events, wait polling, and
 * non-intrusive visual highlight overlay (`#gpui-agent-highlight-overlay`).
 */

(() => {
  const g = window as unknown as Record<string, any>;
  if (g.__GPUI_DOM_AGENT_INSTALLED__) {
    return;
  }
  g.__GPUI_DOM_AGENT_INSTALLED__ = true;

  const HIGHLIGHT_ID = 'gpui-agent-highlight-overlay';
  const MAX_INTERACTIVE_ELEMENTS = 250;
  let highlightTimer: number | null = null;

  interface DomAgentError {
    ok: false;
    code: number;
    error_code: string;
    error: string;
  }

  function makeError(code: number, errorCode: string, message: string): DomAgentError {
    return { ok: false, code, error_code: errorCode, error: message };
  }

  function clearHighlightOverlay(): void {
    if (highlightTimer !== null) {
      window.clearTimeout(highlightTimer);
      highlightTimer = null;
    }
    const existing = document.getElementById(HIGHLIGHT_ID);
    if (existing) {
      existing.remove();
    }
  }

  function showHighlightOverlay(el: Element, badgeText?: string): void {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return;

      let overlay = document.getElementById(HIGHLIGHT_ID) as HTMLDivElement | null;
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = HIGHLIGHT_ID;
        overlay.className = 'gpui-agent-highlight';
        overlay.setAttribute('data-gpui-highlight', 'true');
        overlay.setAttribute('aria-hidden', 'true');
        (document.documentElement || document.body)?.appendChild(overlay);
      }

      Object.assign(overlay.style, {
        position: 'fixed',
        left: `${Math.max(0, Math.round(rect.left - 2))}px`,
        top: `${Math.max(0, Math.round(rect.top - 2))}px`,
        width: `${Math.round(rect.width + 4)}px`,
        height: `${Math.round(rect.height + 4)}px`,
        border: '2px solid #24a1de',
        backgroundColor: 'rgba(36, 161, 222, 0.10)',
        borderRadius: '4px',
        pointerEvents: 'none',
        zIndex: '2147483646',
        boxSizing: 'border-box',
        transition: 'all 80ms ease-out',
      });

      const refLabel = badgeText || el.getAttribute('data-gpui-ref') || '';
      overlay.setAttribute('data-gpui-target-ref', refLabel);

      if (highlightTimer !== null) {
        window.clearTimeout(highlightTimer);
      }
      highlightTimer = window.setTimeout(() => {
        clearHighlightOverlay();
      }, 1500);
    } catch {
      // Never fail tool execution on cosmetic overlay error
    }
  }

  function isElementVisible(el: Element): boolean {
    const htmlEl = el as HTMLElement;
    if (!el.isConnected) return false;
    if (htmlEl.id === HIGHLIGHT_ID) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buildUniqueSelector(el: Element): string {
    if (el.id && /^[A-Za-z_][A-Za-z0-9_:-]*$/.test(el.id)) {
      return `#${CSS.escape(el.id)}`;
    }
    const tag = el.tagName.toLowerCase();
    const dataSku = el.getAttribute('data-sku');
    if (dataSku) {
      return `${tag}[data-sku="${CSS.escape(dataSku)}"]`;
    }
    const dataTestId = el.getAttribute('data-testid');
    if (dataTestId) {
      return `${tag}[data-testid="${CSS.escape(dataTestId)}"]`;
    }
    const nameAttr = el.getAttribute('name');
    if (nameAttr) {
      return `${tag}[name="${CSS.escape(nameAttr)}"]`;
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length <= 64) {
      return `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
    }

    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && depth < 4) {
      const t = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent: HTMLElement | null = cur.parentElement;
      if (!parent) {
        parts.unshift(t);
        break;
      }
      const sameTagSiblings = Array.from(parent.children).filter(
        (c: Element) => c.tagName === cur!.tagName,
      );
      if (sameTagSiblings.length > 1) {
        const idx = sameTagSiblings.indexOf(cur) + 1;
        parts.unshift(`${t}:nth-of-type(${idx})`);
      } else {
        parts.unshift(t);
      }
      cur = parent;
      depth++;
    }
    return parts.join(' > ') || tag;
  }

  function extractAccessibleLabel(el: Element): string {
    const ariaLabel = el.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute('aria-labelledby')?.trim();
    if (labelledBy) {
      const texts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || '')
        .filter(Boolean);
      if (texts.length > 0) return texts.join(' ');
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.labels && el.labels.length > 0) {
        const lbl = Array.from(el.labels)
          .map((l) => l.textContent?.trim() || '')
          .filter(Boolean)
          .join(' ');
        if (lbl) return lbl;
      }
      if ('placeholder' in el && el.placeholder) {
        return el.placeholder.trim();
      }
    }

    const title = el.getAttribute('title')?.trim();
    if (title) return title;

    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 120);
  }

  function safeQueryAll(selector: string): { ok: true; nodes: Element[] } | DomAgentError {
    if (!selector || typeof selector !== 'string' || !selector.trim()) {
      return makeError(-32602, 'INVALID_SELECTOR', 'CSS selector must be a non-empty string');
    }
    try {
      const nodes = Array.from(document.querySelectorAll(selector));
      return { ok: true, nodes };
    } catch (err: any) {
      return makeError(
        -32602,
        'INVALID_SELECTOR',
        `Invalid CSS selector "${selector}": ${String(err?.message ?? err)}`,
      );
    }
  }

  function resolveTargetElement(args: Record<string, any>): { ok: true; el: Element; ref?: string } | DomAgentError {
    if (typeof args.ref === 'string' && args.ref.trim()) {
      const cleanRef = args.ref.trim().replace(/^\[?ref=/i, '').replace(/\]$/, '');
      const el = document.querySelector(`[data-gpui-ref="${CSS.escape(cleanRef)}"]`);
      if (!el || !el.isConnected) {
        return makeError(
          -32006,
          'ELEMENT_NOT_FOUND',
          `Element for ref "${cleanRef}" is stale, detached, or not found in DOM`,
        );
      }
      return { ok: true, el, ref: cleanRef };
    }

    if (typeof args.selector === 'string' && args.selector.trim()) {
      const q = safeQueryAll(args.selector.trim());
      if (!q.ok) return q;
      const visibleMatch = q.nodes.find((n) => isElementVisible(n)) ?? q.nodes[0];
      if (!visibleMatch || !visibleMatch.isConnected) {
        return makeError(
          -32006,
          'ELEMENT_NOT_FOUND',
          `No element matches selector "${args.selector}"`,
        );
      }
      return {
        ok: true,
        el: visibleMatch,
        ref: visibleMatch.getAttribute('data-gpui-ref') ?? undefined,
      };
    }

    if (typeof args.text === 'string' && args.text.trim()) {
      const needle = args.text.trim().toLowerCase();
      const candidates = Array.from(
        document.querySelectorAll(
          'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"], label, summary, li, span, div',
        ),
      ).filter((el) => isElementVisible(el));

      const exact =
        candidates.find((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === needle) ??
        candidates.find((el) => extractAccessibleLabel(el).toLowerCase() === needle) ??
        candidates.find((el) => (el.textContent ?? '').toLowerCase().includes(needle));

      if (!exact) {
        return makeError(
          -32006,
          'ELEMENT_NOT_FOUND',
          `No visible element matching text "${args.text}"`,
        );
      }
      return { ok: true, el: exact, ref: exact.getAttribute('data-gpui-ref') ?? undefined };
    }

    if (typeof args.x === 'number' && typeof args.y === 'number') {
      const atPoint = document.elementFromPoint(args.x, args.y);
      if (!atPoint) {
        return makeError(
          -32006,
          'ELEMENT_NOT_FOUND',
          `No element found at coordinates (${args.x}, ${args.y})`,
        );
      }
      return { ok: true, el: atPoint, ref: atPoint.getAttribute('data-gpui-ref') ?? undefined };
    }

    return makeError(
      -32602,
      'INVALID_PARAMS',
      'Target element requires one of: ref, selector, text, or x/y coordinates',
    );
  }

  function collectFrameSnapshot(args: Record<string, any>) {
    const startRefIndex = Math.max(1, Number(args.start_ref_index ?? 1));
    const maxElements = Math.min(
      MAX_INTERACTIVE_ELEMENTS,
      Math.max(1, Number(args.max_elements ?? MAX_INTERACTIVE_ELEMENTS)),
    );
    const includeHtml = args.include_html !== false;

    // Clear stale data-gpui-ref markers in this frame before re-indexing
    const oldRefs = document.querySelectorAll('[data-gpui-ref]');
    for (let i = 0; i < oldRefs.length; i++) {
      oldRefs[i]!.removeAttribute('data-gpui-ref');
    }

    const selectorList =
      'a[href], button, input:not([type="hidden"]), textarea, select, summary, ' +
      '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], ' +
      '[role="radio"], [role="switch"], [role="combobox"], [role="textbox"], [role="option"], ' +
      '[contenteditable="true"], [onclick]';

    const rawCandidates = Array.from(document.querySelectorAll(selectorList));
    const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
    const vh = window.innerHeight || document.documentElement?.clientHeight || 800;

    // Prioritize visible in-viewport elements first, then visible below-fold elements
    const scored: Array<{ el: Element; rect: DOMRect; inViewport: boolean }> = [];
    for (const el of rawCandidates) {
      if ((el as HTMLElement).id === HIGHLIGHT_ID) continue;
      if (!isElementVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      const inViewport = rect.bottom >= 0 && rect.top <= vh && rect.right >= 0 && rect.left <= vw;
      scored.push({ el, rect, inViewport });
      if (scored.length >= maxElements * 3) break;
    }

    scored.sort((a, b) => {
      if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
      if (Math.abs(a.rect.top - b.rect.top) > 4) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

    const selected = scored.slice(0, maxElements);
    const interactiveElements = selected.map((item, idx) => {
      const el = item.el;
      const ref = `e${startRefIndex + idx}`;
      el.setAttribute('data-gpui-ref', ref);

      const tag = el.tagName.toLowerCase();
      const inputEl = el as HTMLInputElement;
      const selectEl = el as HTMLSelectElement;
      const anchorEl = el as HTMLAnchorElement;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const label = extractAccessibleLabel(el);

      let value: string | undefined;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        value = el.type === 'password' ? '***' : el.value.slice(0, 200);
      } else if (el instanceof HTMLSelectElement) {
        value = selectEl.value;
      }

      return {
        ref,
        tag,
        type: inputEl.type ? String(inputEl.type).toLowerCase() : undefined,
        role: el.getAttribute('role') || undefined,
        label: label || undefined,
        text: text || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        href: tag === 'a' && anchorEl.href ? anchorEl.href : undefined,
        value,
        checked:
          el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
            ? el.checked
            : undefined,
        disabled: Boolean((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'),
        visible: true,
        selector: buildUniqueSelector(el),
        rect: {
          x: Math.round(item.rect.left),
          y: Math.round(item.rect.top),
          w: Math.round(item.rect.width),
          h: Math.round(item.rect.height),
        },
      };
    });

    const links: Array<{ text: string; href: string }> = [];
    const anchors = document.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length && links.length < 100; i++) {
      const a = anchors[i] as HTMLAnchorElement;
      if (!a.href || a.href.startsWith('javascript:')) continue;
      links.push({
        text: (a.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || a.href,
        href: a.href,
      });
    }

    let html = '';
    if (includeHtml) {
      const rawHtml = document.documentElement?.outerHTML ?? document.body?.innerHTML ?? '';
      html = rawHtml.length > 512_000 ? rawHtml.slice(0, 512_000) : rawHtml;
    }

    return {
      ok: true,
      url: window.location.href,
      title: document.title || '',
      viewport: {
        width: vw,
        height: vh,
        scroll_x: Math.round(window.scrollX || 0),
        scroll_y: Math.round(window.scrollY || 0),
        scroll_width: Math.round(document.documentElement?.scrollWidth || vw),
        scroll_height: Math.round(document.documentElement?.scrollHeight || vh),
      },
      interactive_elements: interactiveElements,
      links,
      html,
    };
  }

  function handleQuerySelector(args: Record<string, any>) {
    const q = safeQueryAll(String(args.selector ?? ''));
    if (!q.ok) return q;
    const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50)));
    const matches = q.nodes.slice(0, limit).map((el) => {
      const rect = el.getBoundingClientRect();
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) {
        if (attr.name !== 'data-gpui-ref') {
          attrs[attr.name] = attr.value.slice(0, 300);
        }
      }
      let value: string | undefined;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        value = el.value;
      }
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: Array.from(el.classList),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
        value,
        visible: isElementVisible(el),
        ref: el.getAttribute('data-gpui-ref') || undefined,
        attributes: attrs,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    });

    return {
      ok: true,
      selector: String(args.selector),
      count: q.nodes.length,
      matches,
    };
  }

  async function handleClick(args: Record<string, any>) {
    const target = resolveTargetElement(args);
    if (!target.ok) return target;

    const el = target.el as HTMLElement;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    } catch {
      el.scrollIntoView();
    }

    showHighlightOverlay(el, target.ref);

    const rect = el.getBoundingClientRect();
    const clientX = typeof args.x === 'number' ? args.x : rect.left + rect.width / 2;
    const clientY = typeof args.y === 'number' ? args.y : rect.top + rect.height / 2;
    const buttonCode = args.button === 'right' ? 2 : args.button === 'middle' ? 1 : 0;

    const mouseInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: buttonCode,
      buttons: 1,
    };

    el.dispatchEvent(new PointerEvent('pointerover', mouseInit));
    el.dispatchEvent(new MouseEvent('mouseover', mouseInit));
    el.dispatchEvent(new PointerEvent('pointerdown', mouseInit));
    el.dispatchEvent(new MouseEvent('mousedown', mouseInit));
    if (typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }
    el.dispatchEvent(new PointerEvent('pointerup', mouseInit));
    el.dispatchEvent(new MouseEvent('mouseup', mouseInit));

    if (buttonCode === 2) {
      el.dispatchEvent(new MouseEvent('contextmenu', mouseInit));
    } else if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', mouseInit));
    }

    if (args.double_click) {
      el.dispatchEvent(new MouseEvent('dblclick', mouseInit));
    }

    const anchor = el.closest('a[href]') as HTMLAnchorElement | null;
    const rawHref = anchor?.getAttribute('href')?.trim() ?? '';
    const isLinkNav =
      Boolean(anchor && rawHref) &&
      !rawHref.startsWith('#') &&
      !rawHref.toLowerCase().startsWith('javascript:');
    const isSubmitControl =
      (el instanceof HTMLButtonElement && el.type === 'submit') ||
      (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'image'));
    const mightNavigate = buttonCode !== 2 && (isLinkNav || isSubmitControl);

    if (!mightNavigate) {
      await new Promise((r) => setTimeout(r, 30));
    }

    return {
      ok: true,
      ref: target.ref ?? null,
      tag: el.tagName.toLowerCase(),
      will_navigate: mightNavigate,
      url_after: window.location.href,
      title_after: document.title || '',
    };
  }

  function handleHover(args: Record<string, any>) {
    const target = resolveTargetElement(args);
    if (!target.ok) return target;

    const el = target.el as HTMLElement;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    } catch {
      el.scrollIntoView();
    }

    showHighlightOverlay(el, target.ref);

    const rect = el.getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };

    el.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointerover', init));
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new PointerEvent('pointermove', init));
    el.dispatchEvent(new MouseEvent('mousemove', init));

    return {
      ok: true,
      ref: target.ref ?? null,
      tag: el.tagName.toLowerCase(),
    };
  }

  async function handleType(args: Record<string, any>) {
    const target = resolveTargetElement(args);
    if (!target.ok) return target;

    const el = target.el as HTMLElement;
    const text = String(args.text ?? '');
    const clearFirst = args.clear_first !== false;
    const shouldSubmit = Boolean(args.submit || args.press_enter);

    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    } catch {
      el.scrollIntoView();
    }

    showHighlightOverlay(el, target.ref);
    if (typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }

    let finalValue = text;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const previousValue = el.value;
      finalValue = clearFirst ? text : previousValue + text;

      const proto =
        el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

      if (nativeValueSetter) {
        nativeValueSetter.call(el, finalValue);
      } else {
        el.value = finalValue;
      }

      // Sync React 16/17/18 _valueTracker so synthetic onChange always fires
      const tracker = (el as unknown as { _valueTracker?: { setValue?: (v: string) => void } })
        ._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') {
        tracker.setValue(previousValue === finalValue ? '' : previousValue);
      }

      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          composed: true,
          data: text,
          inputType: 'insertText',
        }),
      );
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: false }));
    } else if (el.isContentEditable) {
      finalValue = clearFirst ? text : (el.textContent ?? '') + text;
      el.textContent = finalValue;
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          data: text,
          inputType: 'insertText',
        }),
      );
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      return makeError(
        -32602,
        'INVALID_PARAMS',
        `Target element <${el.tagName.toLowerCase()}> is not an input, textarea, or contenteditable`,
      );
    }

    let willNavigate = false;
    if (shouldSubmit) {
      const enterInit: KeyboardEventInit = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', enterInit));
      el.dispatchEvent(new KeyboardEvent('keypress', enterInit));
      el.dispatchEvent(new KeyboardEvent('keyup', enterInit));

      const form = (el as HTMLInputElement).form ?? el.closest('form');
      if (form) {
        willNavigate = true;
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    return {
      ok: true,
      ref: target.ref ?? null,
      value_length: finalValue.length,
      submitted: shouldSubmit,
      will_navigate: willNavigate,
    };
  }

  function handlePressKey(args: Record<string, any>) {
    const rawKey = String(args.key ?? '').trim();
    if (!rawKey) {
      return makeError(-32602, 'INVALID_PARAMS', 'Missing non-empty "key" argument');
    }

    const parts = rawKey.split('+').map((s) => s.trim()).filter(Boolean);
    const modList = Array.isArray(args.modifiers) ? args.modifiers.map(String) : [];

    let ctrlKey = false;
    let altKey = false;
    let shiftKey = false;
    let metaKey = false;
    let mainKey = rawKey;

    const allMods = [...modList, ...(parts.length > 1 ? parts.slice(0, -1) : [])];
    if (parts.length > 1) {
      mainKey = parts[parts.length - 1]!;
    }

    for (const m of allMods) {
      const lower = m.toLowerCase();
      if (lower === 'control' || lower === 'ctrl') ctrlKey = true;
      else if (lower === 'alt' || lower === 'option') altKey = true;
      else if (lower === 'shift') shiftKey = true;
      else if (lower === 'meta' || lower === 'cmd' || lower === 'command') metaKey = true;
    }

    const code =
      mainKey.length === 1 && /^[a-zA-Z]$/.test(mainKey)
        ? `Key${mainKey.toUpperCase()}`
        : mainKey.length === 1 && /^[0-9]$/.test(mainKey)
          ? `Digit${mainKey}`
          : mainKey;

    const keyInit: KeyboardEventInit = {
      key: mainKey,
      code,
      ctrlKey,
      altKey,
      shiftKey,
      metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
    };

    const target = (document.activeElement as HTMLElement | null) ?? document.body ?? document.documentElement;
    target?.dispatchEvent(new KeyboardEvent('keydown', keyInit));
    target?.dispatchEvent(new KeyboardEvent('keyup', keyInit));

    return {
      ok: true,
      key: mainKey,
      chord: rawKey,
    };
  }

  function handleSelectOption(args: Record<string, any>) {
    const target = resolveTargetElement(args);
    if (!target.ok) return target;

    if (!(target.el instanceof HTMLSelectElement)) {
      return makeError(
        -32602,
        'INVALID_PARAMS',
        `Target element <${target.el.tagName.toLowerCase()}> is not a <select>`,
      );
    }

    const selectEl = target.el;
    const desiredValue = typeof args.value === 'string' ? args.value : undefined;
    const desiredLabel = typeof args.label === 'string' ? args.label.trim() : undefined;

    const options = Array.from(selectEl.options);
    const matched = options.find((opt) => {
      if (desiredValue !== undefined && opt.value === desiredValue) return true;
      if (desiredLabel !== undefined) {
        const optLabel = (opt.label || opt.textContent || '').trim();
        if (optLabel === desiredLabel || optLabel.toLowerCase() === desiredLabel.toLowerCase()) {
          return true;
        }
      }
      if (desiredValue !== undefined) {
        const optText = (opt.textContent || '').trim();
        if (optText === desiredValue) return true;
      }
      return false;
    });

    if (!matched) {
      return makeError(
        -32006,
        'ELEMENT_NOT_FOUND',
        `Option not found in <select> (value=${desiredValue ?? ''}, label=${desiredLabel ?? ''})`,
      );
    }

    const previousValue = selectEl.value;
    showHighlightOverlay(selectEl, target.ref);

    const nativeSelectSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )?.set;
    matched.selected = true;
    if (nativeSelectSetter) {
      nativeSelectSetter.call(selectEl, matched.value);
    } else {
      selectEl.value = matched.value;
    }

    const tracker = (selectEl as unknown as { _valueTracker?: { setValue?: (v: string) => void } })
      ._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue(previousValue);
    }

    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      ok: true,
      ref: target.ref ?? null,
      selected_value: selectEl.value,
      selected_label: (matched.label || matched.textContent || '').trim(),
    };
  }

  function handleScroll(args: Record<string, any>) {
    if (args.ref || args.selector) {
      const target = resolveTargetElement(args);
      if (!target.ok) return target;
      try {
        target.el.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'instant' as ScrollBehavior,
        });
      } catch {
        target.el.scrollIntoView();
      }
      showHighlightOverlay(target.el, target.ref);
    } else {
      const direction = String(args.direction ?? 'down').toLowerCase();
      const amount = Math.max(1, Number(args.amount_px ?? args.amount ?? 500));
      const maxScroll = Math.max(
        0,
        (document.documentElement?.scrollHeight || document.body?.scrollHeight || 0) -
          (window.innerHeight || 0),
      );
      if (direction === 'top') {
        window.scrollTo(0, 0);
      } else if (direction === 'bottom') {
        window.scrollTo(0, maxScroll + 1000);
      } else if (direction === 'up') {
        window.scrollBy(0, -amount);
      } else {
        window.scrollBy(0, amount);
      }
    }

    const vpWidth = Math.round(window.innerWidth || document.documentElement?.clientWidth || 0);
    const vpHeight = Math.round(window.innerHeight || document.documentElement?.clientHeight || 0);
    const scrollX = Math.round(window.scrollX || 0);
    const scrollY = Math.round(window.scrollY || 0);
    const scrollWidth = Math.round(
      document.documentElement?.scrollWidth || document.body?.scrollWidth || vpWidth,
    );
    const scrollHeight = Math.round(
      document.documentElement?.scrollHeight || document.body?.scrollHeight || vpHeight,
    );
    const maxScrollY = Math.max(0, scrollHeight - vpHeight);
    return {
      ok: true,
      scroll_x: scrollX,
      scroll_y: scrollY,
      max_scroll_y: Math.round(maxScrollY),
      viewport: {
        width: vpWidth,
        height: vpHeight,
        scroll_x: scrollX,
        scroll_y: scrollY,
        scroll_width: scrollWidth,
        scroll_height: scrollHeight,
      },
    };
  }

  function checkWaitCondition(args: Record<string, any>) {
    if (typeof args.url_includes === 'string' && args.url_includes.length > 0) {
      if (!window.location.href.includes(args.url_includes)) {
        return { ok: true, matched: false };
      }
    }

    if (typeof args.selector === 'string' && args.selector.trim()) {
      const q = safeQueryAll(args.selector.trim());
      if (!q.ok) return q;
      const state = String(args.state ?? 'visible').toLowerCase();
      if (state === 'hidden') {
        const anyVisible = q.nodes.some((n) => isElementVisible(n));
        if (anyVisible) return { ok: true, matched: false };
      } else if (state === 'attached') {
        if (q.nodes.length === 0) return { ok: true, matched: false };
      } else {
        const visibleEl = q.nodes.find((n) => isElementVisible(n));
        if (!visibleEl) return { ok: true, matched: false };
      }
    }

    if (typeof args.text === 'string' && args.text.length > 0) {
      const bodyText = `${document.body?.innerText ?? ''}\n${document.documentElement?.textContent ?? ''}`;
      if (!bodyText.includes(args.text)) {
        return { ok: true, matched: false };
      }
    }

    return {
      ok: true,
      matched: true,
      url: window.location.href,
      title: document.title || '',
    };
  }

  function handleGetElementRect(args: Record<string, any>) {
    const target = resolveTargetElement(args);
    if (!target.ok) return target;
    const rect = target.el.getBoundingClientRect();
    return {
      ok: true,
      rect: {
        x: Math.max(0, rect.left + window.scrollX),
        y: Math.max(0, rect.top + window.scrollY),
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
        scale: 1,
      },
    };
  }

  function handleGetPerformanceResources() {
    const entries = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).slice(-200);
    return {
      ok: true,
      entries: entries.map((e) => ({
        url: e.name,
        initiator_type: e.initiatorType,
        status: (e as unknown as { responseStatus?: number }).responseStatus ?? 200,
        duration_ms: Math.round(e.duration),
        timestamp_ms: Math.round(performance.timeOrigin + e.startTime),
      })),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || msg.target !== 'gpui_dom_agent') {
      return undefined;
    }

    const action = String(msg.action ?? '');
    const args = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, any>;

    const run = async () => {
      switch (action) {
        case 'ping':
          return { ok: true, url: window.location.href, title: document.title || '' };
        case 'collect_frame_snapshot':
          return collectFrameSnapshot(args);
        case 'query_selector':
          return handleQuerySelector(args);
        case 'click':
          return await handleClick(args);
        case 'hover':
          return handleHover(args);
        case 'type':
          return await handleType(args);
        case 'press_key':
          return handlePressKey(args);
        case 'select_option':
          return handleSelectOption(args);
        case 'scroll':
          return handleScroll(args);
        case 'check_wait_condition':
          return checkWaitCondition(args);
        case 'get_element_rect':
          return handleGetElementRect(args);
        case 'get_performance_resources':
          return handleGetPerformanceResources();
        case 'clear_highlights':
          clearHighlightOverlay();
          return { ok: true };
        default:
          return makeError(-32601, 'UNKNOWN_TOOL', `Unsupported dom_agent action "${action}"`);
      }
    };

    run()
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse(
          makeError(-32603, 'INTERNAL_ERROR', String(err?.message ?? err)),
        ),
      );

    return true;
  });
})();
