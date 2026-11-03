// Pick the theme a theme-toggle click switches to. It must flip the *resolved*
// theme: on the "system" setting the stored value is "system", so flipping that
// would yield "dark" again on a dark OS and the first click would do nothing.
export function nextTheme(resolved: string | undefined): "light" | "dark" {
  return resolved === "dark" ? "light" : "dark";
}
