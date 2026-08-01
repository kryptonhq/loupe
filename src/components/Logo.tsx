// The Krypton mark, shared with kryptonhq/runtime's operator UI —
// src/assets/logo.svg is a copy of ui/src/assets/logo.svg there, so
// Loupe and the in-cluster UI read as one family.
import logoUrl from "../assets/logo.svg";

export function Logo({ className }: { className?: string }) {
  return <img src={logoUrl} alt="Loupe" className={className} />;
}
