import type { DesktopNotice } from '@frequencia/shared';
import type { NoticeBridge } from './protocol';

declare global {
  interface Window {
    notice: NoticeBridge;
  }
}

/** How long a notice stays, as Steam's do; the pointer over it holds it. */
const SHOWN_MS = 5500;
/** Matches the exit transition in notice.html. */
const EXIT_MS = 180;

const card = document.querySelector<HTMLElement>('#card');
const picture = document.querySelector<HTMLElement>('#picture');
const title = document.querySelector<HTMLElement>('#title');
const text = document.querySelector<HTMLElement>('#text');
const action = document.querySelector<HTMLElement>('#action');

let timer: number | undefined;
let hovered = false;
let leaving = false;

function leave(): void {
  if (!card || leaving) return;
  leaving = true;
  window.clearTimeout(timer);
  card.dataset.state = 'out';
  window.setTimeout(() => window.notice.done(), EXIT_MS);
}

function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (!hovered) leave();
  }, SHOWN_MS);
}

function show(notice: DesktopNotice): void {
  if (!card || !picture || !title || !text || !action) return;
  leaving = false;
  title.textContent = notice.title;
  text.textContent = notice.text;
  action.textContent = notice.action ? `[ ${notice.action} ]` : '';
  action.hidden = notice.action === null;
  picture.replaceChildren();
  picture.textContent = notice.title.trim().charAt(0).toUpperCase();
  if (notice.picture) {
    const image = new Image();
    image.alt = '';
    image.addEventListener('load', () => picture.replaceChildren(image));
    image.src = notice.picture;
  }
  // From hidden, so the entrance plays again for each notice.
  card.dataset.state = 'out';
  void card.offsetWidth;
  card.dataset.state = 'in';
  schedule();
}

card?.addEventListener('click', () => {
  window.notice.click();
  leave();
});
card?.addEventListener('pointerenter', () => {
  hovered = true;
});
card?.addEventListener('pointerleave', () => {
  hovered = false;
  if (!leaving) schedule();
});

window.notice.onShow(show);
