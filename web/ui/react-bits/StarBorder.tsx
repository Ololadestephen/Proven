// Adapted from React Bits, David Haz, revision c83b5e7e026f003af33ff9ebc3d93afb5c86ad22.
// Source: src/content/Animations/StarBorder. License: ../../licenses/react-bits-LICENSE.md.
import type { ReactNode } from "react";
import "./StarBorder.css";
export function StarBorder({
  children,
  href,
  className = "",
}: {
  children: ReactNode;
  href: string;
  className?: string;
}) {
  return (
    <a href={href} className={`star-border-container ${className}`}>
      <span className="border-gradient-bottom" aria-hidden="true" />
      <span className="border-gradient-top" aria-hidden="true" />
      <span className="inner-content">{children}</span>
    </a>
  );
}
