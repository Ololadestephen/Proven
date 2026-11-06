// Adapted from React Bits, David Haz, revision c83b5e7e026f003af33ff9ebc3d93afb5c86ad22.
// Source: src/content/Components/SpotlightCard. License: ../../licenses/react-bits-LICENSE.md.
import { useRef, type ReactNode, type MouseEvent } from "react";
import "./SpotlightCard.css";

export function SpotlightCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const card = useRef<HTMLDivElement>(null);
  function move(event: MouseEvent<HTMLDivElement>) {
    if (
      !card.current ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const rect = card.current.getBoundingClientRect();
    card.current.style.setProperty(
      "--mouse-x",
      `${event.clientX - rect.left}px`,
    );
    card.current.style.setProperty(
      "--mouse-y",
      `${event.clientY - rect.top}px`,
    );
  }
  return (
    <div
      ref={card}
      onMouseMove={move}
      className={`card-spotlight ${className}`}
    >
      {children}
    </div>
  );
}
