/** Small DOM helpers. No framework: the UI is a handful of screens toggled with the `hidden` attribute. */

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

export type ScreenName = 'menu' | 'create' | 'join' | 'queue' | 'practice' | 'lobby' | 'game' | 'results';

export function showScreen(name: ScreenName, focus = true): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-screen]')) {
    el.hidden = el.dataset.screen !== name;
  }
  const changed = document.body.dataset.current !== name;
  document.body.dataset.current = name;
  if (changed) document.dispatchEvent(new CustomEvent('screenchange', { detail: name }));
  if (!focus) return;
  const active = document.querySelector<HTMLElement>(`[data-screen="${name}"]`);
  const heading = active?.querySelector<HTMLElement>('h1, h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

export function currentScreen(): ScreenName {
  return (document.body.dataset.current as ScreenName | undefined) ?? 'menu';
}

// ------------------------------------------------------------ overlays / modals

const lastFocus = new WeakMap<HTMLElement, HTMLElement | null>();

export function openOverlay(id: string): void {
  const el = $(id);
  if (!el.hidden) return;
  lastFocus.set(el, document.activeElement instanceof HTMLElement ? document.activeElement : null);
  el.hidden = false;
  const target = el.querySelector<HTMLElement>('[autofocus], .btn.primary, button, input, select');
  target?.focus({ preventScroll: true });
}

export function closeOverlay(id: string): void {
  const el = $(id);
  if (el.hidden) return;
  el.hidden = true;
  const back = lastFocus.get(el);
  if (back && document.contains(back) && !back.closest('[hidden]')) back.focus({ preventScroll: true });
}

export function isOverlayOpen(id: string): boolean {
  return !$(id).hidden;
}

/** Keep Tab inside whichever modal is open, and let Escape close dismissible ones. */
export function installModalKeys(dismissible: string[]): void {
  document.addEventListener('keydown', (e) => {
    const open = [
      ...document.querySelectorAll<HTMLElement>('.modal-overlay:not([hidden]), #overlay-pause:not([hidden])'),
    ].pop();
    if (!open) return;
    if (e.key === 'Escape' && dismissible.includes(open.id)) {
      e.preventDefault();
      closeOverlay(open.id);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [
      ...open.querySelectorAll<HTMLElement>(
        'button, input, select, a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

export function confirmDialog(text: string, yes = 'Yes'): Promise<boolean> {
  return new Promise((resolve) => {
    $('confirm-text').textContent = text;
    $('btn-confirm-yes').textContent = yes;
    const done = (v: boolean): void => {
      $('btn-confirm-yes').onclick = null;
      $('btn-confirm-no').onclick = null;
      closeOverlay('modal-confirm');
      resolve(v);
    };
    $('btn-confirm-yes').onclick = () => done(true);
    $('btn-confirm-no').onclick = () => done(false);
    openOverlay('modal-confirm');
    $('btn-confirm-no').focus();
  });
}

export function toast(text: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500): void {
  const inMatch = document.body.dataset.current === 'game';
  if (inMatch && kind !== 'error') return; // don't distract mid-battle with info toasts
  if (inMatch) {
    $('toasts').replaceChildren(); // at most one, and briefly
    ms = Math.min(ms, 2500);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? '' : kind}`.trim();
  el.textContent = text;
  $('toasts').append(el);
  window.setTimeout(() => el.remove(), ms);
  while ($('toasts').childElementCount > 4) $('toasts').firstElementChild?.remove();
}

/** Always build text with textContent (never innerHTML): player names are untrusted input from other users. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
