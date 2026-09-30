const names = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region", fallback: "code" });
  } catch {
    return null;
  }
})();

/** A country's English name, from its ISO 3166-1 alpha-2 code. */
export function countryName(code: string) {
  if (code === "XK") return "Kosovo";
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The flag emoji, made of the code's two regional indicator symbols. Windows shows them as the letters. */
export const countryFlag = (code: string) =>
  /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";
