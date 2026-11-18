/**
 * Ref callback for the active link in a horizontally scrolling tab bar:
 * on narrow screens it brings the current tab into view without moving
 * the page vertically. Module-level so React only calls it on mount/change.
 */
export function scrollActiveTabIntoView(el: HTMLElement | null): void {
  el?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
