const COMMON_ACRONYMS = new Set([
  "ISO",
  "VAT",
  "TRN",
  "UAE",
  "CPR",
  "AED",
  "HSE",
  "OSHA",
  "HABC",
  "IOSH",
  "NEBOSH",
  "BLS",
  "LLC",
  "FZE",
  "FZCO",
  "PJSC",
  "ID",
  "PO",
  "P.O.",
]);

export function toTitleCase(str: string): string {
  if (!str) return "";
  const trimmed = str.trim();
  if (!trimmed) return "";

  return trimmed
    .split(/\s+/)
    .map((word) => {
      const core = word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
      if (COMMON_ACRONYMS.has(core.toUpperCase())) {
        return word.replace(new RegExp(core, "i"), core.toUpperCase());
      }
      if (word.includes("-")) {
        return word
          .split("-")
          .map((part) =>
            part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ""
          )
          .join("-");
      }
      if (word.includes("/")) {
        return word
          .split("/")
          .map((part) =>
            part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ""
          )
          .join("/");
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}
