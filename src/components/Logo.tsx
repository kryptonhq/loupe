// Loupe's own mark: a lens iris closing onto the hexagon Krypton's
// family uses, so the lineage is carried by the shape of the opening
// rather than by wearing the parent's badge.
//
// It used to be exactly that badge — a byte-for-byte copy of
// kryptonhq/runtime's ui/src/assets/logo.svg — which said which family
// the app belonged to and nothing about what it is. The lattice inside
// it was drawn at 1px, so it was grey haze by 32px and gone in a tab.
import logoUrl from "../assets/logo.svg";

export function Logo({ className }: { className?: string }) {
  return <img src={logoUrl} alt="Loupe" className={className} />;
}
