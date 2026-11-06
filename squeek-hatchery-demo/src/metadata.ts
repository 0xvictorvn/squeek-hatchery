// Trait list and metadata JSON. The same strings are downloaded, saved and minted.
import { portraitSVG } from "./art.ts";
import { ACCESSORIES, colorAlpha, type Session } from "./rules.ts";

export const NAME_RE =
  /^[A-Za-z0-9.,'-](?:[A-Za-z0-9 .,'-]{0,28}[A-Za-z0-9.,'-])?$/;
export const validName = (n: string) => NAME_RE.test(n);

export const DESCRIPTION =
  "A Squeek Hatchery test companion. Session attestation depends on the configured verifier; signatures alone do not prove play. The admin can upgrade the rules.";

export function buildTraits(s: Session): string {
  const pct = (v: number) => Math.round(v * 100);
  const coated = s.bands.filter((b) => colorAlpha(b.dose) > 0.1);
  const attrs: {
    trait_type: string;
    value: string | number;
    display_type?: string;
  }[] = [
    {
      trait_type: "Ears",
      value: pct(s.regions[0].growth),
      display_type: "boost_percentage",
    },
    {
      trait_type: "Fluff",
      value: pct(s.regions[1].growth),
      display_type: "boost_percentage",
    },
    {
      trait_type: "Lower coat and pom",
      value: pct(s.regions[2].growth),
      display_type: "boost_percentage",
    },
    { trait_type: "Accessory", value: ACCESSORIES[s.accessoryId] },
    { trait_type: "Accessory ID", value: s.accessoryId },
    { trait_type: "Accessory version", value: s.accessoryVersion },
    { trait_type: "Art version", value: 3 },
    {
      trait_type: "Coat coverage",
      value: Math.round((coated.length / s.bands.length) * 100),
      display_type: "boost_percentage",
    },
    { trait_type: "Lamp colors", value: s.colorsSeen.join(", ") || "none" },
    {
      trait_type: "Pearl coat",
      value: s.bands.some((b) => b.pearl * colorAlpha(b.dose) > 0.1)
        ? "Yes"
        : "No",
    },
    {
      trait_type: "Rainbow coat",
      value: s.bands.some((b) => b.rainbow * colorAlpha(b.dose) > 0.1)
        ? "Yes"
        : "No",
    },
    {
      trait_type: "Hatched (UTC)",
      value: (s.endedAt || "").slice(0, 10) || "unknown",
    },
  ];
  return JSON.stringify(attrs);
}

/** Same JSON shape the contract's tokenURI returns. */
export function metadataJSON(s: Session, name: string): string {
  const svg = portraitSVG(s);
  const image =
    "data:image/svg+xml;base64," +
    btoa(String.fromCharCode(...new TextEncoder().encode(svg)));
  return JSON.stringify(
    {
      name,
      description: DESCRIPTION,
      image,
      attributes: JSON.parse(buildTraits(s)),
    },
    null,
    2,
  );
}
